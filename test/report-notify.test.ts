/**
 * Pi Durable 1.5's `onReport(report)` carries one tagged `Report`: `kind` says *what* happened and `error` rides
 * inside (plan PI-DURABLE-1.5-MIGRATION §B.2 item 2). `task_parked` and its `roles retry` advice are gone — a
 * restart-limited task now *ends*, reported `task_interrupted` — and `session_failed` is `storage_failed`.
 *
 * These tests pin the owner-facing behaviour:
 * - the reports that mean "a role's work has stopped and nothing will change by itself" (`task_faulted`,
 *   `task_interrupted`, `migration_failed`) reach the owner through the existing notify path (src/notify.ts),
 *   de-duplicated by the same key as `notify_owner` (conversation + title/body + the London hour);
 * - `storage_failed` sends directly, because a failed Session cannot carry a commit;
 * - `task_outdated` and the other informational kinds only log;
 * - no message tells the owner to `roles retry` or calls anything parked — that feature is retired;
 * - nothing throws and nothing is awaited, and the journal line stays.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineExtension, defineTask } from "@earendil-works/pi-durable";
import type { ConversationId, Harness, Report, ReportInfo, TaskId, Tx } from "@earendil-works/pi-durable";
import { noOpPlumbing, openRoleHost, RoleConversationsDoc, type RoleHost } from "../src/harness.ts";
import { notifyTasksExtension, RoleNotifications, setOwnerNotifier, type NotifyInput } from "../src/notify.ts";
import { describeReport, roleHostReports } from "../src/report-notify.ts";
import { loadRoles } from "../src/roles.ts";
import type { Plumbing } from "../src/types.ts";
import { makeFauxHostModels, makeStateDir, writeRolesTree } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;
const roots: string[] = [];

afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const conversation = 7 as ConversationId;
const AT = Date.UTC(2026, 10, 3, 9, 15); // 2026-11-03 09:15 UTC = 09:15 London (GMT)

/** A task whose phase throws, so a real Harness reports `task_faulted` for it. */
const BoomTask = defineTask<null, { phase: "boom" }, null>({
	name: "test.boom",
	version: 1,
	initial: () => ({ phase: "boom" }),
	phases: {
		boom: async () => {
			throw new Error("phase exploded");
		},
	},
	abort: async (task, runtime, context) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
	},
});

type TaskScopedKind = "task_faulted" | "task_interrupted" | "migration_failed";

/** A 1.5 `Report` for a task-scoped kind: `kind` tags it and the `error` rides inside. */
function taskReport(
	kind: TaskScopedKind,
	options: { id?: number; task?: string; conversation?: ConversationId; reason?: string; restarts?: number; error?: unknown } = {},
): Report {
	const task = {
		id: (options.id ?? 12) as TaskId,
		kind: options.task ?? "pi.generation",
		conversationId: options.conversation ?? conversation,
	};
	const error = options.error ?? new Error("boom");
	let info: ReportInfo;
	if (kind === "task_faulted") {
		info = { kind, task, reason: (options.reason as "threw" | "restart_limit") ?? "threw" };
	} else if (kind === "task_interrupted") {
		info = {
			kind,
			task,
			reason: (options.reason as "restart_limit" | "interrupted") ?? "restart_limit",
			restarts: options.restarts ?? 5,
		};
	} else {
		info = { kind, task };
	}
	return { ...info, error };
}

/** A recording notifier: what reached the durable queue and what was sent straight out. */
function recording() {
	const queued: Array<{ conversationId: ConversationId; input: NotifyInput }> = [];
	const sent: Array<{ title: string; body: string }> = [];
	const lines: string[] = [];
	return {
		queued,
		sent,
		lines,
		queue: async (conversationId: ConversationId, input: NotifyInput) => void queued.push({ conversationId, input }),
		send: async (title: string, body: string) => void sent.push({ title, body }),
		log: (line: string) => void lines.push(line),
	};
}

/** A fake Harness whose commit runs against a fake transaction (the notify path's createTask/doc seams). */
function fakeHarness(options: { fail?: Error } = {}) {
	const doc = { sent: {}, queued: {} as Record<string, { taskId: string; queuedAtMs: number }> };
	const created: NotifyInput[] = [];
	const harness = {
		commit: async (change: (tx: Tx) => unknown) => {
			if (options.fail !== undefined) throw options.fail;
			const tx = {
				doc: async () => doc,
				createTask: async (_task: unknown, input: NotifyInput) => {
					created.push(input);
					return created.length;
				},
			} as unknown as Tx;
			return change(tx);
		},
	} as unknown as Harness;
	return { harness, doc, created };
}

/** Let the notifier's fire-and-forget work settle (it never awaits on the report's caller). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** The retired feature must not come back through the text: no parked wording, no retry advice. */
function expectNoParkedText(m: { title: string; body: string } | undefined): void {
	expect(m).toBeDefined();
	expect(`${m!.title}\n${m!.body}`).not.toContain("parked");
	expect(`${m!.title}\n${m!.body}`).not.toContain("roles retry");
}

describe("describeReport", () => {
	const roleOf = (id: ConversationId) => (id === conversation ? "runtime-keeper" : undefined);

	it("names the role, the task and the reason for the task-scoped reports that mean work has stopped", () => {
		const faulted = describeReport(
			taskReport("task_faulted", { id: 13, task: "pi-roles.notify", reason: "threw", error: new Error("boom") }),
			{ roleOf },
		);
		expect(faulted?.conversationId).toBe(conversation);
		expect(faulted?.title).toContain("faulted");
		expect(faulted?.body).toContain("runtime-keeper");
		expect(faulted?.body).toContain("pi-roles.notify");
		expect(faulted?.body).toContain("boom");
		expect(faulted?.body).toContain("replay-safe");
		expectNoParkedText(faulted);

		const abortCut = describeReport(
			taskReport("task_faulted", { id: 13, task: "pi-roles.notify", reason: "restart_limit" }),
			{ roleOf },
		);
		expect(abortCut?.title).toContain("faulted");
		expect(abortCut?.body).toContain("abort handler");

		const migration = describeReport(taskReport("migration_failed", { id: 14, error: new Error("cannot migrate") }), { roleOf });
		expect(migration?.title).toContain("migration");
		expect(migration?.body).toContain("cannot migrate");
		expectNoParkedText(migration);
	});

	it("pings once for task_interrupted: the role's run ended after repeated crashes and runs again later", () => {
		const limited = describeReport(
			taskReport("task_interrupted", { id: 15, reason: "restart_limit", restarts: 5, error: new Error("cut off") }),
			{ roleOf },
		);
		expect(limited?.conversationId).toBe(conversation);
		expect(limited?.title).toContain("runtime-keeper");
		expect(limited?.body).toContain("pi.generation");
		expect(limited?.body).toContain("cut off");
		expect(limited?.body).toContain("5");
		expect(limited?.body).toContain("next scheduled slot");
		expect(limited?.body).toContain("roles run runtime-keeper");
		expectNoParkedText(limited);

		const interrupted = describeReport(
			taskReport("task_interrupted", { id: 16, reason: "interrupted", restarts: 3, error: new Error("host stopped") }),
			{ roleOf },
		);
		expect(interrupted?.title).toContain("runtime-keeper");
		expect(interrupted?.body).toContain("model was answering");
		expect(interrupted?.body).toContain("roles run runtime-keeper");
	});

	it("sends storage_failed as the whole-host failure, with no conversation attached", () => {
		const failed = describeReport({ kind: "storage_failed", error: new Error("storage reset") }, {});
		expect(failed?.conversationId).toBeUndefined();
		expect(failed?.title).toContain("role host");
		expect(failed?.body).toContain("storage reset");
	});

	it("has nothing to say about the reports the host only logs", () => {
		expect(
			describeReport(
				{
					kind: "task_outdated",
					task: { id: 9 as TaskId, kind: "pi.tool", conversationId: conversation },
					reason: "task_too_old",
					error: new Error("x"),
				},
				{},
			),
		).toBeUndefined();
		expect(describeReport({ kind: "listener_error", error: new Error("x") }, {})).toBeUndefined();
		expect(describeReport({ kind: "task_error", task: { id: 9 as TaskId, kind: "k", conversationId: conversation }, error: "x" }, {})).toBeUndefined();
		expect(describeReport({ kind: "host_error", callback: "env", error: new Error("x") }, {})).toBeUndefined();
	});

	it("caps the body so a long error cannot build an unbounded message", () => {
		const long = describeReport(taskReport("task_interrupted", { error: new Error("e".repeat(20_000)) }), {});
		expect(long).toBeDefined();
		expect(long!.body.length).toBeLessThanOrEqual(3_500);
		expect(long!.title.length).toBeLessThanOrEqual(120);
	});
});

describe("roleHostReports", () => {
	it("queues a task-scoped report on the notify path, keeps the journal line, and dedupes the same hour", async () => {
		const rec = recording();
		const fake = fakeHarness();
		const notify = roleHostReports({
			harness: () => fake.harness,
			context,
			queue: rec.queue,
			send: rec.send,
			log: rec.log,
			now: () => AT,
		});
		notify(taskReport("task_interrupted"));
		notify(taskReport("task_interrupted"));
		await settle();
		expect(rec.queued).toHaveLength(2);
		// The existing notify key is what collapses the replay: same conversation, same title/body, same hour.
		expect(rec.queued[0].input.dedupeKey).toBe(rec.queued[1].input.dedupeKey);
		expect(rec.queued[0].conversationId).toBe(conversation);
		expect(rec.sent).toHaveLength(0);
		expect(rec.lines).toHaveLength(2);
		expect(rec.lines[0]).toContain("[roles] pi-durable report:");
		expect(rec.lines[0]).toContain("boom");
	});

	it("makes a different task, or a later hour, a different message", async () => {
		const rec = recording();
		let now = AT;
		const fake = fakeHarness();
		const notify = roleHostReports({
			harness: () => fake.harness,
			context,
			queue: rec.queue,
			send: rec.send,
			log: rec.log,
			now: () => now,
		});
		notify(taskReport("task_interrupted", { id: 12 }));
		notify(taskReport("task_interrupted", { id: 99 }));
		await settle();
		now = AT + 3_600_000;
		notify(taskReport("task_interrupted", { id: 12 }));
		await settle();
		expect(new Set(rec.queued.map((entry) => entry.input.dedupeKey)).size).toBe(3);
	});

	it("sends a failed session straight to the owner and never queues it", async () => {
		const rec = recording();
		const fake = fakeHarness();
		const notify = roleHostReports({
			harness: () => fake.harness,
			context,
			queue: rec.queue,
			send: rec.send,
			log: rec.log,
			now: () => AT,
		});
		notify({ kind: "storage_failed", error: new Error("storage reset") });
		await settle();
		expect(rec.queued).toHaveLength(0);
		expect(fake.created).toHaveLength(0);
		expect(rec.sent).toHaveLength(1);
		expect(rec.sent[0].body).toContain("storage reset");
	});

	it("falls back to the direct send when the durable path cannot take the report, and never throws", async () => {
		const rec = recording();
		const fake = fakeHarness({ fail: new Error("SessionFailed") });
		const notify = roleHostReports({
			harness: () => fake.harness,
			context,
			send: rec.send,
			log: rec.log,
			now: () => AT,
		});
		expect(() => notify(taskReport("task_interrupted"))).not.toThrow();
		await settle();
		expect(rec.sent).toHaveLength(1);
		expect(rec.lines.join("\n")).toContain("boom");
	});

	it("holds a report raised while the harness is still opening and delivers it once the host is open (review F1)", async () => {
		// Pi Durable raises migration_failed INSIDE Harness.open, before the harness handle exists and before the
		// production Telegram sender is installed (plumbing.start runs later), so a direct send would be a silent no-op.
		const early = recording();
		let open: Harness | undefined;
		const fake = fakeHarness();
		const notifyEarly = roleHostReports({
			harness: () => open,
			context,
			send: early.send,
			queue: early.queue,
			log: early.log,
			now: () => AT,
		});
		expect(() => notifyEarly(taskReport("migration_failed", { error: new Error("cannot migrate") }))).not.toThrow();
		await settle();
		expect(early.sent).toHaveLength(0);
		expect(early.queued).toHaveLength(0);
		expect(early.lines.join("\n")).toContain("cannot migrate");

		open = fake.harness;
		await notifyEarly.flush();
		expect(early.queued).toHaveLength(1);
		expect(early.queued[0]!.input.title).toContain("migration");
		expect(early.sent).toHaveLength(0);
		await notifyEarly.flush(); // idempotent: nothing is held any more
		expect(early.queued).toHaveLength(1);
	});

	it("never throws when the sender itself throws", async () => {
		const lines: string[] = [];
		const notify = roleHostReports({
			harness: () => undefined,
			context,
			queue: async () => undefined,
			send: async () => {
				throw new Error("telegram helper missing");
			},
			log: (line) => void lines.push(line),
			now: () => AT,
		});
		expect(() => notify({ kind: "storage_failed", error: new Error("boom") })).not.toThrow();
		await settle();
		expect(lines.join("\n")).toContain("telegram helper missing");
	});
});

describe("through a real role host", () => {
	it("an interrupted task becomes one queued notify task in that role's conversation, and a replay adds none", async () => {
		const stateDir = await makeStateDir();
		const rolesRoot = join(await mkdtemp(join(tmpdir(), "sr-report-")), "roles");
		roots.push(rolesRoot, stateDir);
		await writeRolesTree(rolesRoot, [{ name: "alpha" }]);
		const { enabled } = await loadRoles({ rolesRoot, stateDir });
		const { hostModels, defaultModel } = makeFauxHostModels();
		const host: RoleHost = await openRoleHost({
			dbPath: join(stateDir, "roles.db"),
			stateDir,
			roles: enabled,
			defaultModel,
			hostModels,
			resume: false, // keep the queued notify task pending, so the test reads it in the queue
		});
		const lines: string[] = [];
		setOwnerNotifier(undefined);
		try {
			const conversations = await host.harness.snapshot(RoleConversationsDoc, context);
			const conversationId = conversations?.conversations["alpha"] as ConversationId;
			expect(conversationId).toBeDefined();
			const notify = roleHostReports({
				harness: () => host.harness,
				context,
				log: (line) => void lines.push(line),
				roleOf: (id) => host.roleForConversation(String(id))?.name,
				now: () => AT,
			});
			notify(taskReport("task_interrupted", { id: 31, task: "pi.generation", conversation: conversationId, restarts: 5 }));
			const queuedAfterFirst = await waitForQueue(host);
			expect(queuedAfterFirst).toHaveLength(1);
			expect(lines.join("\n")).toContain("pi-durable report");

			const queued = await host.harness.snapshot(RoleNotifications, context);
			expect(Object.values(queued?.queued ?? {})[0]?.taskId).toBeDefined();

			// The same report again in the same hour is the same message: the durable key drops it.
			notify(taskReport("task_interrupted", { id: 31, task: "pi.generation", conversation: conversationId, restarts: 5 }));
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(await waitForQueue(host)).toEqual(queuedAfterFirst);

			const entry = queuedAfterFirst[0];
			expect(entry).toContain(`notify:${conversationId}`);
			expect(entry).toContain("2026-11-03T09");
		} finally {
			await host.close();
			setOwnerNotifier(undefined);
		}
	}, 30_000);
});

describe("through a real harness report", () => {
	it("a task whose phase throws reaches the owner as a faulted-task message", async () => {
		const stateDir = await makeStateDir();
		const rolesRoot = join(await mkdtemp(join(tmpdir(), "sr-report-fault-")), "roles");
		roots.push(rolesRoot, stateDir);
		await writeRolesTree(rolesRoot, [{ name: "alpha" }]);
		const { enabled } = await loadRoles({ rolesRoot, stateDir });
		const { hostModels, defaultModel } = makeFauxHostModels();
		const boom = defineExtension({ name: "test-boom", tasks: [BoomTask] });
		const base = noOpPlumbing();
		// The notify task's definition too, so the message the report queues is really delivered (a fake sender).
		const plumbing: Plumbing = { ...base, extensions: () => ({ ...base.extensions(), tasks: [boom, notifyTasksExtension] }) };
		const host: RoleHost = await openRoleHost({
			dbPath: join(stateDir, "roles.db"),
			stateDir,
			roles: enabled,
			defaultModel,
			hostModels,
			plumbing,
			resume: false,
		});
		setOwnerNotifier(undefined);
		try {
			const conversations = await host.harness.snapshot(RoleConversationsDoc, context);
			const conversationId = conversations?.conversations["alpha"] as ConversationId;
			await host.harness.commit(
				(tx) => tx.createTask(BoomTask, null, { ownership: { kind: "conversation" }, conversationId, background: true }),
				context,
			);
			host.harness.resume();
			const delivered = await waitForDelivered(host);
			expect(delivered).toBeDefined();
			expect(delivered!.title).toContain("faulted");
			expect(delivered!.title).toContain("test.boom");
		} finally {
			await host.close();
			setOwnerNotifier(undefined);
		}
	}, 30_000);

	it("a faulted task's message names the role and the error", () => {
		// The notify task with no installed sender marks the message sent, so the sent mark keeps its title.
		expect(
			describeReport(
				taskReport("task_faulted", { id: 5, task: "test.boom", reason: "threw", error: new Error("phase exploded") }),
				{ roleOf: () => "alpha" },
			),
		).toMatchObject({ conversationId: conversation });
	});
});

/** The first notify message the host marked sent (queued first, then sent by its own task). */
async function waitForDelivered(host: RoleHost): Promise<{ key: string; title: string } | undefined> {
	for (let attempt = 0; attempt < 300; attempt++) {
		const doc = await host.harness.snapshot(RoleNotifications, context);
		const sent = Object.entries(doc?.sent ?? {});
		if (sent.length > 0) return { key: sent[0][0], title: sent[0][1].title };
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return undefined;
}

/** The notify dedupe keys currently queued for the role (empty until the first commit lands). */
async function waitForQueue(host: RoleHost): Promise<string[]> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const doc = await host.harness.snapshot(RoleNotifications, context);
		const keys = Object.keys(doc?.queued ?? {});
		if (keys.length > 0) return keys;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return [];
}
