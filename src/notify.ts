/**
 * Owner notification: the at-most-once notify task and the `notify_owner` tool.
 *
 * Delivery is at-most-once by design — one duplicated ping is worse than one lost in a crash window. The `send` phase
 * writes the dedupe key into the durable `sent` record BEFORE it calls the sender: a crash after the mark replays to
 * the already-sent branch and sends nothing. The same key also gates queueing, so a tool call replayed by Pi Durable
 * never queues a second ping.
 *
 * The sender is injected per process (src/main.ts wires it from the config): with STANDING_ROLES_NOTIFY_COMMAND set,
 * production spawns that program as `<command> <title> <body>` (detached, stdin closed — Pi Web UI's notify helper is
 * one example); without it, notifications append to `<stateDir>/notifications.jsonl`. Tests and disposable instances
 * inject a recording sender, so no test can send for real.
 */
import { spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { baseEveryDeltas, LEDGER_BASE_DELTAS } from "./doc-checkpoint.ts";
import { singleLine } from "./args.ts";
import { zoneDateHour } from "./host-time.ts";
import {
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	type ConversationId,
	type Extension,
	type Tx,
} from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import type { OwnerNotifier, RoleDefinition } from "./types.ts";
import { needsYouTools } from "./needs-you.ts";
import { reportRunTools } from "./run-report.ts";

/** The state-dir file the default sender appends to: `<stateDir>/notifications.jsonl`. */
export const NOTIFICATIONS_FILENAME = "notifications.jsonl";

export const TITLE_MAX = 120;
export const BODY_MAX = 3_500;

/** Sent marks are kept this long for de-duplication, then pruned when the next message is marked. */
const SENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export type NotifyInput = { dedupeKey: string; title: string; body: string };

type SentMark = { sentAtMs: number; title: string };
type QueuedMark = { taskId: string; queuedAtMs: number };

/**
 * The durable de-duplication record: every key already sent, and every key with a task queued. Both are pruned after
 * the retention window, so a long-lived role's document does not grow without bound.
 */
export const RoleNotifications = defineDoc<{
	sent: Record<string, SentMark>;
	queued: Record<string, QueuedMark>;
}>({
	kind: "pi-roles.notifications",
	version: 1,
	scope: "session",
	initial: () => ({ sent: {}, queued: {} }),
	// Two or three writes per send, keys pruned after seven days but never the deltas: a periodic base bounds them.
	checkpointWhen: baseEveryDeltas(LEDGER_BASE_DELTAS),
});

let activeSender: OwnerNotifier | undefined;

/** Set the process's owner-notification sender; `undefined` restores the no-op default (tests and disposables). */
export function setOwnerNotifier(next: OwnerNotifier | undefined): void {
	activeSender = next;
}

export function currentOwnerNotifier(): OwnerNotifier | undefined {
	return activeSender;
}

/** Shorten text to `max` characters, ending in an ellipsis when it was cut. */
function cap(text: string, max: number): string {
	const trimmed = text.trim();
	return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

export function capNotifyTitle(title: string): string {
	const capped = singleLine(title, TITLE_MAX);
	if (capped === "") throw new Error("title is required");
	return capped;
}

export function capNotifyBody(body: string): string {
	const capped = cap(body, BODY_MAX);
	if (capped === "") throw new Error("body is required");
	return capped;
}

/**
 * The dedupe key: the calling conversation, a hash of the title and body, and the current date-hour in the host's
 * time zone. The same message replayed inside the same hour is the same ping; a genuinely new hour is a new ping.
 */
export function notifyDedupeKey(conversationId: ConversationId, title: string, body: string, nowMs: number): string {
	const hash = createHash("sha256")
		.update(`${conversationId}\u0000${title}\u0000${body}`)
		.digest("hex")
		.slice(0, 12);
	return `notify:${conversationId}:${hash}:${zoneDateHour(nowMs)}`;
}

/** The task input for one message: caps applied here, so the task and the sender only ever see bounded text. */
export function notifyInputFor(
	conversationId: ConversationId,
	title: string,
	body: string,
	nowMs: number,
): NotifyInput {
	const cappedTitle = capNotifyTitle(title);
	const cappedBody = capNotifyBody(body);
	return {
		dedupeKey: notifyDedupeKey(conversationId, cappedTitle, cappedBody, nowMs),
		title: cappedTitle,
		body: cappedBody,
	};
}

/** Queue one notify task inside the caller's commit. Idempotent per dedupe key. */
export async function queueNotify(tx: Tx, conversationId: ConversationId, input: NotifyInput): Promise<void> {
	const doc = await tx.doc(RoleNotifications);
	if (doc.queued[input.dedupeKey] !== undefined) return;
	if (doc.sent[input.dedupeKey] !== undefined) return;
	const taskId = await tx.createTask(NotifyTask, input, {
		ownership: { kind: "conversation" },
		conversationId,
		background: true,
	});
	doc.queued[input.dedupeKey] = { taskId: `${taskId}`, queuedAtMs: Date.now() };
}

/** Forget a key's queued bookkeeping, and any queued key that never sent inside the retention window. */
function pruneQueued(doc: { queued: Record<string, QueuedMark> }, now: number): void {
	for (const [key, mark] of Object.entries(doc.queued)) {
		if (now - mark.queuedAtMs > SENT_RETENTION_MS) delete doc.queued[key];
	}
}

type NotifyPhase = { phase: "send" };

/**
 * The send phase: mark durably, then send. A crash between the two loses the ping and never duplicates it; a crash
 * after the send replays into the already-sent branch, so the owner still sees one message.
 */
export const NotifyTask = defineTask<NotifyInput, NotifyPhase, null>({
	name: "pi-roles.notify",
	version: 1,
	initial: () => ({ phase: "send" }),
	phases: {
		send: async (task, runtime, context) => {
			const { dedupeKey, title, body } = task.input;
			const seen = await runtime.snapshot(RoleNotifications, context);
			if (seen?.sent[dedupeKey] !== undefined) {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
				return;
			}
			// The durable mark lands BEFORE the send. Returning nothing leaves the phase checkpoint unchanged, so the
			// phase is not re-entered by this commit.
			await runtime.commit(
				async (tx) => {
					const doc = await tx.doc(RoleNotifications);
					const now = Date.now();
					doc.sent[dedupeKey] = { sentAtMs: now, title };
					// The message is out, so its queued bookkeeping is done: keeping it would grow the document for ever
					// (every hour in the host's zone is a new key).
					delete doc.queued[dedupeKey];
					for (const [key, mark] of Object.entries(doc.sent)) {
						if (now - mark.sentAtMs > SENT_RETENTION_MS) delete doc.sent[key];
					}
					pruneQueued(doc, now);
					return undefined;
				},
				context,
			);
			const deliver = activeSender;
			if (deliver !== undefined) await deliver(title, body);
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
		},
	},
	abort: async (task, runtime, context) => {
		// An aborted task never sends, so its queued entry must not linger as a duplicate guard.
		await runtime.commit(
			async (tx) => {
				const doc = await tx.doc(RoleNotifications);
				delete doc.queued[task.input.dedupeKey];
				pruneQueued(doc, Date.now());
				return { status: "terminal", outcome: { status: "aborted" } };
			},
			context,
		);
	},
});

/** The task definition, installed once in the harness registry. */
export const notifyTasksExtension: Extension = defineExtension({
	name: "pi-roles-notify-tasks",
	tasks: [NotifyTask],
});

/**
 * The command sender: the configured program runs as `<command> <title> <body>`, detached from the agent's tools,
 * stdin closed (a helper that waits for a body would hang on an inherited stdin). Failures are logged, never thrown:
 * a lost ping must not fail a run.
 */
export function notifyCommandSender(command: string): OwnerNotifier {
	return (title, body) =>
		new Promise<void>((resolve) => {
			const child = spawn(command, [title, body], {
				stdio: ["ignore", "ignore", "ignore"],
				detached: true,
			});
			child.on("error", (error) => {
				console.error(`[pi-roles] notify failed: ${String(error)}`);
				resolve();
			});
			child.on("close", () => resolve());
		});
}

/** One JSONL notification record. */
export type NotificationRecord = { at: string; title: string; body: string };

/**
 * The default sender: append one JSON line to `<stateDir>/notifications.jsonl`. No external system, nothing sent
 * anywhere — an adopter reads or tails the file. Failures are logged, never thrown.
 */
export function jsonlNotifier(stateDir: string): OwnerNotifier {
	return async (title, body) => {
		try {
			await mkdir(stateDir, { recursive: true });
			const record: NotificationRecord = { at: new Date().toISOString(), title, body };
			await appendFile(join(stateDir, NOTIFICATIONS_FILENAME), `${JSON.stringify(record)}\n`, "utf8");
		} catch (error) {
			console.error(`[pi-roles] notify (file) failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	};
}

function reply(body: Record<string, unknown>, isError = false) {
	return {
		output: [{ type: "text" as const, text: JSON.stringify(body) }],
		...(isError ? { isError: true } : {}),
	};
}

/**
 * The `notify` extension: `notify_owner(title, body)` queues one message to the owner through the durable task, and
 * the needs-you tools (`raise_item`, `resolve_item`, defined in needs-you.ts) append to the state dir's
 * needs-you.jsonl. Caps and the dedupe keys are applied before queueing, so every tool is safe to call again in a
 * replay.
 */
export function notifyExtension(
	options: {
		now?: () => number;
		/** Where needs-you.jsonl lives (the host's state dir); the plumbing passes it for the needs-you tools. */
		stateDir?: string;
		/** The role whose conversation a tool call belongs to; shared with the integrations extension. */
		roleForConversation?: (conversationId: string) => RoleDefinition | undefined;
		/** The slot of the role's current run (the HostApi); report_run tags its record with it. */
		currentSlot?: (roleName: string) => string | undefined;
	} = {},
): Extension {
	const now = options.now ?? Date.now;
	return defineExtension({
		name: "pi-roles-notify",
		tools: [
			defineTool({
				name: "notify_owner",
				description:
					"Send the owner one message (title, then body). Use it once per run with your items, or immediately for something that cannot wait. The same message is never sent twice within the same hour.",
				parameters: obj(
					{
						title: str(),
						body: str(),
					},
					// Open like TypeBox's Type.Object was: an extra argument from the model stays accepted.
					{ open: true },
				),
				replay: "safe",
				execute: async (args: { title: string; body: string }, api, context) => {
					let input: NotifyInput;
					try {
						input = notifyInputFor(api.conversationId, args.title, args.body, now());
					} catch (error) {
						return reply({ status: "refused", message: error instanceof Error ? error.message : String(error) }, true);
					}
					const existing = await api.snapshot(RoleNotifications, context);
					if (existing?.queued[input.dedupeKey] !== undefined || existing?.sent[input.dedupeKey] !== undefined) {
						return reply({ status: "duplicate", message: "This message has already been sent (or is queued)." });
					}
					await api.commit((tx) => queueNotify(tx, api.conversationId, input), context);
					return reply({ status: "queued", title: input.title });
				},
			}),
			...needsYouTools({
				stateDir: options.stateDir,
				now,
				roleForConversation: options.roleForConversation,
			}),
			...reportRunTools({
				stateDir: options.stateDir,
				now,
				roleForConversation: options.roleForConversation,
				currentSlot: options.currentSlot,
			}),
		],
	});
}
