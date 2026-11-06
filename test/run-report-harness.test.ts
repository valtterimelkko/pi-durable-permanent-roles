/**
 * The run-end line the host appends when a run's submission settles: one
 * `run-end` line per run in `<stateDir>/runs.jsonl` beside the memory record, saying whether the role reported —
 * best effort, never on the critical path. The tests run the real host on a temp state dir with the faux provider;
 * no real model calls and no live state directory.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type FauxProviderHandle,
	type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import { ToolResultEntry } from "@earendil-works/pi-durable";
import { openRoleHost, type RoleHost } from "../src/harness.ts";
import { createPlumbing } from "../src/plumbing.ts";
import { createStubIntegrations } from "../src/integrations/stub.ts";
import { loadRoles } from "../src/roles.ts";
import { makeReportedRunTracker, markReportedRun, readRunsFile, reportRunTools } from "../src/run-report.ts";
import { RUNS_FILENAME } from "../src/oversight-types.ts";
import { makeFauxHostModels, makeStateDir, messageTextOf, writeRolesTree } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;
const roots: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function freshHost(roleName = "alpha"): Promise<{ host: RoleHost; stateDir: string }> {
	const stateDir = await makeStateDir();
	const rolesRootParent = mkdtempSync(join(tmpdir(), "sr-runreport-"));
	const rolesRoot = join(rolesRootParent, "roles");
	roots.push(rolesRootParent, stateDir);
	await writeRolesTree(rolesRoot, [{ name: roleName }]);
	const { enabled } = await loadRoles({ rolesRoot, stateDir });
	const { hostModels, defaultModel } = makeFauxHostModels();
	const host = await openRoleHost({
		dbPath: join(stateDir, "roles.db"),
		stateDir,
		roles: enabled,
		defaultModel,
		hostModels,
	});
	return { host, stateDir };
}

/** Wait (bounded) for the first run-end line to land; the append is off the critical path. */
async function runEndLine(stateDir: string): Promise<Record<string, unknown>> {
	const deadline = Date.now() + 3_000;
	for (;;) {
		const line = readRunsFile(stateDir).find((candidate) => candidate.kind === "run-end") as
			| Record<string, unknown>
			| undefined;
		if (line !== undefined) return line;
		if (Date.now() > deadline) throw new Error("timed out waiting for the run-end line");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

describe("the run-end line", () => {
	it("is appended for every settled run: role, slot, startedAt = the run's at, reported = false", async () => {
		const { host, stateDir } = await freshHost();
		try {
			const before = Date.now();
			await host.submit("alpha", { content: "a scheduled round", requestId: "sched-1" });
			const at = host.lastRun("alpha");
			expect(at).toBeDefined();
			await (await host.conversation("alpha"))!.waitForIdle(context);
			const line = await runEndLine(stateDir);
			expect(line).toEqual({
				v: 1,
				kind: "run-end",
				role: "alpha",
				slot: "sched-1",
				startedAt: new Date(at!.atMs).toISOString(),
				endedAt: expect.any(String),
				reported: false,
			});
			expect(Date.parse(line.startedAt as string)).toBeGreaterThanOrEqual(before);
			expect(Date.parse(line.endedAt as string)).toBeGreaterThanOrEqual(Date.parse(line.startedAt as string));
			expect(readRunsFile(stateDir)).toHaveLength(1);
		} finally {
			await host.close();
		}
	});

	it("says reported = true when report_run marked this role + slot during this process's life", async () => {
		const { host, stateDir } = await freshHost();
		try {
			markReportedRun("alpha", "sched-2");
			await host.submit("alpha", { content: "another round", requestId: "sched-2" });
			await (await host.conversation("alpha"))!.waitForIdle(context);
			const line = await runEndLine(stateDir);
			expect(line.reported).toBe(true);
		} finally {
			await host.close();
		}
	});

	it("each run gets its own line with its own slot and reported flag", async () => {
		const { host, stateDir } = await freshHost();
		try {
			await host.submit("alpha", { content: "first", requestId: "r-1" });
			await (await host.conversation("alpha"))!.waitForIdle(context);
			markReportedRun("alpha", "r-2");
			await host.submit("alpha", { content: "second", requestId: "r-2" });
			await (await host.conversation("alpha"))!.waitForIdle(context);
			const deadline = Date.now() + 3_000;
			while (readRunsFile(stateDir).filter((line) => line.kind === "run-end").length < 2 && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			const ends = readRunsFile(stateDir).filter((line) => line.kind === "run-end");
			expect(ends).toHaveLength(2);
			expect(ends[0]).toMatchObject({ role: "alpha", slot: "r-1", reported: false });
			expect(ends[1]).toMatchObject({ role: "alpha", slot: "r-2", reported: true });
		} finally {
			await host.close();
		}
	});

	it("an append error is logged and never fails the run", async () => {
		const { host, stateDir } = await freshHost();
		try {
			// A directory where the file belongs: the append fails with EISDIR.
			mkdirSync(join(stateDir, RUNS_FILENAME));
			const errors: string[] = [];
			vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => void errors.push(parts.map(String).join(" ")));
			await host.submit("alpha", { content: "still settles", requestId: "sched-3" });
			await (await host.conversation("alpha"))!.waitForIdle(context);
			await vi.waitFor(() => expect(errors.some((line) => /run-end line failed/.test(line))).toBe(true));
			// The run itself finished: the answer landed, the memory record and runEnded ran before the append.
			const entries = await (await host.conversation("alpha"))!.entries({ order: "ascending" }, 100, undefined, context);
			// (The report nudge may follow the run, so the answer is somewhere in the conversation, not necessarily last.)
			expect(JSON.stringify(entries.items)).toContain("Reply to: still settles");
			expect(readRunsFile(stateDir)).toEqual([]);
		} finally {
			await host.close();
		}
	});
});

/**
 * A real host with the real plumbing (so the real notify extension and its report_run tool), a role that declares
 * count names, and a faux model that calls report_run twice: once with an undeclared name, once with declared ones.
 */
async function countedHost(reportCounts: string[]): Promise<{ host: RoleHost; stateDir: string; stop(): Promise<void> }> {
	const stateDir = await makeStateDir();
	const rolesRootParent = mkdtempSync(join(tmpdir(), "sr-runreport-"));
	const rolesRoot = join(rolesRootParent, "roles");
	roots.push(rolesRootParent, stateDir);
	await writeRolesTree(rolesRoot, [{ name: "alpha", tools: ["coding", "notify"], reportCounts }]);
	const { enabled } = await loadRoles({ rolesRoot, stateDir });

	const credentials = new InMemoryCredentialStore();
	const models = createModels({ credentials });
	const route: FauxResponseStep = (request) => {
		const last = request.messages.findLast((message) => message.role !== "system");
		if (last?.role === "toolResult") return fauxAssistantMessage([fauxText("Report done.")]);
		const text = messageTextOf(last);
		if (text.includes("report-unknown-check")) {
			return fauxAssistantMessage(
				[fauxToolCall("report_run", { counts: { judged: 1, mails_read: 2 }, did: ["read the queue"], notCovered: "", proposals: 0 })],
				{ stopReason: "toolUse" },
			);
		}
		if (text.includes("report-declared-check")) {
			return fauxAssistantMessage(
				[fauxToolCall("report_run", { counts: { judged: 4 }, did: ["read the queue"], notCovered: "", proposals: 0 })],
				{ stopReason: "toolUse" },
			);
		}
		return fauxAssistantMessage([fauxText(`Reply to: ${text.slice(0, 60)}`)]);
	};
	const faux = fauxProvider({ tokensPerSecond: 4_000, models: [{ id: "m-1", contextWindow: 1_000_000 }] });
	models.setProvider(faux.provider);
	faux.setResponses(Array.from({ length: 16 }, () => route));

	// The plumbing reads the state dir from the environment when it builds the notify extension (production shape).
	const previous = process.env.STANDING_ROLES_STATE_DIR;
	process.env.STANDING_ROLES_STATE_DIR = stateDir;
	const plumbing = createPlumbing({
		integrations: createStubIntegrations(),
		notify: async () => undefined,
		carrierIntervalMs: 60_000,
		heartbeatIntervalMs: 60_000,
	});
	if (previous === undefined) delete process.env.STANDING_ROLES_STATE_DIR;
	else process.env.STANDING_ROLES_STATE_DIR = previous;

	const host = await openRoleHost({
		dbPath: join(stateDir, "roles.db"),
		stateDir,
		roles: enabled,
		defaultModel: { provider: "faux", modelId: "m-1" },
		hostModels: { models, credentials, problems: [] },
		plumbing,
	});
	await plumbing.start(host);
	return {
		host,
		stateDir,
		stop: async () => {
			await plumbing.stop();
			await host.close();
		},
	};
}

describe("a real report_run call from a role with declared counts", () => {
	it("refuses an undeclared count name, then accepts a report of the declared ones with the omitted name as 0", async () => {
		const { host, stateDir, stop } = await countedHost(["judged", "alerted"]);
		try {
			await host.submit("alpha", { content: "report-unknown-check", requestId: "counted-unknown" });
			await (await host.conversation("alpha"))!.waitForIdle(context);
			const refused = (await (await host.conversation("alpha"))!.entries({ order: "ascending" }, 100, undefined, context)).items.filter(
				(entry) => ToolResultEntry.is(entry),
			);
			expect(refused).toHaveLength(1);
			expect(refused[0]!.model?.[0]).toMatchObject({ isError: true });
			expect(JSON.stringify(refused[0]!.model?.[0])).toContain("unknown count name(s): mails_read");
			expect(JSON.stringify(refused[0]!.model?.[0])).toContain("Use only your declared counts: judged, alerted (0 when none).");
			expect(readRunsFile(stateDir).filter((line) => line.kind === "report")).toEqual([]);

			await host.submit("alpha", { content: "report-declared-check", requestId: "counted-declared" });
			await (await host.conversation("alpha"))!.waitForIdle(context);
			const reports = readRunsFile(stateDir).filter((line) => line.kind === "report");
			expect(reports).toHaveLength(1);
			expect(reports[0]).toMatchObject({ role: "alpha", slot: "counted-declared", counts: { judged: 4, alerted: 0 } });
		} finally {
			await stop();
		}
	});
});

describe("currentSlot (the host's knowledge the tool reports against)", () => {
	it("is undefined before the role's first run and the slot of the last submitted run after", async () => {
		const { host } = await freshHost();
		try {
			expect(host.currentSlot("alpha")).toBeUndefined();
			expect(host.currentSlot("nope")).toBeUndefined();
			await host.submit("alpha", { content: "one", requestId: "req-plain" });
			await (await host.conversation("alpha"))!.waitForIdle(context);
			expect(host.currentSlot("alpha")).toBe("req-plain");
			await host.submit("alpha", { content: "two", requestId: "req-id", step: "inbox:42" });
			await (await host.conversation("alpha"))!.waitForIdle(context);
			expect(host.currentSlot("alpha")).toBe("inbox:42");
		} finally {
			await host.close();
		}
	});
});

/**
 * A faux host whose model calls wait on a test-held gate: the first call starts the run and then hangs (a
 * pendingMarker on disk says when), and releasing the gate lets it — and every later call — finish normally.
 */
function makeGatedHostModels(): {
	hostModels: { models: ReturnType<typeof createModels>; credentials: InMemoryCredentialStore; problems: string[] };
	defaultModel: { provider: string; modelId: string };
	release(): void;
	marker: string;
} {
	const credentials = new InMemoryCredentialStore();
	const models = createModels({ credentials });
	const marker = join(mkdtempSync(join(tmpdir(), "sr-gated-")), "pending");
	roots.push(marker.slice(0, marker.lastIndexOf("/")));
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const step: FauxResponseStep = () => {
		writeFileSync(marker, new Date().toISOString(), "utf8");
		return gate.then(() => fauxAssistantMessage([fauxText("Reply to: the gated run")]));
	};
	const faux: FauxProviderHandle = fauxProvider({ tokensPerSecond: 4_000, models: [{ id: "m-1", contextWindow: 1_000_000 }] });
	models.setProvider(faux.provider);
	faux.setResponses(Array.from({ length: 16 }, () => step));
	return {
		hostModels: { models, credentials, problems: [] },
		defaultModel: { provider: "faux", modelId: "m-1" },
		release: () => release(),
		marker,
	};
}

describe("currentSlot under a queued follow-up", () => {
	it("a report during the FIRST run records the FIRST slot; the queued run's run-end says not reported", async () => {
		const stateDir = await makeStateDir();
		const rolesRootParent = mkdtempSync(join(tmpdir(), "sr-runreport-"));
		const rolesRoot = join(rolesRootParent, "roles");
		roots.push(rolesRootParent, stateDir);
		await writeRolesTree(rolesRoot, [{ name: "alpha" }]);
		const { enabled } = await loadRoles({ rolesRoot, stateDir });
		const gated = makeGatedHostModels();
		const host = await openRoleHost({
			dbPath: join(stateDir, "roles.db"),
			stateDir,
			roles: enabled,
			defaultModel: gated.defaultModel,
			hostModels: gated.hostModels,
		});
		try {
			// Run A starts and is genuinely busy (its model call is parked on the gate); run B queues behind it.
			await host.submit("alpha", { content: "the busy run", requestId: "run-a" });
			const deadline = Date.now() + 3_000;
			while (!existsSync(gated.marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
			expect(existsSync(gated.marker)).toBe(true);
			await host.submit("alpha", { content: "the queued run", requestId: "run-b" });

			// The finding: lastRuns already moved to run-b; currentSlot must still be the running run-a.
			expect(host.lastRun("alpha")?.slot).toBe("run-b"); // lastRuns/status behaviour unchanged
			expect(host.currentSlot("alpha")).toBe("run-a");

			// report_run during the first run: the report carries the first slot. No tracker injection — the tool
			// and the host share the process's default tracker, exactly as in production.
			const doc = { written: {} as Record<string, { response: Record<string, string>; slot?: string; atMs: number }> };
			const api = {
				conversationId: host.conversationId("alpha")!,
				callId: "call-during-a",
				snapshot: async () => doc,
				commit: async (change: (tx: { doc: () => unknown }) => unknown) => change({ doc: async () => doc }),
			};
			const report = reportRunTools({
				stateDir,
				roleForConversation: (id) => host.roleForConversation(String(id)),
				currentSlot: (roleName) => host.currentSlot(roleName),
			});
			const result = await report[0]!.execute(
				{ counts: { judged: 3 }, did: ["worked the queue"], notCovered: "", proposals: 0 } as never,
				api as never,
				undefined as never,
			);
			expect(result.isError).toBeUndefined();
			expect(JSON.parse((result.output as Array<{ text: string }>)[0].text)).toMatchObject({ status: "reported", slot: "run-a" });

			// Both runs settle; each run-end line carries the right reported flag.
			gated.release();
			await (await host.conversation("alpha"))!.waitForIdle(context);
			const endsDeadline = Date.now() + 3_000;
			let ends = [] as Array<{ slot: string; reported: boolean }>;
			for (;;) {
				ends = readRunsFile(stateDir)
					.filter((line) => line.kind === "run-end")
					.map((line) => ({ slot: line.slot, reported: line.reported }));
				if (ends.length >= 2 || Date.now() > endsDeadline) break;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			expect(ends).toHaveLength(2);
			const bySlot = new Map(ends.map((line) => [line.slot, line.reported]));
			expect(bySlot.get("run-a")).toBe(true);
			expect(bySlot.get("run-b")).toBe(false);

			// The FIFO drained: currentSlot falls back to lastRuns.
			expect(host.currentSlot("alpha")).toBe("run-b");
		} finally {
			// Release the gate before closing: a close with the model call parked would hang.
			gated.release();
			await host.close();
		}
	});
});
