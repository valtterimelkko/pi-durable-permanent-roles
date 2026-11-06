/**
 * Pi Durable 1.5's reports (`HarnessOptions.onReport(report)`).
 *
 * One tagged `Report` arrives: `kind` says *what* happened and `error` rides inside. Four kinds mean "a role's work
 * has stopped and nothing will change by itself": a task that ended faulted (`task_faulted`), a task the crash
 * guard or a stopped host interrupted — it ends its run instead of parking, the 1.4 behaviour that kept a
 * conversation busy until `retryTask()` is gone (`task_interrupted`), a stored state that cannot be migrated
 * (`migration_failed`), and the whole session failing (`storage_failed`, was `session_failed`). Until this module
 * the host printed one line to the journal for all of them, so a role could stop working without the owner hearing.
 *
 * The rule here (thin code): the message goes out on the path the roles already use —
 * `src/notify.ts`: a `pi-roles.notify` task queued in the reporting task's own conversation, deduplicated by
 * the same key as `notify_owner` (conversation + title/body + the host-zone hour), which is durable and survives a
 * restart. `storage_failed` cannot use it (a failed Session rejects every commit), so it goes straight to the
 * installed sender (`currentOwnerNotifier()`), which production wires from the config.
 *
 * Nothing here may throw into the Harness or hold a turn: the callback logs the line it always logged, and delivers
 * fire-and-forget with its own catch. A delivery that fails falls back to the direct send — a lost ping must never be
 * worse than a one-line journal entry.
 */
import type { Context } from "@earendil-works/chord";
import type { ConversationId, Harness, Report } from "@earendil-works/pi-durable";
import {
	capNotifyBody,
	capNotifyTitle,
	currentOwnerNotifier,
	notifyInputFor,
	queueNotify,
	type NotifyInput,
} from "./notify.ts";

/** A message for the owner, with the conversation that carries it (absent for a session-wide report). */
export type ReportMessage = {
	conversationId?: ConversationId;
	title: string;
	body: string;
};

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The cap `notify_owner` applies, so a long error cannot build an unbounded message. */
function message(conversationId: ConversationId | undefined, title: string, body: string): ReportMessage {
	const capped = { title: capNotifyTitle(title), body: capNotifyBody(body) };
	return conversationId === undefined ? capped : { conversationId, ...capped };
}

/**
 * The owner-facing text of one report, or `undefined` for the reports the host only logs (`task_outdated`,
 * `task_error`, `extension_error`, `host_error`, `listener_error`). Never throws on a shape it did not expect: it
 * runs inside the Harness's callback.
 */
export function describeReport(
	report: Report,
	options: { roleOf?: (conversationId: ConversationId) => string | undefined } = {},
): ReportMessage | undefined {
	const roleOf = options.roleOf ?? (() => undefined);
	try {
		if (report.kind === "storage_failed") {
			return message(
				undefined,
				"[roles] the role host failed",
				[
					"The role host's Pi Durable session failed (a storage error) and closed itself: every role is stopped.",
					"The service exits non-zero so systemd restarts it; no role runs again until then.",
					"",
					`Error: ${errorText(report.error)}`,
				].join("\n"),
			);
		}
		if (report.kind !== "task_faulted" && report.kind !== "task_interrupted" && report.kind !== "migration_failed") {
			return undefined;
		}
		const { id, kind, conversationId } = report.task;
		const role = roleOf(conversationId);
		const suffix = role === undefined ? "" : ` (${role})`;
		const where = [
			`Role: ${role ?? "(not mapped to a role)"}`,
			`Task: ${kind} (id ${id})`,
			`Conversation: ${conversationId}`,
			`Extension: ${report.extension ?? "(installed by the host)"}`,
		].join("\n");
		if (report.kind === "task_interrupted") {
			const why =
				report.reason === "restart_limit"
					? `It was cut off ${report.restarts} times in a row without reaching a new checkpoint.`
					: "The host kept stopping while the model was answering, and no attempt was left.";
			const runAgain = `The work runs again at the role's next scheduled slot, or now with \`roles run ${role ?? "<role>"}\`.`;
			return message(
				conversationId,
				`[roles] run interrupted: ${kind}${suffix}`,
				[
					"The role's run ended without finishing: Pi Durable stopped its task after repeated crashes or host stops, so this slot's work will not complete by itself.",
					why,
					"",
					where,
					"",
					`Error: ${errorText(report.error)}`,
					"",
					runAgain,
				].join("\n"),
			);
		}
		if (report.kind === "task_faulted") {
			const why =
				report.reason === "restart_limit"
					? "Its abort handler was cut off repeatedly, so the task ended faulted."
					: "Its phase threw during this run.";
			return message(
				conversationId,
				`[roles] task faulted: ${kind}${suffix}`,
				[
					`A task ended faulted. ${why}`,
					"",
					where,
					"",
					`Error: ${errorText(report.error)}`,
					"",
					"The task's work is lost for this attempt; a replay-safe task runs again on its next run.",
				].join("\n"),
			);
		}
		return message(
			conversationId,
			`[roles] task migration failed: ${kind}${suffix}`,
			[
				"A task's stored state could not be migrated, so the task is blocked until the extension's registry changes.",
				"",
				where,
				"",
				`Error: ${errorText(report.error)}`,
				"",
				"That work does not run again until the definition is fixed; check the version the extension now ships.",
			].join("\n"),
		);
	} catch {
		return undefined;
	}
}

export type RoleHostReportOptions = {
	/** The open harness, or `undefined` while it is still opening (a report can arrive during open). */
	harness: () => Harness | undefined;
	context: Context;
	/** Override the durable path (tests); the default queues a notify task through the harness's own commit. */
	queue?: (conversationId: ConversationId, input: NotifyInput) => Promise<void>;
	/** Override the direct path (tests); the default uses notify.ts's installed sender. */
	send?: (title: string, body: string) => Promise<void>;
	/** Where lines go; the default is the host's journal (console.error). */
	log?: (line: string) => void;
	/** The role a conversation belongs to, for the message's "Role:" line. */
	roleOf?: (conversationId: ConversationId) => string | undefined;
	now?: () => number;
};

/**
 * The host's `onReport`: the journal line it always wrote, plus the owner notification for the report kinds that
 * mean a role has stopped. Never throws, never awaits — the Harness's caller is a commit or a scheduler pass.
 */
export type RoleHostReports = ((report: Report) => void) & {
	/** Deliver what was held while the harness was still opening; call once `Harness.open` has returned. */
	flush(): Promise<void>;
};

export function roleHostReports(options: RoleHostReportOptions): RoleHostReports {
	const now = options.now ?? Date.now;
	const log = options.log ?? ((line: string) => console.error(line));
	const send = options.send ?? (async (title: string, body: string) => await currentOwnerNotifier()?.(title, body));
	const queue =
		options.queue ??
		(async (conversationId: ConversationId, input: NotifyInput) => {
			const harness = options.harness();
			if (harness === undefined) throw new Error("the harness is not open yet");
			await harness.commit((tx) => queueNotify(tx, conversationId, input), options.context);
		});

	const safeLog = (line: string): void => {
		try {
			log(line);
		} catch {
			// A failing logger must not fail the harness either.
		}
	};

	// Pi Durable raises migration_failed INSIDE Harness.open: no harness handle exists yet and the production
	// Telegram sender is installed later (plumbing.start), so a direct send would silently do nothing. Hold those
	// reports and deliver them through the durable notify path as soon as the host is open (`flush`).
	const held: ReportMessage[] = [];

	async function deliver(message: ReportMessage): Promise<void> {
		if (message.conversationId === undefined) {
			await send(message.title, message.body);
			return;
		}
		if (options.harness() === undefined) {
			held.push(message);
			return;
		}
		try {
			await queue(message.conversationId, notifyInputFor(message.conversationId, message.title, message.body, now()));
		} catch (failure) {
			safeLog(`[roles] report not queued (${errorText(failure)}); sending it directly`);
			await send(message.title, message.body);
		}
	}

	const report = (report: Report): void => {
		safeLog(`[roles] pi-durable report: ${errorText(report.error)}`);
		const message = describeReport(report, { roleOf: options.roleOf });
		if (message === undefined) return;
		void deliver(message).catch((failure: unknown) => {
			safeLog(`[roles] report not delivered (${errorText(failure)})`);
		});
	};
	const flush = async (): Promise<void> => {
		const pending = held.splice(0);
		for (const message of pending) {
			try {
				await deliver(message);
			} catch (failure) {
				safeLog(`[roles] report not delivered (${errorText(failure)})`);
			}
		}
	};
	return Object.assign(report, { flush });
}
