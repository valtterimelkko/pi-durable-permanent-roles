/**
 * The mirror: a readable view of each role conversation, the operator's
 * read path (one transcript.jsonl and one status.json per role under the state directory). Follows the conversation (the minimum, as in the Phone Steward project's chat bridge:
 * watch the view, skip the history already on disk, append what arrives) and appends
 * {ts, kind: user|assistant|tool|compaction, text} lines to
 * `<state>/roles/<name>/transcript.jsonl`. Tool lines carry the tool name and a short,
 * capped argument/result summary. `status.json` ({role, title, enabled, busy, lastRunAt,
 * lastRunSlot, nextRunAt, model, boardName}) is rewritten on every change. The role's
 * notes folder is created at start.
 */
import { existsSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { AssistantEntry, CompactionEntry, ToolResultEntry, UserEntry, type Conversation, type Cursor, type EntryId, type EntryRecord } from "@earendil-works/pi-durable";
import type { RoleHost } from "./harness.ts";
import { nextRunAtMs } from "./schedules.ts";
import type { RoleDefinition } from "./types.ts";

export type MirrorLine = { ts: string; kind: "user" | "assistant" | "tool" | "compaction"; text: string };

export type RoleStatus = {
	role: string;
	title: string;
	enabled: boolean;
	busy: boolean;
	lastRunAt: string | null;
	lastRunSlot: string | null;
	nextRunAt: string | null;
	model: { provider: string; modelId: string } | undefined;
	boardName: string;
};

const TOOL_LINE_CAP = 300;

function textOf(entry: EntryRecord | undefined): string {
	const message = entry?.model?.[0];
	if (message === undefined) return "";
	const content = (message as { content?: string | Array<{ type: string; text?: string }> }).content;
	if (typeof content === "string") return content;
	return (content ?? []).flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("");
}

/** A short one-line summary of a tool call's arguments (name-level, capped). */
function argsSummary(name: string, entry: EntryRecord): string {
	const message = entry.model?.[0] as { content?: Array<{ type: string; name?: string; arguments?: unknown }> } | undefined;
	const call = message?.content?.find((part) => part.type === "toolCall");
	const args = call?.arguments;
	if (args === undefined || args === null) return "";
	try {
		return JSON.stringify(args).slice(0, TOOL_LINE_CAP);
	} catch {
		return "";
	}
}

function cap(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** What a role sends the owner: their tool lines keep the whole arguments, so a reader can audit a run. */
const FULL_ARGUMENT_TOOLS = new Set(["notify_owner", "raise_item"]);
/** A bound even for those: a raised item's body is capped at 2,000 characters by its own format. */
const FULL_ARGUMENT_CAP = 8_000;

/**
 * One tool line: `name: <arguments JSON> → <result>`. Most tools keep a short summary (arguments to 300 characters,
 * the line to 400); notify_owner and raise_item keep their arguments whole, so the owner's exact message is readable
 * in the transcript.
 */
export function toolLine(name: string, args: unknown, resultText: string): string {
	let json = "";
	try {
		json = args === undefined || args === null ? "" : JSON.stringify(args);
	} catch {
		json = "";
	}
	const result = cap(resultText, TOOL_LINE_CAP).replaceAll("\n", " ");
	if (FULL_ARGUMENT_TOOLS.has(name)) {
		const whole = json === "" ? "" : ` ${cap(json, FULL_ARGUMENT_CAP)}`;
		return `${name}:${whole} → ${result}`;
	}
	const short = json === "" ? "" : ` ${json.slice(0, TOOL_LINE_CAP)}`;
	return cap(`${name}:${short} → ${result}`, 400);
}

export type Mirror = {
	stop(): Promise<void>;
	/** The current in-memory status of a role (what status.json holds). */
	status(roleName: string): RoleStatus | undefined;
	/** All roles' current statuses, for the admin socket. */
	statuses(): Map<string, RoleStatus>;
};

export async function startMirror(options: {
	host: RoleHost;
	stateDir: string;
	now?: () => number;
	context?: Context;
}): Promise<Mirror> {
	const context = options.context ?? BACKGROUND_CONTEXT;
	const now = options.now ?? (() => Date.now());
	const stopped = { value: false };
	const statuses = new Map<string, RoleStatus>();
	const watches: Array<{ stop(): Promise<void> }> = [];

	const statusOf = async (role: RoleDefinition, conversation: Conversation, busy: boolean): Promise<RoleStatus> => {
		const agent = await conversation.agent(context);
		const lastRun = options.host.lastRun(role.name);
		const nextRun = nextRunAtMs(role, now());
		return {
			role: role.name,
			title: role.settings.title,
			enabled: true,
			busy,
			lastRunAt: lastRun === undefined ? null : new Date(lastRun.atMs).toISOString(),
			lastRunSlot: lastRun === undefined ? null : lastRun.slot,
			nextRunAt: nextRun === null ? null : new Date(nextRun).toISOString(),
			model: agent.model,
			boardName: role.settings.boardName,
		};
	};

	const writeStatus = (role: RoleDefinition, status: RoleStatus): void => {
		statuses.set(role.name, status);
		writeFileSync(join(options.stateDir, "roles", role.name, "status.json"), `${JSON.stringify(status, undefined, "\t")}\n`, "utf8");
	};

	const appendLine = (role: RoleDefinition, line: MirrorLine): void => {
		appendFileSync(join(options.stateDir, "roles", role.name, "transcript.jsonl"), `${JSON.stringify(line)}\n`, "utf8");
	};

	/**
	 * Page the durable record for the entries a 1.5 window dropped:
	 * ascending from `from` (undefined = the transcript's start, for an empty-attach first value) to `through`, so
	 * every entry is mirrored exactly once (the `seen` set drops what the window overlaps).
	 */
	const fillGap = async (
		conversation: Conversation,
		mirrorEntry: (entry: EntryRecord) => boolean,
		from: EntryId | undefined,
		through: EntryId,
	): Promise<boolean> => {
		let changed = false;
		let cursor: Cursor | undefined;
		for (;;) {
			const page = await conversation.entries(
				{ minEntryId: from, maxEntryId: through, order: "ascending" },
				200,
				cursor,
				context,
			);
			for (const entry of page.items) changed = mirrorEntry(entry) || changed;
			if (page.next === undefined) break;
			cursor = page.next;
		}
		return changed;
	};

	for (const role of options.host.roles()) {
		// The role's own working folder (S7) and the mirror's files.
		mkdirSync(role.notesDir, { recursive: true });
		mkdirSync(join(options.stateDir, "roles", role.name), { recursive: true });
		const conversation = await options.host.conversation(role.name);
		if (conversation === undefined) continue;
		// Initial status (idle) before anything arrives.
		writeStatus(role, await statusOf(role, conversation, false));
		const watch = await conversation.watch(context);
		// Skip the history: the durable record is SQLite; the mirror covers what happens now.
		const seen = new Set<string>(watch.value.entries.map((entry) => String(entry.id)));
		// The newest entry id mirrored so far: the anchor for the 1.5 window's gap fill (§B.2 item 5). When the
		// attach-time transcript was empty there is no anchor — remember that, so an anchor-less gap check may
		// page from the transcript start (otherwise a first value whose window starts past the
		// start loses its earlier entries silently). `before` defined at attach means pre-attach history exists,
		// which stays skipped.
		let newestSeen: EntryId | undefined = watch.value.entries.at(-1)?.id;
		const attachEmpty = watch.value.entries.length === 0 && watch.value.before === undefined;
		// Open tool calls by call id, so a result line can carry the argument summary.
		const calls = new Map<string, { name: string; args: unknown }>();
		const mirrorEntry = (entry: EntryRecord): boolean => {
			const id = String(entry.id);
			if (seen.has(id)) return false;
			seen.add(id);
			if (newestSeen === undefined || Number(entry.id) > Number(newestSeen)) newestSeen = entry.id;
			const ts = new Date(now()).toISOString();
			if (UserEntry.is(entry)) {
				appendLine(role, { ts, kind: "user", text: cap(textOf(entry), 8_000) });
				return true;
			}
			if (AssistantEntry.is(entry)) {
				const message = entry.model?.[0] as { content?: Array<{ type: string; text?: string; id?: string; name?: string; arguments?: unknown }> } | undefined;
				const text = (message?.content ?? []).flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("");
				if (text !== "") appendLine(role, { ts, kind: "assistant", text: cap(text, 8_000) });
				for (const part of message?.content ?? []) {
					if (part.type === "toolCall" && typeof part.id === "string") {
						calls.set(part.id, { name: part.name ?? "tool", args: part.arguments ?? {} });
					}
				}
				return true;
			}
			if (ToolResultEntry.is(entry)) {
				const message = entry.model?.[0] as { toolCallId?: string; toolName?: string } | undefined;
				const call: { name: string; args: unknown } | undefined =
					message?.toolCallId !== undefined ? calls.get(message.toolCallId) : undefined;
				if (message?.toolCallId !== undefined) calls.delete(message.toolCallId);
				appendLine(role, {
					ts,
					kind: "tool",
					text: toolLine(call?.name ?? message?.toolName ?? "tool", call?.args, textOf(entry)),
				});
				return true;
			}
			if (CompactionEntry.is(entry)) {
				appendLine(role, { ts, kind: "compaction", text: cap(textOf(entry), 8_000) });
				return true;
			}
			return false;
		};
		// Pi Durable 1.5 hands the listener one tagged call; only a value call carries a view.
		watch.start((call) => {
			if (call.kind !== "value") return Promise.resolve();
			if (stopped.value) return Promise.resolve();
			return (async () => {
				const view = call.value;
				let changed = false;
				// Gap fill (§B.2 item 5): the view's entries are a window (newest 50 at attach; past 100 the oldest
				// leave in one splice down to 50). When the window starts past the newest entry mirrored so far,
				// entries left unseen — page the missing range from the durable record before diffing the window.
				// Without an anchor (empty attach) the gap exists only when this value's window starts past the
				// transcript start (`before` defined), and the fill then pages from the start.
				const gapThrough = view.entries[0]?.id ?? view.before;
				const gapOpen =
					gapThrough !== undefined &&
					(newestSeen !== undefined
						? Number(gapThrough) > Number(newestSeen)
						: attachEmpty && view.before !== undefined);
				if (gapOpen) {
					changed = (await fillGap(conversation, mirrorEntry, newestSeen, gapThrough)) || changed;
				}
				for (const entry of view.entries) {
					changed = mirrorEntry(entry) || changed;
				}
				// busy from the live document: a run is present exactly while the conversation works.
				const live = view.docs["pi.live"] as { run?: unknown } | undefined;
				const busy = live?.run !== undefined;
				const previous = statuses.get(role.name);
				if (changed || previous?.busy !== busy) {
					writeStatus(role, await statusOf(role, conversation, busy));
				}
			})().catch(() => undefined);
		});
		watches.push({ stop: async () => void (await watch.stop()) });
	}

	return {
		stop: async () => {
			stopped.value = true;
			await Promise.all(watches.map((watch) => watch.stop()));
		},
		status: (roleName) => statuses.get(roleName),
		statuses: () => statuses,
	};
}

/** Create `<state>/roles/<name>/notes/` for every enabled role, at start. */
export function ensureRoleFolders(host: RoleHost): void {
	for (const role of host.roles()) {
		if (!existsSync(role.notesDir)) mkdirSync(role.notesDir, { recursive: true });
	}
}
