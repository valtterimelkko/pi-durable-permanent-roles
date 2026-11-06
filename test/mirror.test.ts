import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, ConversationId } from "@earendil-works/pi-durable";
import { openRoleHost, RoleConversationsDoc, type RoleHost } from "../src/harness.ts";
import { startMirror, type MirrorLine, type RoleStatus } from "../src/mirror.ts";
import { loadRoles } from "../src/roles.ts";
import { makeFauxHostModels, makeStateDir, writeRolesTree } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;
const roots: string[] = [];

afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(fauxOptions?: Parameters<typeof makeFauxHostModels>[0]): Promise<{ host: RoleHost; stateDir: string }> {
	const stateDir = await makeStateDir();
	const rolesRoot = join(await mkdtemp(join(tmpdir(), "sr-mirror-")), "roles");
	roots.push(rolesRoot, stateDir);
	await writeRolesTree(rolesRoot, [{ name: "alpha", schedule: [{ at: "09:00", days: "daily" }] }]);
	const { enabled } = await loadRoles({ rolesRoot, stateDir });
	const { hostModels, defaultModel } = makeFauxHostModels(fauxOptions);
	const host = await openRoleHost({
		dbPath: join(stateDir, "roles.db"),
		stateDir,
		roles: enabled,
		defaultModel,
		hostModels,
	});
	return { host, stateDir };
}

async function lines(stateDir: string, roleName: string): Promise<MirrorLine[]> {
	const text = await readFile(join(stateDir, "roles", roleName, "transcript.jsonl"), "utf8");
	return text
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as MirrorLine);
}

async function status(stateDir: string, roleName: string): Promise<RoleStatus> {
	return JSON.parse(await readFile(join(stateDir, "roles", roleName, "status.json"), "utf8")) as RoleStatus;
}

describe("startMirror", () => {
	it("creates the notes folder at start and writes status.json for each role", async () => {
		const { host, stateDir } = await setup();
		const mirror = await startMirror({ host, stateDir });
		try {
			const notesStat = await stat(join(stateDir, "roles", "alpha", "notes"));
			expect(notesStat.isDirectory()).toBe(true);
			const s = await status(stateDir, "alpha");
			expect(s.role).toBe("alpha");
			expect(s.title).toBe("alpha");
			expect(s.enabled).toBe(true);
			expect(s.busy).toBe(false);
			expect(s.boardName).toBe("role-alpha");
			expect(s.model).toEqual({ provider: "faux", modelId: "m-1" });
			expect(s.nextRunAt).not.toBeNull();
			expect(s.lastRunAt).toBeNull();
		} finally {
			await mirror.stop();
			await host.close();
		}
	});

	it("mirrors user and assistant turns into transcript.jsonl", async () => {
		const { host, stateDir } = await setup();
		const mirror = await startMirror({ host, stateDir });
		try {
			await host.submit("alpha", { content: "hello mirror", requestId: "m1" });
			await (await host.conversation("alpha"))!.waitForIdle(context);
			await new Promise((resolve) => setTimeout(resolve, 50));
			const mirrored = await lines(stateDir, "alpha");
			const kinds = mirrored.map((line) => line.kind);
			expect(kinds).toContain("user");
			expect(kinds).toContain("assistant");
			const user = mirrored.find((line) => line.kind === "user")!;
			expect(user.text).toContain("hello mirror");
			const assistant = mirrored.find((line) => line.kind === "assistant")!;
			expect(assistant.text).toContain("Reply to: hello mirror");
			// status.json updates: the run is recorded and the conversation is idle again.
			const s = await status(stateDir, "alpha");
			expect(s.busy).toBe(false);
			expect(s.lastRunSlot).toBe("m1");
		} finally {
			await mirror.stop();
			await host.close();
		}
	});

	it("mirrors tool calls as name plus capped argument and result summaries", async () => {
		const { host, stateDir } = await setup();
		const mirror = await startMirror({ host, stateDir });
		try {
			await host.submit("alpha", { content: "allowed-check", requestId: "m2" });
			await (await host.conversation("alpha"))!.waitForIdle(context);
			await new Promise((resolve) => setTimeout(resolve, 50));
			const mirrored = await lines(stateDir, "alpha");
			const tool = mirrored.find((line) => line.kind === "tool");
			expect(tool).toBeDefined();
			expect(tool!.text).toContain("bash");
			expect(tool!.text).toContain("reboot-notes");
			expect(tool!.text.length).toBeLessThanOrEqual(400);
		} finally {
			await mirror.stop();
			await host.close();
		}
	});

	it("mirrors a compaction as a compaction line carrying the notes pointer", async () => {
		// A small window so the summary keeps something: with the 1M default the whole
		// context stays verbatim and no compaction runs.
		const { host, stateDir } = await setup({ models: [{ id: "m-1", contextWindow: 2_000 }] });
		const mirror = await startMirror({ host, stateDir });
		try {
			await host.submit("alpha", { content: "FILLER one", requestId: "c1" });
			await (await host.conversation("alpha"))!.waitForIdle(context);
			await host.submit("alpha", { content: "FILLER two", requestId: "c2" });
			await (await host.conversation("alpha"))!.waitForIdle(context);
			const conversation = await host.conversation("alpha");
			await conversation!.compact(undefined, context);
			await conversation!.waitForIdle(context);
			await new Promise((resolve) => setTimeout(resolve, 50));
			const mirrored = await lines(stateDir, "alpha");
			const compaction = mirrored.find((line) => line.kind === "compaction");
			expect(compaction).toBeDefined();
			expect(compaction!.text).toContain("is the record: re-read it before continuing.");
		} finally {
			await mirror.stop();
			await host.close();
		}
	});

	// Plan PI-DURABLE-1.5-MIGRATION §B.2 item 5: the 1.5 view is a window (newest 50 at attach, past 100 the oldest
	// leave in one splice down to 50). If more than 100 entries land while the listener is held — the mirror awaits
	// its status write inside the listener — entries can leave the window unseen. The gap fill pages the missing
	// range from the durable record, so every entry lands in transcript.jsonl exactly once.
	it("mirrors more than 100 entries appended while the listener is held: each lands exactly once", async () => {
		const { host, stateDir } = await setup();
		// Hold the listener inside its status write: statusOf awaits conversation.agent(), so a gated agent holds it.
		const hold: { promise: Promise<void>; release(): void } = { promise: Promise.resolve(), release: () => {} };
		const arm = (): void => {
			let release!: () => void;
			const promise = new Promise<void>((resolve) => {
				release = resolve;
			});
			hold.promise = promise;
			hold.release = release;
		};
		const real = await host.conversation("alpha");
		expect(real).toBeDefined();
		const gated = new Proxy(real as object, {
			get(target, property, receiver) {
				if (property === "agent") {
					return async (...args: unknown[]) => {
						await hold.promise;
						const value = Reflect.get(target, property, target) as (...callArgs: unknown[]) => unknown;
						return typeof value === "function" ? value.call(target, ...args) : value;
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? (value as (...callArgs: unknown[]) => unknown).bind(target) : value;
			},
		}) as Conversation;
		const mirror = await startMirror({ host: { ...host, conversation: async () => gated } as RoleHost, stateDir });
		try {
			arm(); // the next agent() call — the listener's status write — hangs until released
			const conversations = await host.harness.snapshot(RoleConversationsDoc, context);
			const conversationId = conversations?.conversations["alpha"] as ConversationId;
			expect(conversationId).toBeDefined();
			const TOTAL = 120; // past the window's max (100), so the oldest leave before any listener call sees them
			for (let index = 1; index <= TOTAL; index += 1) {
				await host.harness.commit(
					(tx) =>
						tx.appendEntry(conversationId, {
							kind: "pi.user",
							model: [{ role: "user", content: `FILLER ${index}`, timestamp: index }],
						}),
					context,
				);
			}
			await new Promise((resolve) => setTimeout(resolve, 200)); // the last commits settle while the listener is held
			hold.release();
			const deadline = Date.now() + 15_000;
			let mirrored: MirrorLine[] = [];
			while (Date.now() < deadline) {
				// The transcript appears with the first mirrored line; tolerate its absence while the fill runs.
				mirrored = await lines(stateDir, "alpha").catch(() => [] as MirrorLine[]);
				if (mirrored.filter((line) => line.kind === "user").length >= TOTAL) break;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			const users = mirrored.filter((line) => line.kind === "user");
			expect(users).toHaveLength(TOTAL);
			const texts = users.map((line) => line.text);
			expect(new Set(texts).size).toBe(TOTAL); // exactly once each: no duplicates, no gaps
			for (let index = 1; index <= TOTAL; index += 1) expect(texts).toContain(`FILLER ${index}`);
		} finally {
			await mirror.stop();
			await host.close();
		}
	}, 30_000);

	// Review finding 1: the gap fill had no anchor when the attach-time view was empty (newestSeen undefined),
	// so a first value whose window starts past the transcript start lost its earlier entries silently. Here the
	// whole burst is ONE commit that lands before any listener call has run: the first delivered window holds
	// only the newest 50 (before = entry 80) and no anchor exists — the fill must page from the transcript start.
	it("mirrors a burst committed into an empty conversation past the first window: no silent gap without an anchor", async () => {
		const { host, stateDir } = await setup();
		const mirror = await startMirror({ host, stateDir }); // attaches to an EMPTY transcript: no anchor yet
		try {
			const conversations = await host.harness.snapshot(RoleConversationsDoc, context);
			const conversationId = conversations?.conversations["alpha"] as ConversationId;
			expect(conversationId).toBeDefined();
			const TOTAL = 130; // past the window's max (100), so the first delivered value is already spliced
			await host.harness.commit(
				async (tx) => {
					for (let index = 1; index <= TOTAL; index += 1) {
						await tx.appendEntry(conversationId, {
							kind: "pi.user",
							model: [{ role: "user", content: `EARLY ${index}`, timestamp: index }],
						});
					}
				},
				context,
			);
			const deadline = Date.now() + 15_000;
			let mirrored: MirrorLine[] = [];
			while (Date.now() < deadline) {
				// The transcript appears with the first mirrored line; tolerate its absence while the fill runs.
				mirrored = await lines(stateDir, "alpha").catch(() => [] as MirrorLine[]);
				if (mirrored.filter((line) => line.kind === "user").length >= TOTAL) break;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			const users = mirrored.filter((line) => line.kind === "user");
			expect(users).toHaveLength(TOTAL);
			const texts = users.map((line) => line.text);
			expect(new Set(texts).size).toBe(TOTAL); // exactly once each: no duplicates, no gaps
			for (let index = 1; index <= TOTAL; index += 1) expect(texts).toContain(`EARLY ${index}`);
		} finally {
			await mirror.stop();
			await host.close();
		}
	}, 30_000);
});
