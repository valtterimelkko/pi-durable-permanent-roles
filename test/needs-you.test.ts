/**
 * "Needs you" items: the `raise_item` and `resolve_item` tools and the `needs-you.jsonl` append
 * (the line format is versioned). Format v2: a `delegate`
 * suggestion carries `tasks` classified `system`|`messaging` and never a `target` — a delegation always starts a
 * new session; every new item line carries `"v":2`.
 *
 * One duplicated item is worse than one lost in a crash window (the reader would show two cards), so the
 * durable written mark lands BEFORE the file append, exactly as notify's sent marks land before the send: a
 * replayed tool call reads its mark and returns the first response, never appending twice. The tests drive the
 * tools through a scripted store and a temp state directory; no test touches the live state directory.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import type { RoleDefinition } from "../src/types.ts";
import {
	BODY_MAX,
	BRIEF_MAX,
	KINDS,
	LINE_MAX_BYTES,
	NEEDS_YOU_FILENAME,
	NOTE_MAX,
	SUGGESTION_ACTIONS,
	TASKS_MAX,
	TASK_CATEGORIES,
	TASK_TEXT_MAX,
	TITLE_MAX,
	needsYouId,
	needsYouStateDir,
	needsYouTools,
} from "../src/needs-you.ts";

const conversation = 7 as ConversationId;
const nowMs = Date.UTC(2026, 9, 21, 9, 15); // 10:15 in London (BST)

function role(name: string): RoleDefinition {
	return {
		name,
		dir: `/srv/roles/roles/${name}`,
		settings: {
			enabled: true,
			title: `${name} title`,
			boardName: `role-${name}`,
			schedule: [],
			cwd: `/srv/roles/roles/${name}`,
			tools: ["notify"],
		},
		model: { provider: "zai", modelId: "glm-5.3-flash" },
		thinking: "high",
		instructions: "",
		notesDir: `/var/lib/pi-roles/roles/${name}/notes`,
	};
}

const docs = role("docs");

/** A temp state directory per test, removed afterwards. */
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempStateDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "needs-you-"));
	dirs.push(dir);
	return dir;
}

/** A scripted stand-in for the durable store behind one tool call, keyed by conversation + call id. */
function fakeApi(callId = "call-1", conversationId: ConversationId = conversation) {
	const doc = {
		written: {} as Record<string, { id: string; response: Record<string, string>; atMs: number }>,
	};
	return {
		api: {
			conversationId,
			callId,
			snapshot: async () => doc,
			commit: async (change: (tx: { doc: () => unknown }) => unknown) =>
				change({ doc: async () => doc }),
		},
		doc,
	};
}

function tool(stateDir: string, caller: RoleDefinition | null = docs, callId = "call-1") {
	const extensionTools = needsYouTools({
		stateDir,
		now: () => nowMs,
		roleForConversation: caller === null ? undefined : () => caller,
	});
	const raise = extensionTools.find((candidate) => candidate.name === "raise_item");
	const resolve = extensionTools.find((candidate) => candidate.name === "resolve_item");
	expect(raise).toBeDefined();
	expect(resolve).toBeDefined();
	return {
		raise: raise!,
		resolve: resolve!,
		executeRaise: (args: Record<string, unknown>, api: unknown) =>
			raise!.execute(args as never, api as never, undefined as never),
		executeResolve: (args: Record<string, unknown>, api: unknown) =>
			resolve!.execute(args as never, api as never, undefined as never),
		callId,
	};
}

function lines(stateDir: string): unknown[] {
	return readFileSync(join(stateDir, NEEDS_YOU_FILENAME), "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line));
}

function responseOf(result: { output?: unknown }): Record<string, unknown> {
	return JSON.parse((result.output as Array<{ text: string }>)[0].text) as Record<string, unknown>;
}

async function raiseOne(stateDir: string, api: unknown, args: Record<string, unknown> = {}): Promise<string> {
	const harness = tool(stateDir);
	const result = await harness.executeRaise(
		{ kind: "flag", title: "Drift in the roadmap", body: "The roadmap names a lane that is done.", ...args },
		api,
	);
	expect(result.isError).toBeUndefined();
	return String(responseOf(result).id);
}

describe("frozen shape", () => {
	it("matches the format the parent froze", () => {
		expect(KINDS).toEqual(["problem", "suggestion", "flag", "reminder"]);
		expect(SUGGESTION_ACTIONS).toEqual(["delegate", "launch", "send-to-role"]);
		expect(TASK_CATEGORIES).toEqual(["system", "messaging"]);
		expect(TASKS_MAX).toBe(20);
		expect(TASK_TEXT_MAX).toBe(500);
		expect(TITLE_MAX).toBe(120);
		expect(BODY_MAX).toBe(2_000);
		expect(BRIEF_MAX).toBe(4_000);
		expect(NOTE_MAX).toBe(300);
		expect(LINE_MAX_BYTES).toBe(4_096);
		expect(NEEDS_YOU_FILENAME).toBe("needs-you.jsonl");
	});

	it("builds the id <role>-<yyyymmddThhmmss>-<6 hex> on the host-zone clock (UTC by default)", () => {
		expect(needsYouId("docs", Date.UTC(2026, 9, 21, 9, 15), () => "abc123")).toBe("docs-20261021T091500-abc123");
		expect(needsYouId("docs", Date.UTC(2026, 11, 21, 9, 15), () => "abc123")).toBe("docs-20261221T091500-abc123");
		expect(needsYouId("docs", nowMs)).toMatch(/^docs-\d{8}T\d{6}-[0-9a-f]{6}$/);
	});

	it("resolves the state dir from the option, then the environment, then the production default", () => {
		expect(needsYouStateDir({ stateDir: "/tmp/a" })).toBe("/tmp/a");
		const previous = process.env.STANDING_ROLES_STATE_DIR;
		process.env.STANDING_ROLES_STATE_DIR = "/tmp/from-env";
		try {
			expect(needsYouStateDir({})).toBe("/tmp/from-env");
		} finally {
			if (previous === undefined) delete process.env.STANDING_ROLES_STATE_DIR;
			else process.env.STANDING_ROLES_STATE_DIR = previous;
		}
		delete process.env.STANDING_ROLES_STATE_DIR;
		expect(needsYouStateDir({})).toBe("/var/lib/pi-roles");
	});
});

describe("raise_item validation", () => {
	it("accepts the four kinds and refuses an unknown one", async () => {
		const stateDir = tempStateDir();
		const harness = tool(stateDir);
		for (const kind of KINDS) {
			const result = await harness.executeRaise({ kind, title: "t", body: "b" }, fakeApi().api);
			expect(result.isError).toBeUndefined();
			rmSync(join(stateDir, NEEDS_YOU_FILENAME));
		}
		const refused = await harness.executeRaise({ kind: "urgent", title: "t", body: "b" }, fakeApi().api);
		expect(refused.isError).toBe(true);
		expect(responseOf(refused).message).toMatch(/kind/);
		expect(existsSync(join(stateDir, NEEDS_YOU_FILENAME))).toBe(false);
	});

	it("refuses an empty title or body and one over the caps", async () => {
		const stateDir = tempStateDir();
		const harness = tool(stateDir);
		for (const args of [
			{ kind: "flag", title: "   ", body: "b" },
			{ kind: "flag", title: "t", body: "  " },
			{ kind: "flag", title: "x".repeat(121), body: "b" },
			{ kind: "flag", title: "t", body: "x".repeat(2_001) },
		]) {
			const result = await harness.executeRaise(args, fakeApi().api);
			expect(result.isError).toBe(true);
		}
		expect(existsSync(join(stateDir, NEEDS_YOU_FILENAME))).toBe(false);
	});

	it("refuses an unknown suggestion action", async () => {
		const stateDir = tempStateDir();
		const harness = tool(stateDir);
		const noAction = await harness.executeRaise(
			{ kind: "suggestion", title: "t", body: "b", suggestion: { action: "maybe" } },
			fakeApi().api,
		);
		expect(noAction.isError).toBe(true);
		const overBrief = await harness.executeRaise(
			{ kind: "suggestion", title: "t", body: "b", suggestion: { action: "launch", brief: "x".repeat(4_001) } },
			fakeApi().api,
		);
		expect(overBrief.isError).toBe(true);
		expect(existsSync(join(stateDir, NEEDS_YOU_FILENAME))).toBe(false);
	});

	it("refuses a delegate without tasks, and a target: a delegation always starts a new session", async () => {
		const stateDir = tempStateDir();
		const harness = tool(stateDir);
		const noTasks = await harness.executeRaise(
			{ kind: "suggestion", title: "t", body: "b", suggestion: { action: "delegate" } },
			fakeApi().api,
		);
		expect(noTasks.isError).toBe(true);
		expect(responseOf(noTasks).message).toMatch(/tasks/);
		const withTarget = await harness.executeRaise(
			{
				kind: "suggestion",
				title: "t",
				body: "b",
				suggestion: { action: "delegate", target: "pi:01abc", tasks: [{ category: "system", text: "t" }] },
			},
			fakeApi().api,
		);
		expect(withTarget.isError).toBe(true);
		expect(responseOf(withTarget).message).toMatch(/a delegation always starts a new session/);
		expect(existsSync(join(stateDir, NEEDS_YOU_FILENAME))).toBe(false);
	});

	it("refuses a task list outside the frozen bounds", async () => {
		const stateDir = tempStateDir();
		const harness = tool(stateDir);
		const okTask = { category: "system", text: "Do the thing." };
		for (const tasks of [
			[],
			Array.from({ length: TASKS_MAX + 1 }, () => okTask),
			[{ category: "coding", text: "t" }],
			[{ category: "system", text: "" }],
			[{ category: "system", text: "x".repeat(TASK_TEXT_MAX + 1) }],
			[{ category: "system" }],
			["Do the thing."],
		]) {
			const result = await harness.executeRaise(
				{ kind: "suggestion", title: "t", body: "b", suggestion: { action: "delegate", tasks } },
				fakeApi().api,
			);
			expect(result.isError, `refuses ${JSON.stringify(tasks).slice(0, 40)}`).toBe(true);
		}
		expect(existsSync(join(stateDir, NEEDS_YOU_FILENAME))).toBe(false);
	});

	it("refuses tasks or a target on launch and send-to-role", async () => {
		const stateDir = tempStateDir();
		const harness = tool(stateDir);
		for (const action of ["launch", "send-to-role"] as const) {
			const withTasks = await harness.executeRaise(
				{
					kind: "suggestion",
					title: "t",
					body: "b",
					suggestion: { action, tasks: [{ category: "system", text: "t" }] },
				},
				fakeApi().api,
			);
			expect(withTasks.isError, action).toBe(true);
			const withTarget = await harness.executeRaise(
				{ kind: "suggestion", title: "t", body: "b", suggestion: { action, target: "pi:01abc" } },
				fakeApi().api,
			);
			expect(withTarget.isError, action).toBe(true);
		}
		expect(existsSync(join(stateDir, NEEDS_YOU_FILENAME))).toBe(false);
	});

	it("accepts a v2 delegate: tasks with categories, plus an optional shared brief", async () => {
		const stateDir = tempStateDir();
		const harness = tool(stateDir);
		const result = await harness.executeRaise(
			{
				kind: "suggestion",
				title: "t",
				body: "b",
				suggestion: {
					action: "delegate",
					tasks: [
						{ category: "system", text: "Assess the Pi Durable 1.1.0 to 1.3.0 migration." },
						{ category: "messaging", text: "Draft the term-dates reply." },
					],
					brief: "Found on the nightly run; wait for the owner.",
				},
			},
			fakeApi().api,
		);
		expect(result.isError).toBeUndefined();
		const parsed = lines(stateDir) as Array<{ v: number; suggestion: Record<string, unknown> }>;
		expect(parsed).toHaveLength(1);
		expect(parsed[0]!.v).toBe(2);
		expect(parsed[0]!.suggestion.tasks).toEqual([
			{ category: "system", text: "Assess the Pi Durable 1.1.0 to 1.3.0 migration." },
			{ category: "messaging", text: "Draft the term-dates reply." },
		]);
		expect(parsed[0]!.suggestion.brief).toBe("Found on the nightly run; wait for the owner.");
		expect(parsed[0]!.suggestion.target).toBeUndefined();
	});

	it("launch and send-to-role are unchanged: a brief, no tasks", async () => {
		const stateDir = tempStateDir();
		for (const action of ["launch", "send-to-role"] as const) {
			const harness = tool(stateDir);
			const result = await harness.executeRaise(
				{
					kind: "suggestion",
					title: "t",
					body: "b",
					suggestion: { action, brief: "Do this." },
				},
				fakeApi(`call-${action}`).api,
			);
			expect(result.isError).toBeUndefined();
		}
		const parsed = lines(stateDir) as Array<{ suggestion: Record<string, unknown> }>;
		expect(parsed).toHaveLength(2);
		expect(parsed.every((line) => line.suggestion.brief === "Do this.")).toBe(true);
		expect(parsed.every((line) => line.suggestion.tasks === undefined)).toBe(true);
	});

	it("the raise_item schema offers tasks with categories and no target", () => {
		const harness = tool(tempStateDir());
		const schema = JSON.stringify(harness.raise.parameters);
		expect(schema).toContain('"tasks"');
		expect(schema).toContain('"category"');
		expect(schema).not.toContain('"target"');
	});

	it("refuses a line that would not stay under the atomic-append bound, and writes nothing", async () => {
		const stateDir = tempStateDir();
		const harness = tool(stateDir);
		const result = await harness.executeRaise(
			{ kind: "suggestion", title: "t", body: "x".repeat(BODY_MAX), suggestion: { action: "launch", brief: "x".repeat(BRIEF_MAX) } },
			fakeApi().api,
		);
		expect(result.isError).toBe(true);
		expect(responseOf(result).message).toMatch(/4,?096|atomic/);
		expect(existsSync(join(stateDir, NEEDS_YOU_FILENAME))).toBe(false);
	});

	it("refuses when the conversation is not a standing role", async () => {
		const stateDir = tempStateDir();
		const harness = tool(stateDir, null);
		const result = await harness.executeRaise({ kind: "flag", title: "t", body: "b" }, fakeApi().api);
		expect(result.isError).toBe(true);
		expect(responseOf(result).message).toMatch(/not a standing role/);
	});
});

describe("raise_item append", () => {
	it("appends one JSON line with the frozen fields and returns the id", async () => {
		const stateDir = tempStateDir();
		const api = fakeApi();
		const id = await raiseOne(stateDir, api.api, {
			link: "https://example.test/roadmap",
			suggestion: {
				action: "delegate",
				tasks: [{ category: "system", text: "Re-check the docs lane." }],
				brief: "Ask the docs lane to re-check.",
			},
		});
		expect(id).toMatch(/^docs-\d{8}T\d{6}-[0-9a-f]{6}$/);
		const written = lines(stateDir);
		expect(written).toHaveLength(1);
		expect(written[0]).toEqual({
			type: "item",
			v: 2,
			id,
			ts: "2026-10-21T09:15:00.000Z",
			role: "docs",
			boardName: "role-docs",
			kind: "flag",
			title: "Drift in the roadmap",
			body: "The roadmap names a lane that is done.",
			suggestion: {
				action: "delegate",
				tasks: [{ category: "system", text: "Re-check the docs lane." }],
				brief: "Ask the docs lane to re-check.",
			},
			link: "https://example.test/roadmap",
		});
		// The written mark is durable before the append: a replay reads it from the doc.
		expect(api.doc.written[`7:call-1`]?.id).toBe(id);
	});

	it("creates the file 0600 and never appends a partial line", async () => {
		const stateDir = tempStateDir();
		await raiseOne(stateDir, fakeApi().api);
		const file = join(stateDir, NEEDS_YOU_FILENAME);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		const text = readFileSync(file, "utf8");
		expect(text.endsWith("\n")).toBe(true);
		expect(text.trimEnd().split("\n")).toHaveLength(1);
	});

	it("a replayed call (same conversation + call id) returns the same response and never appends twice", async () => {
		const stateDir = tempStateDir();
		const api = fakeApi();
		const first = await raiseOne(stateDir, api.api);
		const harness = tool(stateDir);
		const replay = await harness.executeRaise(
			{ kind: "problem", title: "different", body: "arguments" },
			api.api,
		);
		expect(responseOf(replay)).toEqual({ status: "raised", id: first, file: join(stateDir, NEEDS_YOU_FILENAME) });
		expect(lines(stateDir)).toHaveLength(1);
	});

	it("a different call id appends a new item with a new id", async () => {
		const stateDir = tempStateDir();
		const first = await raiseOne(stateDir, fakeApi("call-1").api);
		const second = await raiseOne(stateDir, fakeApi("call-2").api);
		expect(second).not.toBe(first);
		expect(lines(stateDir)).toHaveLength(2);
	});
});

describe("resolve_item rules", () => {
	it("refuses an unknown id, also when the file does not exist yet", async () => {
		const stateDir = tempStateDir();
		const harness = tool(stateDir);
		const result = await harness.executeResolve(
			{ id: "docs-20990101T000000-ffffff" },
			fakeApi("resolve-1").api,
		);
		expect(result.isError).toBe(true);
		expect(responseOf(result).message).toMatch(/No needs-you item/);
	});

	it("refuses another role's item", async () => {
		const stateDir = tempStateDir();
		const id = await raiseOne(stateDir, fakeApi("call-1").api);
		const harness = tool(stateDir, role("runtime-keeper"));
		const result = await harness.executeResolve({ id }, fakeApi("resolve-1").api);
		expect(result.isError).toBe(true);
		expect(responseOf(result).message).toMatch(/belongs to the role 'docs'/);
		expect(lines(stateDir)).toHaveLength(1);
	});

	it("resolves the role's own item with one resolved line", async () => {
		const stateDir = tempStateDir();
		const id = await raiseOne(stateDir, fakeApi("call-1").api);
		const harness = tool(stateDir);
		const result = await harness.executeResolve(
			{ id, note: "The operator ticked it off." },
			fakeApi("resolve-1").api,
		);
		expect(result.isError).toBeUndefined();
		expect(responseOf(result)).toEqual({ status: "resolved", id });
		const written = lines(stateDir);
		expect(written).toHaveLength(2);
		expect(written[1]).toEqual({
			type: "resolved",
			id,
			ts: "2026-10-21T09:15:00.000Z",
			by: "role",
			note: "The operator ticked it off.",
		});
	});

	it("keeps the note within 300 characters and defaults it to empty", async () => {
		const stateDir = tempStateDir();
		const id = await raiseOne(stateDir, fakeApi("call-1").api);
		const harness = tool(stateDir);
		const over = await harness.executeResolve({ id, note: "x".repeat(301) }, fakeApi("resolve-2").api);
		expect(over.isError).toBe(true);
		await harness.executeResolve({ id }, fakeApi("resolve-3").api);
		const written = lines(stateDir) as Array<{ type: string; note?: string }>;
		expect(written).toHaveLength(2);
		expect(written[1].note).toBe("");
	});

	it("a second resolve finds the item already resolved and appends nothing", async () => {
		const stateDir = tempStateDir();
		const id = await raiseOne(stateDir, fakeApi("call-1").api);
		const harness = tool(stateDir);
		await harness.executeResolve({ id }, fakeApi("resolve-1").api);
		const again = await harness.executeResolve({ id }, fakeApi("resolve-2").api);
		expect(again.isError).toBeUndefined();
		expect(responseOf(again)).toEqual({ status: "already-resolved", id });
		expect(lines(stateDir)).toHaveLength(2);
	});

	it("a replayed resolve returns the first response and never appends twice", async () => {
		const stateDir = tempStateDir();
		const id = await raiseOne(stateDir, fakeApi("call-1").api);
		const api = fakeApi("resolve-1");
		const harness = tool(stateDir);
		await harness.executeResolve({ id, note: "done" }, api.api);
		const replay = await harness.executeResolve({ id, note: "different arguments" }, api.api);
		expect(responseOf(replay)).toEqual({ status: "resolved", id });
		expect(lines(stateDir)).toHaveLength(2);
	});
});

describe("the preamble names the tools", () => {
	it("carries one paragraph on raising and resolving items", () => {
		const preamble = readFileSync(new URL("../roles/PREAMBLE.md", import.meta.url), "utf8");
		expect(preamble).toContain("raise_item");
		expect(preamble).toContain("resolve_item");
		expect(preamble).toContain("The chat stays the place for discussion; an item is only a shortcut.");
	});
});

describe("the notify extension carries the tools", () => {
	it("registers raise_item and resolve_item next to notify_owner", async () => {
		const { notifyExtension } = await import("../src/notify.ts");
		const extension = notifyExtension({ stateDir: tempStateDir(), roleForConversation: () => docs });
		expect(extension.tools?.map((candidate) => candidate.name)).toEqual([
			"notify_owner",
			"raise_item",
			"resolve_item",
			"report_run",
		]);
	});
});

describe("plumbing passes the state dir through", () => {
	it("raise_item through createPlumbing writes into the environment's state dir", async () => {
		const previous = process.env.STANDING_ROLES_STATE_DIR;
		const stateDir = tempStateDir();
		process.env.STANDING_ROLES_STATE_DIR = stateDir;
		try {
			const { createPlumbing } = await import("../src/plumbing.ts");
			const { createStubIntegrations } = await import("../src/integrations/stub.ts");
			const { Harness, MemoryStorage, createRegistry } = await import("@earendil-works/pi-durable");
			const { createModels } = await import("@earendil-works/pi-ai/models");
			const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
			const harness = await Harness.open(
				new MemoryStorage(),
				{ models: createModels(), registry: createRegistry() },
				BACKGROUND_CONTEXT,
			);
			try {
				const hostConversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
				const plumbing = createPlumbing({
					integrations: createStubIntegrations(),
					notify: async () => undefined,
				});
				await plumbing.start({
					harness,
					roles: () => [docs],
					roleForConversation: (id: string) => (id === String(hostConversation.id) ? docs : undefined),
					currentSlot: () => "sched-test",
					submit: async () => undefined,
				});
				try {
					const raise = plumbing
						.extensions()
						.notify.tools?.find((candidate) => candidate.name === "raise_item");
					expect(raise).toBeDefined();
					const doc = { written: {} };
					const result = await raise!.execute(
						{ kind: "reminder", title: "Check the roadmap", body: "Lane r2 landed." },
						{
							conversationId: hostConversation.id,
							callId: "wiring-1",
							snapshot: async () => doc,
							commit: async (change: (tx: { doc: () => unknown }) => unknown) => change({ doc: async () => doc }),
						} as never,
						BACKGROUND_CONTEXT,
					);
					expect(result.isError).toBeUndefined();
					const written = lines(stateDir) as Array<{ role: string; boardName: string }>;
					expect(written).toHaveLength(1);
					expect(written[0].role).toBe("docs");
					expect(written[0].boardName).toBe("role-docs");
				} finally {
					await plumbing.stop();
				}
			} finally {
				await harness.close(BACKGROUND_CONTEXT);
			}
		} finally {
			if (previous === undefined) delete process.env.STANDING_ROLES_STATE_DIR;
			else process.env.STANDING_ROLES_STATE_DIR = previous;
		}
	});
});

describe("file helpers", () => {
	it("mkdir -p the state dir on append", async () => {
		const root = tempStateDir();
		const nested = join(root, "state", "roles");
		const { appendNeedsYouLine } = await import("../src/needs-you.ts");
		await appendNeedsYouLine(nested, JSON.stringify({ type: "item", id: "x" }));
		expect(statSync(join(nested, NEEDS_YOU_FILENAME)).mode & 0o777).toBe(0o600);
	});

	it("reads items and resolutions tolerantly, skipping junk lines and a missing file", async () => {
		const { readNeedsYouFile } = await import("../src/needs-you.ts");
		const stateDir = tempStateDir();
		expect(readNeedsYouFile(stateDir)).toEqual({ items: new Map(), resolved: new Set() });
		mkdirSync(stateDir, { recursive: true });
		const { writeFileSync: write } = await import("node:fs");
		write(
			join(stateDir, NEEDS_YOU_FILENAME),
			`${JSON.stringify({ type: "item", id: "a", role: "docs" })}\nnot json\n${JSON.stringify({ type: "resolved", id: "a" })}\n`,
			{ mode: 0o600 },
		);
		const state = readNeedsYouFile(stateDir);
		expect(state.items.get("a")).toEqual({ role: "docs" });
		expect(state.resolved.has("a")).toBe(true);
	});
});
