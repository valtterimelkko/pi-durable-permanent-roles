/**
 * "Needs you" items: the `raise_item` and `resolve_item` tools in the `notify` group (the line
 * format is versioned: a delegation always starts a new session, `tasks` carry the category, and
 * every new item line carries `"v":2`).
 *
 * `<stateDir>/needs-you.jsonl` is append-only, one JSON object per line, written only by the host and read by
 * the operator's tools. An item is open until a `resolved` line names it. The append is atomic per line: one `appendFile` of
 * a line under 4 KiB, so a crash cannot leave a half line behind; a longer item is refused before anything is
 * written.
 *
 * Replay safety mirrors notify's at-most-once send: the durable written mark lands BEFORE the file append, keyed
 * by conversation + tool call id. A replayed call reads its mark and returns the first response without touching
 * the file, so a replay never appends twice. A crash in the small window between mark and append loses the item
 * (never duplicates it — the operator's tools would show two cards); the role's notes still name it, and its next run
 * can raise it again.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { arr, obj, opt, str } from "@earendil-works/pi-schema";
import { defineDoc, defineTool, type Tx } from "@earendil-works/pi-durable";
import { idArg } from "./args.ts";
import { hostTimeZone } from "./host-time.ts";
import { baseEveryDeltas, LEDGER_BASE_DELTAS } from "./doc-checkpoint.ts";
import type { RoleDefinition } from "./types.ts";

/** The frozen bounds of the format. */
export const KINDS = ["problem", "suggestion", "flag", "reminder"] as const;
export type NeedsYouKind = (typeof KINDS)[number];
export const SUGGESTION_ACTIONS = ["delegate", "launch", "send-to-role"] as const;
export type SuggestionAction = (typeof SUGGESTION_ACTIONS)[number];
/** Format v2: a delegation always starts a new session; the role classifies each task, it never routes it. */
export const TASK_CATEGORIES = ["system", "messaging"] as const;
export type NeedsYouTaskCategory = (typeof TASK_CATEGORIES)[number];
export const TASKS_MAX = 20;
export const TASK_TEXT_MAX = 500;
export type NeedsYouTask = { category: NeedsYouTaskCategory; text: string };
export const TITLE_MAX = 120;
export const BODY_MAX = 2_000;
export const BRIEF_MAX = 4_000;
export const NOTE_MAX = 300;
/** A line plus its newline must stay under one 4 KiB block for the per-line atomic append. */
export const LINE_MAX_BYTES = 4_096;
export const NEEDS_YOU_FILENAME = "needs-you.jsonl";

/** Written marks are kept this long for replay de-duplication, then pruned when the next item is marked. */
const WRITE_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

/** The durable de-duplication record: every needs-you write this conversation has already made. */
export const NeedsYouWrites = defineDoc<{
	written: Record<string, { id: string; response: Record<string, string>; atMs: number }>;
}>({
	kind: "pi-roles.needs-you-writes",
	version: 1,
	scope: "session",
	initial: () => ({ written: {} }),
	// One write per needs-you tool call; marks are pruned after seven days, the deltas are not: a periodic base bounds
	// the replay.
	checkpointWhen: baseEveryDeltas(LEDGER_BASE_DELTAS),
});

export type RaiseItemSuggestion = {
	action: SuggestionAction;
	/** v2 `delegate` only: the whole task list, each classified; never a target session. */
	tasks?: NeedsYouTask[];
	brief?: string;
};

export type RaiseItemFields = {
	kind: NeedsYouKind;
	title: string;
	body: string;
	suggestion?: RaiseItemSuggestion;
	link?: string;
};

type RaiseItemArgs = {
	kind: string;
	title: string;
	body: string;
	suggestion?: { action: string; tasks?: unknown; brief?: string };
	link?: string;
};

type ResolveItemArgs = { id: string; note?: string };

const CONTROL_KEEPING_NL = /[^\P{C}\n]/gu;
const CONTROL_ALL = /[^\P{C}]/gu;

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string") throw new Error(`${field} is required`);
	return value;
}

/** Multi-line free text (body, brief, note): line breaks kept, other controls become spaces, capped by refusal. */
function multilineText(value: unknown, field: string, max: number): string {
	const cleaned = requiredString(value, field).replace(/\r/g, "").replace(CONTROL_KEEPING_NL, " ").trim();
	if (cleaned === "") throw new Error(`${field} is required`);
	if (cleaned.length > max) throw new Error(`${field} must be at most ${max} characters (got ${cleaned.length})`);
	return cleaned;
}

/** One-line free text (kind, action, target, title, link): controls collapse, capped by refusal. */
function oneLineText(value: unknown, field: string, max: number): string {
	const cleaned = requiredString(value, field).replace(CONTROL_ALL, " ").replace(/ {2,}/g, " ").trim();
	if (cleaned === "") throw new Error(`${field} is required`);
	if (cleaned.length > max) throw new Error(`${field} must be at most ${max} characters`);
	return cleaned;
}

/** One `tasks` entry: `{category, text}`, 1–20 of them, the whole list of one delegation. */
function validateTasks(value: unknown): NeedsYouTask[] {
	if (!Array.isArray(value)) throw new Error("tasks is required for delegate: 1–20 entries of {category, text}");
	if (value.length < 1 || value.length > TASKS_MAX) {
		throw new Error(`tasks must hold 1–${TASKS_MAX} entries (got ${value.length})`);
	}
	return value.map((entry, index) => {
		const n = index + 1;
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			throw new Error(`task ${n} must be an object with category and text`);
		}
		const raw = entry as Record<string, unknown>;
		const category = oneLineText(raw.category, `task ${n} category`, 40);
		if (!(TASK_CATEGORIES as readonly string[]).includes(category)) {
			throw new Error(`task ${n} category must be one of ${TASK_CATEGORIES.join("|")}`);
		}
		return { category: category as NeedsYouTaskCategory, text: oneLineText(raw.text, `task ${n} text`, TASK_TEXT_MAX) };
	});
}

/** Validate one `raise_item` call against the frozen format; throws with the refusal message. */
export function validateRaiseItem(args: RaiseItemArgs): RaiseItemFields {
	const kind = oneLineText(args.kind, "kind", 40);
	if (!(KINDS as readonly string[]).includes(kind)) {
		throw new Error(`kind must be one of ${KINDS.join("|")}`);
	}
	const fields: RaiseItemFields = {
		kind: kind as NeedsYouKind,
		title: oneLineText(args.title, "title", TITLE_MAX),
		body: multilineText(args.body, "body", BODY_MAX),
	};
	const raw = args.suggestion;
	if (raw !== undefined && raw !== null) {
		if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("suggestion must be an object");
		const candidate = raw as Record<string, unknown>;
		const action = oneLineText(candidate.action, "suggestion action", 40);
		if (!(SUGGESTION_ACTIONS as readonly string[]).includes(action)) {
			throw new Error(`suggestion action must be one of ${SUGGESTION_ACTIONS.join("|")}`);
		}
		const suggestion: RaiseItemSuggestion = { action: action as SuggestionAction };
		if (candidate.target !== undefined && candidate.target !== null) {
			if (action === "delegate") throw new Error("a delegation always starts a new session");
			throw new Error(`a ${action} suggestion has no target`);
		}
		if (action === "delegate") {
			suggestion.tasks = validateTasks(candidate.tasks);
		} else if (candidate.tasks !== undefined && candidate.tasks !== null) {
			throw new Error(`a ${action} suggestion takes no tasks`);
		}
		if (candidate.brief !== undefined && candidate.brief !== null) {
			suggestion.brief = multilineText(candidate.brief, "suggestion brief", BRIEF_MAX);
		}
		fields.suggestion = suggestion;
	}
	if (args.link !== undefined && args.link !== null) {
		fields.link = oneLineText(args.link, "link", 2_000);
	}
	return fields;
}

/** Validate the optional `resolve_item` note (empty when omitted). */
export function validateResolveNote(value: string | undefined): string {
	if (value === undefined || value === null) return "";
	return multilineText(value, "note", NOTE_MAX);
}

/** The host-zone clock, `yyyymmddThhmmss`: the stamp inside every item id. */
export function zoneStamp(nowMs: number): string {
	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone: hostTimeZone(),
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	}).formatToParts(new Date(nowMs));
	const value = (type: string): string => parts.find((part) => part.type === type)?.value ?? "00";
	const hour = value("hour") === "24" ? "00" : value("hour");
	return `${value("year")}${value("month")}${value("day")}T${hour}${value("minute")}${value("second")}`;
}

/** The item id: `<role>-<yyyymmddThhmmss>-<6 hex>` on the host-zone clock. */
export function needsYouId(
	role: string,
	nowMs: number,
	random: () => string = () => randomBytes(3).toString("hex"),
): string {
	return `${role}-${zoneStamp(nowMs)}-${random()}`;
}

/** The item line, with the frozen field order; every new line carries the format version. */
export function serialiseNeedsYouLine(fields: RaiseItemFields, role: RoleDefinition, id: string, nowMs: number): string {
	return JSON.stringify({
		type: "item",
		v: 2,
		id,
		ts: new Date(nowMs).toISOString(),
		role: role.name,
		boardName: role.settings.boardName,
		kind: fields.kind,
		title: fields.title,
		body: fields.body,
		...(fields.suggestion !== undefined ? { suggestion: fields.suggestion } : {}),
		...(fields.link !== undefined ? { link: fields.link } : {}),
	});
}

/** The resolved line. */
export function serialiseResolvedLine(id: string, note: string, nowMs: number): string {
	return JSON.stringify({ type: "resolved", id, ts: new Date(nowMs).toISOString(), by: "role", note });
}

export type NeedsYouFileState = { items: Map<string, { role: string }>; resolved: Set<string> };

/** Read the file tolerantly: junk lines and a missing file are skipped, never thrown. */
export function readNeedsYouFile(stateDir: string): NeedsYouFileState {
	const state: NeedsYouFileState = { items: new Map(), resolved: new Set() };
	let text: string;
	try {
		text = readFileSync(join(stateDir, NEEDS_YOU_FILENAME), "utf8");
	} catch {
		return state;
	}
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		try {
			const parsed = JSON.parse(line) as Record<string, unknown>;
			if (parsed.type === "item" && typeof parsed.id === "string") {
				state.items.set(parsed.id, { role: String(parsed.role ?? "") });
			} else if (parsed.type === "resolved" && typeof parsed.id === "string") {
				state.resolved.add(parsed.id);
			}
		} catch {
			// A corrupt line never fails the tools; readers skip it too.
		}
	}
	return state;
}

/** Every parsed line of the needs-you file, in order (corrupt lines skipped) — for tests and host-side reads. */
export function readNeedsYouLines(stateDir: string): Array<Record<string, unknown>> {
	let text: string;
	try {
		text = readFileSync(join(stateDir, NEEDS_YOU_FILENAME), "utf8");
	} catch {
		return [];
	}
	const out: Array<Record<string, unknown>> = [];
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		try {
			out.push(JSON.parse(line) as Record<string, unknown>);
		} catch {
			// skipped, like every other reader
		}
	}
	return out;
}

/**
 * The host raises an item itself (no role tool call): the report nudge's fallback card. Same id, line format and
 * atomic append as raise_item.
 */
export async function raiseHostItem(stateDir: string, role: RoleDefinition, fields: RaiseItemFields, nowMs: number = Date.now()): Promise<string> {
	const id = needsYouId(role.name, nowMs);
	await appendNeedsYouLine(stateDir, serialiseNeedsYouLine(fields, role, id, nowMs));
	return id;
}

/** Append one line atomically: one `appendFile` of a line under 4 KiB, into a file created 0600. */
export async function appendNeedsYouLine(stateDir: string, line: string): Promise<void> {
	if (Buffer.byteLength(line, "utf8") + 1 > LINE_MAX_BYTES) {
		throw new Error(
			`a ${NEEDS_YOU_FILENAME} line must stay under ${LINE_MAX_BYTES} bytes so each append stays atomic`,
		);
	}
	mkdirSync(stateDir, { recursive: true });
	await appendFile(join(stateDir, NEEDS_YOU_FILENAME), `${line}\n`, { mode: 0o600 });
}

/** Where needs-you.jsonl lives: the option, then the environment, then the production default. */
export function needsYouStateDir(options: { stateDir?: string }): string {
	return options.stateDir ?? process.env.STANDING_ROLES_STATE_DIR ?? "/var/lib/pi-roles";
}

function reply(body: Record<string, unknown>, isError = false) {
	return {
		output: [{ type: "text" as const, text: JSON.stringify(body) }],
		...(isError ? { isError: true } : {}),
	};
}

export type NeedsYouToolOptions = {
	/** Where needs-you.jsonl lives (the host's state dir); the plumbing passes it. */
	stateDir?: string;
	now?: () => number;
	/** The role whose conversation a tool call belongs to (the plumbing's HostApi). */
	roleForConversation?(conversationId: string): RoleDefinition | undefined;
};

/**
 * The two needs-you tools, registered by the `notify` extension next to `notify_owner`. Both refuse in a
 * conversation that is not a standing role, and both are replay-safe through the durable written mark.
 */
export function needsYouTools(options: NeedsYouToolOptions = {}) {
	const now = options.now ?? Date.now;
	const stateDir = () => needsYouStateDir(options);
	const roleFor = options.roleForConversation;

	const markWritten = (tx: Tx, key: string, id: string, response: Record<string, string>) =>
		tx.doc(NeedsYouWrites).then((doc) => {
			doc.written[key] = { id, response, atMs: now() };
			for (const [stale, mark] of Object.entries(doc.written)) {
				if (now() - mark.atMs > WRITE_RETENTION_MS) delete doc.written[stale];
			}
		});

	const raiseTool = defineTool({
		name: "raise_item",
		description:
			"Raise one item for the operator: something they should act on (kind: problem, suggestion, flag or reminder). The item becomes a card they can act on with one tap; your notification message summarises the items you raised. For work for other agents, suggest one delegation: the whole task list in one item, each task classified system or messaging — never a model or a session, a delegation always starts a new session and the coordination layer picks the model.",
		parameters: obj(
			{
				kind: str({ description: "problem | suggestion | flag | reminder" }),
				title: str({ description: "One line, at most 120 characters." }),
				body: str({
					description: "What is going on and what the owner should do; markdown, at most 2,000 characters.",
				}),
				suggestion: opt(
					obj(
						{
							action: str({ description: "delegate | launch | send-to-role" }),
							tasks: opt(
								arr(
									obj(
										{
											category: str({
												description: "system (system functions and coding) | messaging (email and messaging)",
											}),
											text: str({ description: "One task, at most 500 characters." }),
										},
										// Open like TypeBox's Type.Object was: an extra argument stays accepted.
										{ open: true },
									),
									{
										description:
											"The tasks to delegate: 1–20, the whole list in this one item. Required for delegate. Classify each task; never choose a model or a session — a delegation always starts a new session, and the coordination layer picks the model.",
										},
								),
							),
							brief: opt(
								str({
									description:
										"The launch brief, or the delegation's shared context for every task; at most 4,000 characters. The coordination layer adds the wait-for-the-operator opening itself.",
								}),
							),
						},
						{ open: true },
					),
				),
				link: opt(str({ description: "An optional path or URL with the detail." })),
			},
			// Open like TypeBox's Type.Object was: an extra argument from the model stays accepted.
			{ open: true },
		),
		replay: "safe",
		execute: async (args: RaiseItemArgs, api, context) => {
			const role = roleFor?.(String(api.conversationId));
			if (role === undefined) {
				return reply(
					{ status: "refused", message: "This conversation is not a standing role, so it has no needs-you items." },
					true,
				);
			}
			const key = `${String(api.conversationId)}:${api.callId}`;
			const seen = await api.snapshot(NeedsYouWrites, context);
			const previous = seen?.written[key];
			if (previous !== undefined) return reply(previous.response);
			let fields: RaiseItemFields;
			try {
				fields = validateRaiseItem(args);
			} catch (error) {
				return reply({ status: "refused", message: error instanceof Error ? error.message : String(error) }, true);
			}
			const id = needsYouId(role.name, now());
			const line = serialiseNeedsYouLine(fields, role, id, now());
			const bytes = Buffer.byteLength(line, "utf8") + 1;
			if (bytes > LINE_MAX_BYTES) {
				return reply(
					{
						status: "refused",
						message: `The item line would be ${bytes} bytes; a needs-you.jsonl line must stay under ${LINE_MAX_BYTES} bytes so each append stays atomic — shorten the body or the suggestion brief.`,
					},
					true,
				);
			}
			const response = { status: "raised", id, file: join(stateDir(), NEEDS_YOU_FILENAME) };
			// The durable mark lands BEFORE the append (like notify's sent mark before the send): a replay never appends twice.
			await api.commit((tx) => markWritten(tx, key, id, response), context);
			await appendNeedsYouLine(stateDir(), line);
			return reply(response);
		},
	});

	const resolveTool = defineTool({
		name: "resolve_item",
		description:
			"Resolve one of your own needs-you items when it stops being true: the operator acted on it, or the situation changed. Only items your role raised can be resolved.",
		parameters: obj(
			{
				id: str({ description: "The id raise_item returned." }),
				note: opt(
					str({ description: "Optional, at most 300 characters: how it stopped being true." }),
				),
			},
			// Open like TypeBox's Type.Object was: an extra argument from the model stays accepted.
			{ open: true },
		),
		replay: "safe",
		execute: async (args: ResolveItemArgs, api, context) => {
			const role = roleFor?.(String(api.conversationId));
			if (role === undefined) {
				return reply(
					{ status: "refused", message: "This conversation is not a standing role, so it has no needs-you items." },
					true,
				);
			}
			const key = `${String(api.conversationId)}:${api.callId}`;
			const seen = await api.snapshot(NeedsYouWrites, context);
			const previous = seen?.written[key];
			if (previous !== undefined) return reply(previous.response);
			let id: string;
			let note: string;
			try {
				id = idArg(args.id, "id");
				note = validateResolveNote(args.note);
			} catch (error) {
				return reply({ status: "refused", message: error instanceof Error ? error.message : String(error) }, true);
			}
			const state = readNeedsYouFile(stateDir());
			const item = state.items.get(id);
			if (item === undefined) {
				return reply({ status: "refused", message: `No needs-you item with id '${id}'.` }, true);
			}
			if (item.role !== role.name) {
				return reply(
					{ status: "refused", message: `Item '${id}' belongs to the role '${item.role}', not to you.` },
					true,
				);
			}
			if (state.resolved.has(id)) {
				return reply({ status: "already-resolved", id });
			}
			const response = { status: "resolved", id };
			// Same mark-before-append order as raise_item: a replayed resolve never appends twice.
			await api.commit((tx) => markWritten(tx, key, id, response), context);
			await appendNeedsYouLine(stateDir(), serialiseResolvedLine(id, note, now()));
			return reply(response);
		},
	});

	return [raiseTool, resolveTool];
}
