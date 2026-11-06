/**
 * The `report_run` tool and the `runs.jsonl` append (the line formats live in src/oversight-types.ts).
 *
 * Replay safety mirrors raise_item: the durable written mark lands BEFORE the file append, keyed by conversation +
 * tool call id, so a replayed call returns the first response and never appends twice. A second report in the same
 * run is allowed (a different call id): the digest lets the later one win. The tests drive the tool through a
 * scripted store and a temp state directory; no test touches the live state directory.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import {
	REPORT_COUNTS_MAX,
	REPORT_COUNT_NAME_MAX,
	REPORT_DID_MAX,
	REPORT_LINE_TEXT_MAX,
	REPORT_NOT_COVERED_MAX,
	RUNS_FILENAME,
} from "../src/oversight-types.ts";
import { LINE_MAX_BYTES } from "../src/needs-you.ts";
import { notifyExtension } from "../src/notify.ts";
import type { RoleDefinition } from "../src/types.ts";
import {
	appendRunsLine,
	makeReportedRunTracker,
	runsStateDir,
	readRunsFile,
	reportedRun,
	reportRunTools,
	serialiseRunReportLine,
	validateRunReport,
	type ReportedRunTracker,
} from "../src/run-report.ts";

const conversation = 11 as ConversationId;
const nowMs = Date.UTC(2026, 9, 28, 7, 30); // 07:30 in London (GMT)

function role(name: string): RoleDefinition {
	return {
		name,
		dir: `/srv/standing-roles/roles/${name}`,
		settings: {
			enabled: true,
			title: `${name} title`,
			boardName: `role-${name}`,
			schedule: [],
			cwd: `/srv/standing-roles/roles/${name}`,
			tools: ["notify"],
		},
		model: { provider: "zai", modelId: "glm-5.3-flash" },
		thinking: "high",
		instructions: "",
		notesDir: `/var/lib/pi-roles/roles/${name}/notes`,
	};
}

const docs = role("docs");

/** A role that declares its count names (`reportCounts`), as three real roles do. */
const counted: RoleDefinition = {
	...docs,
	name: "counted",
	settings: { ...docs.settings, reportCounts: ["judged", "alerted"] },
};

/** A temp state directory per test, removed afterwards. */
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempStateDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "run-report-"));
	dirs.push(dir);
	return dir;
}

/** A scripted stand-in for the durable store behind one tool call, keyed by conversation + call id. */
function fakeApi(callId = "call-1", conversationId: ConversationId = conversation) {
	const doc = { written: {} as Record<string, { response: Record<string, string>; atMs: number }> };
	return {
		api: {
			conversationId,
			callId,
			snapshot: async () => doc,
			commit: async (change: (tx: { doc: () => unknown }) => unknown) => change({ doc: async () => doc }),
		},
		doc,
	};
}

function tool(
	stateDir: string,
	options: { caller?: RoleDefinition | null; slot?: string | null; callId?: string; tracker?: ReportedRunTracker } = {},
) {
	const tools = reportRunTools({
		stateDir,
		now: () => nowMs,
		roleForConversation:
			options.caller === null ? undefined : () => options.caller ?? docs,
		currentSlot: options.slot === null ? undefined : () => options.slot ?? "sched-2026-10-28",
		...(options.tracker !== undefined ? { reportTracker: options.tracker } : {}),
	});
	const report = tools.find((candidate) => candidate.name === "report_run");
	expect(report).toBeDefined();
	const target = report!;
	return {
		execute: (args: Record<string, unknown>, api: unknown) => target.execute(args as never, api as never, undefined as never),
	};
}

function lines(stateDir: string): unknown[] {
	return readFileSync(join(stateDir, RUNS_FILENAME), "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line));
}

function responseOf(result: { output?: unknown }): Record<string, unknown> {
	return JSON.parse((result.output as Array<{ text: string }>)[0].text) as Record<string, unknown>;
}

const goodArgs = {
	counts: { judged: 34, alerted: 2 },
	did: ["Judged every queued post", "Alerted on two accounts"],
	notCovered: "",
	proposals: 0,
};

describe("frozen shape", () => {
	it("matches the bounds the parent froze", () => {
		expect(RUNS_FILENAME).toBe("runs.jsonl");
		expect(REPORT_COUNTS_MAX).toBe(12);
		expect(REPORT_COUNT_NAME_MAX).toBe(40);
		expect(REPORT_DID_MAX).toBe(5);
		expect(REPORT_LINE_TEXT_MAX).toBe(200);
		expect(REPORT_NOT_COVERED_MAX).toBe(300);
		expect(LINE_MAX_BYTES).toBe(4_096);
	});

	it("report_run sits in the notify group beside notify_owner and the needs-you tools", () => {
		const names = notifyExtension().tools?.map((candidate) => candidate.name) ?? [];
		expect(names).toContain("notify_owner");
		expect(names).toContain("raise_item");
		expect(names).toContain("resolve_item");
		expect(names).toContain("report_run");
	});
});

describe("the state dir", () => {
	it("resolves from the option, then the environment, then the production default", () => {
		expect(runsStateDir({ stateDir: "/tmp/a" })).toBe("/tmp/a");
		const previous = process.env.STANDING_ROLES_STATE_DIR;
		process.env.STANDING_ROLES_STATE_DIR = "/tmp/from-env";
		try {
			expect(runsStateDir({})).toBe("/tmp/from-env");
		} finally {
			if (previous === undefined) delete process.env.STANDING_ROLES_STATE_DIR;
			else process.env.STANDING_ROLES_STATE_DIR = previous;
		}
		delete process.env.STANDING_ROLES_STATE_DIR;
		expect(runsStateDir({})).toBe("/var/lib/pi-roles");
	});
});

describe("report_run", () => {
	it("appends one report line with the role, the current run's slot and the frozen field order", async () => {
		const stateDir = tempStateDir();
		const harness = tool(stateDir, { slot: "sched-06:30" });
		const result = await harness.execute(goodArgs, fakeApi().api);
		expect(result.isError).toBeUndefined();
		expect(responseOf(result)).toEqual({
			status: "reported",
			slot: "sched-06:30",
			file: join(stateDir, RUNS_FILENAME),
		});
		const parsed = lines(stateDir) as Array<Record<string, unknown>>;
		expect(parsed).toHaveLength(1);
		expect(Object.keys(parsed[0])).toEqual(["v", "kind", "role", "slot", "at", "counts", "did", "notCovered", "proposals"]);
		expect(parsed[0]).toEqual({
			v: 1,
			kind: "report",
			role: "docs",
			slot: "sched-06:30",
			at: new Date(nowMs).toISOString(),
			counts: { judged: 34, alerted: 2 },
			did: ["Judged every queued post", "Alerted on two accounts"],
			notCovered: "",
			proposals: 0,
		});
		// The file was created private to the host.
		expect(statSync(join(stateDir, RUNS_FILENAME)).mode & 0o777).toBe(0o600);
	});

	it("marks role+slot as reported for the run-end line", async () => {
		const stateDir = tempStateDir();
		const harness = tool(stateDir, { slot: "inbox:42" });
		expect(reportedRun("docs", "inbox:42")).toBe(false);
		await harness.execute(goodArgs, fakeApi().api);
		expect(reportedRun("docs", "inbox:42")).toBe(true);
		expect(reportedRun("docs", "sched-other")).toBe(false);
	});

	it("refuses outside a role conversation, writing nothing", async () => {
		const stateDir = tempStateDir();
		const harness = tool(stateDir, { caller: null });
		const result = await harness.execute(goodArgs, fakeApi().api);
		expect(result.isError).toBe(true);
		expect(responseOf(result).message).toMatch(/not a standing role/);
		expect(existsSync(join(stateDir, RUNS_FILENAME))).toBe(false);
	});

	it("refuses when the host has no current run for the role, writing nothing", async () => {
		const stateDir = tempStateDir();
		const harness = tool(stateDir, { slot: null });
		const result = await harness.execute(goodArgs, fakeApi().api);
		expect(result.isError).toBe(true);
		expect(responseOf(result).message).toMatch(/no current run/);
		expect(existsSync(join(stateDir, RUNS_FILENAME))).toBe(false);
	});

	it("a replayed call (same conversation + call id) returns the first response and never appends twice", async () => {
		const stateDir = tempStateDir();
		const harness = tool(stateDir);
		const api = fakeApi();
		const first = await harness.execute(goodArgs, api.api);
		expect(first.isError).toBeUndefined();
		const replay = await harness.execute({ ...goodArgs, counts: { judged: 99 } }, api.api);
		expect(replay.isError).toBeUndefined();
		expect(responseOf(replay)).toEqual(responseOf(first));
		expect(lines(stateDir)).toHaveLength(1);
	});

	it("a replay after a crash marks the stored slot reported, so the run-end flag stays true", async () => {
		const stateDir = tempStateDir();
		// One durable store (the doc), two "processes": each process has its own tracker, and the first
		// process's tracker dies with it. The durable mark of the first call survives the "crash".
		const durable = fakeApi();
		const firstProcess = makeReportedRunTracker();
		const restartedProcess = makeReportedRunTracker();
		const call = (tracker: ReportedRunTracker) =>
			tool(stateDir, { tracker }).execute(goodArgs, durable.api);

		const first = await call(firstProcess);
		expect(first.isError).toBeUndefined();
		expect(firstProcess.has(docs.name, "sched-2026-10-28")).toBe(true);
		expect(restartedProcess.has(docs.name, "sched-2026-10-28")).toBe(false);

		// The replay in the restarted process: cached response, and the stored slot is marked reported again.
		const replay = await call(restartedProcess);
		expect(replay.isError).toBeUndefined();
		expect(responseOf(replay)).toEqual(responseOf(first));
		expect(restartedProcess.has(docs.name, "sched-2026-10-28")).toBe(true);
		expect(lines(stateDir)).toHaveLength(1);
	});

	it("a second report in the same run (a different call id) appends again; the later one wins in the digest", async () => {
		const stateDir = tempStateDir();
		const harness = tool(stateDir);
		await harness.execute(goodArgs, fakeApi("call-1").api);
		await harness.execute({ ...goodArgs, counts: { judged: 40 } }, fakeApi("call-2").api);
		const parsed = lines(stateDir) as Array<{ counts: Record<string, number> }>;
		expect(parsed).toHaveLength(2);
		expect(parsed[1].counts).toEqual({ judged: 40 });
	});
});

describe("report_run validation refusals (clear message, nothing written)", () => {
	it("refuses counts that are not an object, over the cap, or carry a bad name or value", async () => {
		const stateDir = tempStateDir();
		const harness = tool(stateDir);
		const twelve = Object.fromEntries(Array.from({ length: REPORT_COUNTS_MAX }, (_, i) => [`count${i}`, 1]));
		const longName = "x".repeat(REPORT_COUNT_NAME_MAX + 1);
		for (const [args, pattern] of [
			[{ ...goodArgs, counts: "three" }, /counts/],
			[{ ...goodArgs, counts: null }, /counts/],
			[{ ...goodArgs, counts: { ...twelve, extra: 1 } }, /at most 12/],
			[{ ...goodArgs, counts: { "": 1 } }, /count name/],
			[{ ...goodArgs, counts: { [longName]: 1 } }, /count name/],
			[{ ...goodArgs, counts: { judged: 1.5 } }, /non-negative integer/],
			[{ ...goodArgs, counts: { judged: -1 } }, /non-negative integer/],
			[{ ...goodArgs, counts: { judged: "34" } }, /non-negative integer/],
		] as Array<[Record<string, unknown>, RegExp]>) {
			const result = await harness.execute(args, fakeApi().api);
			expect(result.isError, JSON.stringify(args.counts)).toBe(true);
			expect(responseOf(result).message, JSON.stringify(args.counts)).toMatch(pattern);
		}
		expect(existsSync(join(stateDir, RUNS_FILENAME))).toBe(false);
	});

	it("refuses a did that is not an array of at most five short non-empty lines", async () => {
		const stateDir = tempStateDir();
		const harness = tool(stateDir);
		for (const [args, pattern] of [
			[{ ...goodArgs, did: "one thing" }, /did/],
			[{ ...goodArgs, did: Array.from({ length: REPORT_DID_MAX + 1 }, () => "line") }, /at most 5/],
			[{ ...goodArgs, did: ["ok", "   "] }, /did line 2/],
			[{ ...goodArgs, did: ["ok", "x".repeat(REPORT_LINE_TEXT_MAX + 1)] }, /did line 2/],
			[{ ...goodArgs, did: ["ok", 7] }, /did line 2/],
		] as Array<[Record<string, unknown>, RegExp]>) {
			const result = await harness.execute(args, fakeApi().api);
			expect(result.isError, JSON.stringify(args.did)).toBe(true);
			expect(responseOf(result).message, JSON.stringify(args.did)).toMatch(pattern);
		}
		expect(existsSync(join(stateDir, RUNS_FILENAME))).toBe(false);
	});

	it("refuses a notCovered over the cap and a proposals that is not a non-negative integer", async () => {
		const stateDir = tempStateDir();
		const harness = tool(stateDir);
		for (const [args, pattern] of [
			[{ ...goodArgs, notCovered: "x".repeat(REPORT_NOT_COVERED_MAX + 1) }, /notCovered/],
			[{ ...goodArgs, proposals: -1 }, /proposals/],
			[{ ...goodArgs, proposals: 2.5 }, /proposals/],
			[{ ...goodArgs, proposals: "one" }, /proposals/],
		] as Array<[Record<string, unknown>, RegExp]>) {
			const result = await harness.execute(args, fakeApi().api);
			expect(result.isError, JSON.stringify(args)).toBe(true);
			expect(responseOf(result).message, JSON.stringify(args)).toMatch(pattern);
		}
		expect(existsSync(join(stateDir, RUNS_FILENAME))).toBe(false);
	});

	it("cleans control characters: did lines stay one line, notCovered keeps line breaks", async () => {
		const fields = validateRunReport({
			counts: { "judged\r\ntoday": 1 },
			did: ["first\rsecond\u0000third"],
			notCovered: "could not check\r\nthe archive",
			proposals: 0,
		});
		expect(Object.keys(fields.counts)).toEqual(["judged today"]);
		expect(fields.did).toEqual(["first second third"]);
		expect(fields.notCovered).toBe("could not check\nthe archive");
	});

	it("refuses the whole report when the line would not be one atomic append", async () => {
		const stateDir = tempStateDir();
		const harness = tool(stateDir);
		const wide = "€".repeat(REPORT_LINE_TEXT_MAX); // 3-byte characters: the JSON line alone exceeds 4 KiB
		const result = await harness.execute(
			{
				counts: Object.fromEntries(Array.from({ length: REPORT_COUNTS_MAX }, (_, i) => ["€".repeat(REPORT_COUNT_NAME_MAX), i])),
				did: Array.from({ length: REPORT_DID_MAX }, () => wide),
				notCovered: "€".repeat(REPORT_NOT_COVERED_MAX),
				proposals: 0,
			},
			fakeApi().api,
		);
		expect(result.isError).toBe(true);
		expect(responseOf(result).message).toMatch(/atomic/);
		expect(existsSync(join(stateDir, RUNS_FILENAME))).toBe(false);
	});
});

describe("the role's declared count names", () => {
	it("refuses a count name the role did not declare, naming it and listing the declared names exactly", async () => {
		const stateDir = tempStateDir();
		const harness = tool(stateDir, { caller: counted });
		const result = await harness.execute({ ...goodArgs, counts: { judged: 1, mails_read: 2 } }, fakeApi().api);
		expect(result.isError).toBe(true);
		expect(responseOf(result).message).toBe(
			"unknown count name(s): mails_read. Use only your declared counts: judged, alerted (0 when none).",
		);
		expect(existsSync(join(stateDir, RUNS_FILENAME))).toBe(false);
	});

	it("names every unknown count when a report carries more than one", async () => {
		const stateDir = tempStateDir();
		const harness = tool(stateDir, { caller: counted });
		const result = await harness.execute(
			{ ...goodArgs, counts: { judged: 1, mails_read: 2, teams_chats_read: 3 } },
			fakeApi().api,
		);
		expect(result.isError).toBe(true);
		expect(responseOf(result).message).toMatch(/^unknown count name\(s\): mails_read, teams_chats_read\./);
		expect(existsSync(join(stateDir, RUNS_FILENAME))).toBe(false);
	});

	it("records a declared name the role left out as 0, so every declared name is in the report", async () => {
		const stateDir = tempStateDir();
		const harness = tool(stateDir, { caller: counted });
		const result = await harness.execute({ ...goodArgs, counts: { judged: 5 } }, fakeApi().api);
		expect(result.isError).toBeUndefined();
		const parsed = lines(stateDir) as Array<{ counts: Record<string, number> }>;
		expect(parsed).toHaveLength(1);
		expect(Object.keys(parsed[0].counts)).toEqual(["judged", "alerted"]);
		expect(parsed[0].counts).toEqual({ judged: 5, alerted: 0 });
	});

	it("a role with no reportCounts still chooses its own names (an empty declaration restricts nothing either)", async () => {
		const stateDir = tempStateDir();
		const plain = await tool(stateDir, { caller: docs }).execute({ ...goodArgs, counts: { mails_read: 2 } }, fakeApi("plain").api);
		expect(plain.isError).toBeUndefined();
		expect((lines(stateDir) as Array<{ counts: Record<string, number> }>)[0].counts).toEqual({ mails_read: 2 });
		expect(Object.keys(validateRunReport({ ...goodArgs, counts: { mails_read: 2 } }, []).counts)).toEqual(["mails_read"]);
	});

	it("keeps the existing bounds with a declaration: bad value, long name and the name cap are still refused", async () => {
		const declared = ["judged", "alerted"];
		expect(() => validateRunReport({ ...goodArgs, counts: { judged: -1 } }, declared)).toThrow(/non-negative integer/);
		expect(() =>
			validateRunReport({ ...goodArgs, counts: { ["x".repeat(REPORT_COUNT_NAME_MAX + 1)]: 1 } }, declared),
		).toThrow(/count name/);
		const twelve = Object.fromEntries(Array.from({ length: REPORT_COUNTS_MAX }, (_, i) => [`count${i}`, 1]));
		expect(() => validateRunReport({ ...goodArgs, counts: { ...twelve, extra: 1 } }, declared)).toThrow(/at most 12/);
		// An undeclared name is refused as unknown before its value is judged (base said "must be a non-negative integer").
		expect(() => validateRunReport({ ...goodArgs, counts: { mails_read: -1 } }, declared)).toThrow(/unknown count name/);
	});
});

describe("the runs.jsonl file helpers", () => {
	it("appendRunsLine refuses an over-long line and appends a short one", async () => {
		const stateDir = tempStateDir();
		await expect(appendRunsLine(stateDir, "x".repeat(LINE_MAX_BYTES))).rejects.toThrow(/atomic/);
		await appendRunsLine(stateDir, serialiseRunReportLine({ counts: {}, did: [], notCovered: "", proposals: 0 }, "docs", "s1", nowMs));
		expect(lines(stateDir)).toHaveLength(1);
	});

	it("readRunsFile tolerates a missing file and junk lines", () => {
		const stateDir = tempStateDir();
		expect(readRunsFile(stateDir)).toEqual([]);
		mkdirSync(stateDir, { recursive: true });
		const file = join(stateDir, RUNS_FILENAME);
		rmSync(file, { force: true });
		writeFileSync(file, "not json\n\n{\"v\":1,\"kind\":\"run-end\",\"role\":\"docs\",\"slot\":\"s\",\"startedAt\":\"a\",\"endedAt\":\"b\",\"reported\":false}\n", "utf8");
		const parsed = readRunsFile(stateDir);
		expect(parsed).toHaveLength(1);
		expect(parsed[0]).toMatchObject({ kind: "run-end", role: "docs", slot: "s" });
	});
});
