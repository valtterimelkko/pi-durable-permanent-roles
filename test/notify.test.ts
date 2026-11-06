/**
 * Owner notification: the at-most-once notify task and the `notify_owner` tool.
 *
 * One duplicated ping is worse than one lost in a crash window, so the durable mark lands BEFORE the sender is
 * called: a replay after a crash reads the mark and sends nothing. The tests below drive the real task phase through
 * a scripted durable store and never send for real (the sender is a recording fake, or a throwaway command).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationId, RunningTask, TaskRuntime, Tx } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import {
	BODY_MAX,
	capNotifyBody,
	capNotifyTitle,
	jsonlNotifier,
	NOTIFICATIONS_FILENAME,
	NotifyTask,
	notifyCommandSender,
	notifyDedupeKey,
	notifyInputFor,
	queueNotify,
	notifyTasksExtension,
	notifyExtension,
	RoleNotifications,
	setOwnerNotifier,
	TITLE_MAX,
	type NotifyInput,
} from "../src/notify.ts";
import { zoneDateHour } from "../src/host-time.ts";

// The dedupe-key hour tests pin a DST zone; the host default is UTC.
process.env.STANDING_ROLES_TIMEZONE = "Europe/London";

const conversation = 7 as ConversationId;

/** A scripted stand-in for the durable store behind one task invocation. */
type QueuedMark = { taskId: string; queuedAtMs: number };

function fakeRuntime(
	input: NotifyInput,
	options: { order?: string[]; queued?: Record<string, QueuedMark> } = {},
) {
	const doc: {
		sent: Record<string, { sentAtMs: number; title: string }>;
		queued: Record<string, QueuedMark>;
	} = { sent: {}, queued: { ...(options.queued ?? {}) } };
	const commits: unknown[] = [];
	const tx = { doc: async () => doc } as unknown as Tx;
	const runtime = {
		conversationId: conversation,
		signal: new AbortController().signal,
		snapshot: async () => doc,
		commit: async (change: (tx: Tx) => unknown) => {
			options.order?.push("commit");
			const result = await change(tx);
			commits.push(result);
			return result;
		},
	} as unknown as TaskRuntime<NotifyInput, { phase: "send" }, null, object>;
	const task = { input, state: { status: "running", phase: "send" } } as unknown as RunningTask<
		NotifyInput,
		{ phase: "send" },
		null
	>;
	return { runtime, task, doc, commits };
}

function scriptedSender(behaviour: { failBeforeSend?: boolean; failAfterSend?: boolean } = {}) {
	const sent: Array<{ title: string; body: string }> = [];
	const sender = async (title: string, body: string): Promise<void> => {
		if (behaviour.failBeforeSend === true) throw new Error("killed before the send landed");
		sent.push({ title, body });
		if (behaviour.failAfterSend === true) throw new Error("killed after the send, before the terminal commit");
	};
	return { sender, sent };
}

describe("dedupe key: conversation + title/body + zone date-hour", () => {
	it("is stable inside one zone hour and differs across hours, content or conversation", () => {
		const at = Date.UTC(2026, 9, 20, 9, 15); // 10:15 in the zone (BST)
		const base = notifyDedupeKey(conversation, "Run finished", "3 items", at);
		expect(notifyDedupeKey(conversation, "Run finished", "3 items", at + 60_000)).toBe(base);
		expect(notifyDedupeKey(conversation, "Run finished", "4 items", at)).not.toBe(base);
		expect(notifyDedupeKey(conversation, "Run failed", "3 items", at)).not.toBe(base);
		expect(notifyDedupeKey(8 as ConversationId, "Run finished", "3 items", at)).not.toBe(base);
		expect(base.startsWith(`notify:${conversation}:`)).toBe(true);
		expect(base.endsWith(zoneDateHour(at))).toBe(true);
	});

	it("uses the zone clock, not UTC, across the autumn change", () => {
		// 2026-10-25 00:15 UTC is still 01:15 BST in London; 01:15 UTC is 01:15 GMT.
		expect(zoneDateHour(Date.UTC(2026, 9, 24, 22, 15))).toBe("2026-10-24T23");
		expect(zoneDateHour(Date.UTC(2026, 9, 24, 23, 15))).toBe("2026-10-25T00");
		expect(zoneDateHour(Date.UTC(2026, 9, 25, 0, 59))).toBe("2026-10-25T01");
		expect(zoneDateHour(Date.UTC(2026, 9, 25, 1, 5))).toBe("2026-10-25T01");
	});
});

describe("caps", () => {
	it("caps the title at 120 characters and the body at 3,500", () => {
		expect(TITLE_MAX).toBe(120);
		expect(BODY_MAX).toBe(3_500);
		const title = capNotifyTitle("x".repeat(500));
		const body = capNotifyBody("y".repeat(5_000));
		expect(title.length).toBe(120);
		expect(body.length).toBe(3_500);
		expect(title.endsWith("…")).toBe(true);
		expect(capNotifyTitle("short")).toBe("short");
	});

	it("trims and refuses an empty title", () => {
		expect(capNotifyTitle("  padded  ")).toBe("padded");
		expect(() => capNotifyTitle("   ")).toThrow(/title/);
		expect(() => capNotifyBody("   ")).toThrow(/body/);
	});
});

describe("the notify task is at-most-once", () => {
	it("marks the key sent before calling the sender, then sends once", async () => {
		const input = notifyInputFor(conversation, "Run finished", "3 items", Date.UTC(2026, 9, 20, 9, 15));
		const order: string[] = [];
		const { sender, sent } = scriptedSender();
		const fake = fakeRuntime(input, { order });
		setOwnerNotifier(async (title, body) => {
			order.push("send");
			await sender(title, body);
		});
		await NotifyTask.definition.phases.send(fake.task, fake.runtime, undefined as never);

		expect(sent).toEqual([{ title: "Run finished", body: "3 items" }]);
		expect(fake.doc.sent[input.dedupeKey]).toBeDefined();
		expect(order).toEqual(["commit", "send", "commit"]); // mark, send, terminal
		setOwnerNotifier(undefined);
	});

	it("a replay after a crash once the mark is committed sends nothing more", async () => {
		const input = notifyInputFor(conversation, "Run finished", "3 items", Date.UTC(2026, 9, 20, 9, 15));
		const { sender, sent } = scriptedSender({ failAfterSend: true });
		setOwnerNotifier(sender);
		const fake = fakeRuntime(input);
		// First invocation: the mark is committed, the send happens, then the process "dies".
		await expect(NotifyTask.definition.phases.send(fake.task, fake.runtime, undefined as never)).rejects.toThrow(
			/before the terminal commit/,
		);
		expect(sent).toHaveLength(1);
		// Replay after restart: the committed mark is read and no second ping is sent.
		await NotifyTask.definition.phases.send(fake.task, fake.runtime, undefined as never);
		expect(sent).toHaveLength(1);
		setOwnerNotifier(undefined);
	});

	it("a crash between the mark and the send loses the ping and still never duplicates it", async () => {
		const input = notifyInputFor(conversation, "Run finished", "3 items", Date.UTC(2026, 9, 20, 9, 15));
		const { sender, sent } = scriptedSender({ failBeforeSend: true });
		setOwnerNotifier(sender);
		const fake = fakeRuntime(input);
		await expect(NotifyTask.definition.phases.send(fake.task, fake.runtime, undefined as never)).rejects.toThrow(
			/before the send/,
		);
		expect(sent).toHaveLength(0);
		expect(fake.doc.sent[input.dedupeKey]).toBeDefined();
		await NotifyTask.definition.phases.send(fake.task, fake.runtime, undefined as never);
		expect(sent).toHaveLength(0);
		setOwnerNotifier(undefined);
	});

	it("drops the key's queued entry once it is sent", async () => {
		const input = notifyInputFor(conversation, "Run finished", "3 items", Date.UTC(2026, 9, 20, 9, 15));
		const { sender } = scriptedSender();
		setOwnerNotifier(sender);
		const fake = fakeRuntime(input, { queued: { [input.dedupeKey]: { taskId: "7", queuedAtMs: Date.now() } } });
		await NotifyTask.definition.phases.send(fake.task, fake.runtime, undefined as never);
		expect(fake.doc.sent[input.dedupeKey]).toBeDefined();
		expect(fake.doc.queued[input.dedupeKey]).toBeUndefined();
		setOwnerNotifier(undefined);
	});

	it("drops the queued entry when the task is aborted before it sends", async () => {
		const input = notifyInputFor(conversation, "Run finished", "3 items", Date.UTC(2026, 9, 21, 9, 15));
		const fake = fakeRuntime(input, { queued: { [input.dedupeKey]: { taskId: "8", queuedAtMs: Date.now() } } });
		await NotifyTask.definition.abort(fake.task, fake.runtime, undefined as never);
		expect(fake.doc.queued[input.dedupeKey]).toBeUndefined();
	});

	it("prunes a queued entry that never sent, once it is past the retention window", async () => {
		const staleInput = notifyInputFor(conversation, "Old run", "1 item", Date.UTC(2026, 9, 1, 9, 15));
		const input = notifyInputFor(conversation, "Run finished", "3 items", Date.UTC(2026, 9, 21, 9, 15));
		const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1_000;
		const { sender } = scriptedSender();
		setOwnerNotifier(sender);
		const fake = fakeRuntime(input, {
			queued: {
				[staleInput.dedupeKey]: { taskId: "9", queuedAtMs: eightDaysAgo },
				[input.dedupeKey]: { taskId: "10", queuedAtMs: Date.now() },
			},
		});
		await NotifyTask.definition.phases.send(fake.task, fake.runtime, undefined as never);
		expect(fake.doc.queued[staleInput.dedupeKey]).toBeUndefined();
		expect(fake.doc.queued[input.dedupeKey]).toBeUndefined();
		setOwnerNotifier(undefined);
	});

	it("registers the task in an extension so a harness can run it", () => {
		expect(notifyTasksExtension.tasks?.map((task) => task.definition.name)).toContain("pi-roles.notify");
		expect(RoleNotifications.definition.kind).toBe("pi-roles.notifications");
	});
});

describe("queueing", () => {
	it("creates one background task per dedupe key, owned by the calling conversation", async () => {
		const doc = { sent: {}, queued: {} as Record<string, { taskId: string; queuedAtMs: number }> };
		const created: Array<{ input: NotifyInput; options: unknown }> = [];
		const tx = {
			doc: async () => doc,
			createTask: async (_task: unknown, input: NotifyInput, options: unknown) => {
				created.push({ input, options });
				return created.length;
			},
		} as unknown as Tx;
		const input = notifyInputFor(conversation, "Run finished", "3 items", Date.UTC(2026, 9, 20, 9, 15));
		await queueNotify(tx, conversation, input);
		await queueNotify(tx, conversation, input);
		expect(created).toHaveLength(1);
		expect(created[0].options).toEqual({
			ownership: { kind: "conversation" },
			conversationId: conversation,
			background: true,
		});
		expect(doc.queued[input.dedupeKey]).toMatchObject({ taskId: "1" });
		expect(doc.queued[input.dedupeKey].queuedAtMs).toBeGreaterThan(0);
	});
});

describe("the sender seam", () => {
	it("spawns the configured command with the title and the body, and closes stdin", async () => {
		const dir = mkdtempSync(join(tmpdir(), "notify-sender-"));
		const out = join(dir, "out.txt");
		const script = join(dir, "notify.sh");
		writeFileSync(
			script,
			`#!/bin/sh\nprintf 'arg:%s\\n' "$@" > "${out}"\nif read -r line; then printf 'stdin:%s\\n' "$line" >> "${out}"; else printf 'stdin-eof\\n' >> "${out}"; fi\n`,
			{ mode: 0o755 },
		);
		try {
			await notifyCommandSender(script)("Run finished", "3 items");
			expect(readFileSync(out, "utf8")).toBe(
				"arg:Run finished\narg:3 items\nstdin-eof\n",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("resolves quietly when the helper script is missing, because a lost ping must not fail a run", async () => {
		await expect(notifyCommandSender("/nonexistent/notify-helper.sh")("t", "b")).resolves.toBeUndefined();
	});

});

describe("the notify_owner tool", () => {
	it("queues one task per conversation + title/body + hour, and replays never queue a second", async () => {
		const nowMs = Date.UTC(2026, 9, 20, 9, 15);
		const extension = notifyExtension({ now: () => nowMs });
		const tool = extension.tools?.find((candidate) => candidate.name === "notify_owner");
		expect(tool).toBeDefined();
		const doc = { sent: {}, queued: {} as Record<string, { taskId: string; queuedAtMs: number }> };
		const created: NotifyInput[] = [];
		const tx = {
			doc: async () => doc,
			createTask: async (_task: unknown, input: NotifyInput) => {
				created.push(input);
				return created.length;
			},
		} as unknown as Tx;
		const api = {
			conversationId: conversation,
			commit: async (change: (tx: Tx) => unknown) => change(tx),
			snapshot: async () => doc,
		};
		const result = await tool!.execute({ title: "Run finished", body: "3 items" }, api as never, undefined as never);
		expect(result.isError).toBeUndefined();
		expect(created).toHaveLength(1);
		expect(created[0].dedupeKey).toContain(`notify:${conversation}:`);
		// The same call replayed in the same zone hour must not queue a second ping.
		await tool!.execute({ title: "Run finished", body: "3 items" }, api as never, undefined as never);
		expect(created).toHaveLength(1);
		// A different hour is a new ping.
		const laterExtension = notifyExtension({ now: () => nowMs + 3_600_000 });
		const laterTool = laterExtension.tools?.find((candidate) => candidate.name === "notify_owner");
		await laterTool!.execute({ title: "Run finished", body: "3 items" }, api as never, undefined as never);
		expect(created).toHaveLength(2);
	});

	it("refuses an empty title or body without queueing anything", async () => {
		const extension = notifyExtension({ now: () => Date.UTC(2026, 9, 20, 9, 15) });
		const tool = extension.tools?.find((candidate) => candidate.name === "notify_owner");
		const created: NotifyInput[] = [];
		const tx = {
			doc: async () => ({ sent: {}, queued: {} }),
			createTask: async (_task: unknown, input: NotifyInput) => {
				created.push(input);
				return 1;
			},
		} as unknown as Tx;
		const api = {
			conversationId: conversation,
			commit: async (change: (tx: Tx) => unknown) => change(tx),
			snapshot: async () => ({ sent: {}, queued: {} }),
		};
		const result = await tool!.execute({ title: "  ", body: "x" }, api as never, undefined as never);
		expect(result.isError).toBe(true);
		expect(created).toHaveLength(0);
	});
});
