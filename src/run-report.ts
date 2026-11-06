/**
 * `report_run` — the tool in the `notify` group that ends every role run, and
 * the `runs.jsonl` append the host and the tool share. The line formats live in
 * `src/oversight-types.ts`: a `report` line when a role calls the tool, and a `run-end` line the host appends when
 * the run's submission settles.
 *
 * `<stateDir>/runs.jsonl` is append-only, one JSON object per line. The append is atomic per line: one `appendFile`
 * of a line under 4 KiB, so a crash cannot leave a half line behind; a longer report is refused before anything is
 * written. Replay safety mirrors raise_item: the durable written mark lands BEFORE the file append, keyed by
 * conversation + tool call id, so a replayed call never appends twice. A second `report_run` in the same run is
 * allowed (a different call id appends again); the digest lets the later one win.
 *
 * The run-end line's `reported` flag reads this process's report marks (a small in-memory set keyed role + slot):
 * whether report_run was called for this run during this process's life.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { arr, map, num, obj, str } from "@earendil-works/pi-schema";
import { defineDoc, defineTool, type Tx } from "@earendil-works/pi-durable";
import { baseEveryDeltas, LEDGER_BASE_DELTAS } from "./doc-checkpoint.ts";
import {
	REPORT_COUNTS_MAX,
	REPORT_COUNT_NAME_MAX,
	REPORT_DID_MAX,
	REPORT_LINE_TEXT_MAX,
	REPORT_NOT_COVERED_MAX,
	RUNS_FILENAME,
	type RunReportLine,
	type RunsLine,
} from "./oversight-types.ts";
import { LINE_MAX_BYTES } from "./needs-you.ts";
import type { RoleDefinition } from "./types.ts";

/** Written marks are kept this long for replay de-duplication, then pruned when the next report is marked. */
const WRITE_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

/** The durable de-duplication record: every report_run call this conversation has already completed. */
export const RunReportWrites = defineDoc<{
	written: Record<string, { response: Record<string, string>; slot?: string; atMs: number }>;
}>({
	kind: "pi-roles.run-report-writes",
	version: 1,
	scope: "session",
	initial: () => ({ written: {} }),
	// One write per report_run call; marks are pruned after seven days, the deltas are not: a periodic base bounds
	// the replay.
	checkpointWhen: baseEveryDeltas(LEDGER_BASE_DELTAS),
});

/**
 * Who remembers that a role + slot was reported: the run-end line's `reported` reads it. The module default is the
 * process's own set; tests inject per-"process" trackers to prove the crash-replay path.
 */
export type ReportedRunTracker = {
	/** counts: the report's named counts; a later report for the same slot replaces them (the every-run nudge). */
	mark(role: string, slot: string, counts?: Record<string, number>): void;
	has(role: string, slot: string): boolean;
	/** The newest reported counts for this role + slot in this process, or undefined. */
	counts(role: string, slot: string): Record<string, number> | undefined;
};

/** A fresh, empty tracker (what a restarted process starts with). */
export function makeReportedRunTracker(): ReportedRunTracker {
	const seen = new Map<string, Record<string, number> | undefined>();
	const key = (role: string, slot: string): string => `${role}\u0000${slot}`;
	return {
		mark: (role, slot, counts) => {
			const k = key(role, slot);
			if (counts !== undefined || !seen.has(k)) seen.set(k, counts);
		},
		has: (role, slot) => seen.has(key(role, slot)),
		counts: (role, slot) => seen.get(key(role, slot)),
	};
}

const defaultTracker = makeReportedRunTracker();

/** Record that the role's run in this slot was reported (called by the tool after the append landed). */
export function markReportedRun(role: string, slot: string, counts?: Record<string, number>): void {
	defaultTracker.mark(role, slot, counts);
}

/** The newest counts report_run recorded for this role + slot during this process's life, or undefined. */
export function reportedCounts(role: string, slot: string): Record<string, number> | undefined {
	return defaultTracker.counts(role, slot);
}

/** Whether report_run ran for this role + slot during this process's life (the run-end line's `reported`). */
export function reportedRun(role: string, slot: string): boolean {
	return defaultTracker.has(role, slot);
}

export type RunReportFields = {
	/** The role's own named counts, e.g. { judged: 34, alerted: 0 }. Non-negative integers. */
	counts: Record<string, number>;
	/** What it did, at most REPORT_DID_MAX short lines. */
	did: string[];
	/** What it could not do or check this run; "" when everything was covered. */
	notCovered: string;
	/** New rule proposals written to RULE-PROPOSALS.md this run. */
	proposals: number;
};

type RunReportArgs = {
	counts: unknown;
	did: unknown;
	notCovered: unknown;
	proposals: unknown;
};

const CONTROL_KEEPING_NL = /[^\P{C}\n]/gu;
const CONTROL_ALL = /[^\P{C}]/gu;

/** One-line text (count names, did lines): controls collapse, capped by refusal. */
function oneLine(value: unknown, field: string, max: number): string {
	if (typeof value !== "string") throw new Error(`${field} is required`);
	const cleaned = value.replace(CONTROL_ALL, " ").replace(/ {2,}/g, " ").trim();
	if (cleaned.length > max) throw new Error(`${field} must be at most ${max} characters (got ${cleaned.length})`);
	return cleaned;
}

/** Multi-line free text (notCovered): line breaks kept, other controls become spaces, capped by refusal; "" allowed. */
function freeText(value: unknown, field: string, max: number): string {
	if (typeof value !== "string") throw new Error(`${field} is required (use an empty string when everything was covered)`);
	const cleaned = value.replace(/\r/g, "").replace(CONTROL_KEEPING_NL, " ").trim();
	if (cleaned.length > max) throw new Error(`${field} must be at most ${max} characters (got ${cleaned.length})`);
	return cleaned;
}

/** A non-negative integer count (a `counts` value, `proposals`). */
function nonNegativeInteger(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new Error(`${field} must be a non-negative integer`);
	}
	return value;
}

/**
 * Validate one `report_run` call against the frozen bounds; throws with the refusal message.
 *
 * `declaredCounts` is the calling role's `reportCounts`: when it names any, a count
 * name outside that list is refused with the declared names quoted back, and a declared name the role left out is
 * recorded as 0 — so every report carries every declared name and the digest's median has one vocabulary. No
 * declaration (undefined or empty, which `{counts}` reads as "names of your own choosing") keeps the open list.
 */
export function validateRunReport(args: RunReportArgs, declaredCounts?: readonly string[]): RunReportFields {
	if (typeof args.counts !== "object" || args.counts === null || Array.isArray(args.counts)) {
		throw new Error("counts is required: an object of name → non-negative integer");
	}
	const entries = Object.entries(args.counts as Record<string, unknown>);
	if (entries.length > REPORT_COUNTS_MAX) {
		throw new Error(`counts must hold at most ${REPORT_COUNTS_MAX} named counts (got ${entries.length})`);
	}
	const declared = declaredCounts === undefined || declaredCounts.length === 0 ? undefined : declaredCounts;
	const supplied: Record<string, number> = {};
	const unknown: string[] = [];
	for (const [rawName, rawValue] of entries) {
		const name = oneLine(rawName, "count name", REPORT_COUNT_NAME_MAX);
		if (name === "") throw new Error("a count name must not be empty");
		if (declared !== undefined && !declared.includes(name)) {
			if (!unknown.includes(name)) unknown.push(name);
			continue;
		}
		supplied[name] = nonNegativeInteger(rawValue, `count '${name}'`);
	}
	if (unknown.length > 0 && declared !== undefined) {
		throw new Error(
			`unknown count name(s): ${unknown.join(", ")}. Use only your declared counts: ${declared.join(", ")} (0 when none).`,
		);
	}
	const counts: Record<string, number> = {};
	if (declared === undefined) Object.assign(counts, supplied);
	else for (const name of declared) counts[name] = supplied[name] ?? 0;
	if (!Array.isArray(args.did)) throw new Error("did is required: up to five short lines of what you did");
	if (args.did.length > REPORT_DID_MAX) {
		throw new Error(`did must hold at most ${REPORT_DID_MAX} lines (got ${args.did.length})`);
	}
	const did = args.did.map((entry, index) => {
		const line = oneLine(entry, `did line ${index + 1}`, REPORT_LINE_TEXT_MAX);
		if (line === "") throw new Error(`did line ${index + 1} must not be empty`);
		return line;
	});
	return {
		counts,
		did,
		notCovered: freeText(args.notCovered, "notCovered", REPORT_NOT_COVERED_MAX),
		proposals: nonNegativeInteger(args.proposals, "proposals"),
	};
}

/** The report line, with the frozen field order. */
export function serialiseRunReportLine(fields: RunReportFields, roleName: string, slot: string, atMs: number): string {
	const line: RunReportLine = {
		v: 1,
		kind: "report",
		role: roleName,
		slot,
		at: new Date(atMs).toISOString(),
		counts: fields.counts,
		did: fields.did,
		notCovered: fields.notCovered,
		proposals: fields.proposals,
	};
	return JSON.stringify(line);
}

/** The run-end line, with the frozen field order; the host appends it when a run's submission settles. */
export function serialiseRunEndLine(
	roleName: string,
	slot: string,
	startedAtIso: string,
	endedAtIso: string,
	reported: boolean,
): string {
	return JSON.stringify({ v: 1, kind: "run-end", role: roleName, slot, startedAt: startedAtIso, endedAt: endedAtIso, reported });
}

/** Append one line atomically: one `appendFile` of a line under 4 KiB, into a file created 0600. */
export async function appendRunsLine(stateDir: string, line: string): Promise<void> {
	if (Buffer.byteLength(line, "utf8") + 1 > LINE_MAX_BYTES) {
		throw new Error(
			`a ${RUNS_FILENAME} line must stay under ${LINE_MAX_BYTES} bytes so each append stays atomic`,
		);
	}
	mkdirSync(stateDir, { recursive: true });
	await appendFile(join(stateDir, RUNS_FILENAME), `${line}\n`, { mode: 0o600 });
}

/**
 * The host's run-end append: `startedAt` from the run's {atMs, slot}, `reported` from this process's report marks.
 * The caller (src/harness.ts) treats this as best effort — it catches and logs.
 */
export async function appendRunEndLine(
	stateDir: string,
	roleName: string,
	at: { atMs: number; slot: string },
	endedAtMs: number,
): Promise<void> {
	await appendRunsLine(
		stateDir,
		serialiseRunEndLine(
			roleName,
			at.slot,
			new Date(at.atMs).toISOString(),
			new Date(endedAtMs).toISOString(),
			reportedRun(roleName, at.slot),
		),
	);
}

export type RunsFileState = RunsLine[];

/** Read the file tolerantly: junk lines and a missing file are skipped, never thrown. */
export function readRunsFile(stateDir: string): RunsFileState {
	const lines: RunsFileState = [];
	let text: string;
	try {
		text = readFileSync(join(stateDir, RUNS_FILENAME), "utf8");
	} catch {
		return lines;
	}
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		try {
			const parsed = JSON.parse(line) as RunsLine;
			if ((parsed.kind === "report" || parsed.kind === "run-end") && typeof parsed.role === "string") {
				lines.push(parsed);
			}
		} catch {
			// A corrupt line never fails the readers; the digest skips it too.
		}
	}
	return lines;
}

/** Where runs.jsonl lives: the option, then the environment, then the production default. */
export function runsStateDir(options: { stateDir?: string }): string {
	return options.stateDir ?? process.env.STANDING_ROLES_STATE_DIR ?? "/var/lib/pi-roles";
}

function reply(body: Record<string, unknown>, isError = false) {
	return {
		output: [{ type: "text" as const, text: JSON.stringify(body) }],
		...(isError ? { isError: true } : {}),
	};
}

export type ReportRunToolOptions = {
	/** Where runs.jsonl lives (the host's state dir); the plumbing passes it. */
	stateDir?: string;
	now?: () => number;
	/** The role whose conversation a tool call belongs to (the plumbing's HostApi). */
	roleForConversation?(conversationId: string): RoleDefinition | undefined;
	/** The slot of the role's current run (the plumbing's HostApi; the host knows it from the last submit). */
	currentSlot?(roleName: string): string | undefined;
	/** Who remembers reported role+slot pairs; default this process's own set. */
	reportTracker?: ReportedRunTracker;
};

/**
 * The `report_run` tool, registered by the `notify` extension next to `notify_owner` and the needs-you tools. It
 * refuses in a conversation that is not a standing role, and it is replay-safe through the durable written mark.
 */
export function reportRunTools(options: ReportRunToolOptions = {}) {
	const now = options.now ?? Date.now;
	const stateDir = () => runsStateDir(options);
	const roleFor = options.roleForConversation;
	const slotFor = options.currentSlot;
	const tracker = options.reportTracker ?? defaultTracker;

	const reportTool = defineTool({
		name: "report_run",
		description:
			"Call once at the end of every run, as your last step: your named counts for this run, up to five short lines of what you did, what you could not do or check (empty when everything was covered), and how many new rule proposals you wrote. The owner's morning digest is built from these; a run without a report shows as 'ran, no report'.",
		parameters: obj(
			{
				// map() is pi-schema's Record: `additionalProperties` instead of TypeBox's `patternProperties`, same meaning
				// for string keys (the one intended wire difference; test/tool-schemas.test.ts allow-lists it).
				counts: map(num(), {
					description: "Your named counts for this run, e.g. { judged: 34, alerted: 0 } — non-negative integers, at most 12 names.",
				}),
				did: arr(str(), {
					description: "What you did this run: at most five short lines (200 characters each).",
				}),
				notCovered: str({
					description: "What you could not do or check this run; an empty string when everything was covered. At most 300 characters.",
				}),
				proposals: num({
					description: "How many new rule proposals you wrote to RULE-PROPOSALS.md this run.",
				}),
			},
			// Open like TypeBox's Type.Object was: an extra argument from the model stays accepted.
			{ open: true },
		),
		replay: "safe",
		execute: async (args: RunReportArgs, api, context) => {
			const role = roleFor?.(String(api.conversationId));
			if (role === undefined) {
				return reply(
					{ status: "refused", message: "This conversation is not a standing role, so it has no run to report." },
					true,
				);
			}
			const key = `${String(api.conversationId)}:${api.callId}`;
			const seen = await api.snapshot(RunReportWrites, context);
			const previous = seen?.written[key];
			if (previous !== undefined) {
				// The response is cached, but a restarted process's tracker is empty — mark the stored
				// slot so the run-end flag stays true after a crash-replay.
				const replayedSlot = previous.slot ?? (typeof previous.response.slot === "string" ? previous.response.slot : undefined);
				if (replayedSlot !== undefined) tracker.mark(role.name, replayedSlot);
				return reply(previous.response);
			}
			const slot = slotFor?.(role.name);
			if (slot === undefined) {
				return reply(
					{ status: "refused", message: "The host has no current run for your role, so there is nothing to report." },
					true,
				);
			}
			let fields: RunReportFields;
			try {
				fields = validateRunReport(args, role.settings.reportCounts);
			} catch (error) {
				return reply({ status: "refused", message: error instanceof Error ? error.message : String(error) }, true);
			}
			const line = serialiseRunReportLine(fields, role.name, slot, now());
			const bytes = Buffer.byteLength(line, "utf8") + 1;
			if (bytes > LINE_MAX_BYTES) {
				return reply(
					{
						status: "refused",
						message: `The report line would be ${bytes} bytes; a runs.jsonl line must stay under ${LINE_MAX_BYTES} bytes so each append stays atomic — shorten the did lines or notCovered.`,
					},
					true,
				);
			}
			const response = { status: "reported", slot, file: join(stateDir(), RUNS_FILENAME) };
			// The durable mark lands BEFORE the append (like raise_item): a replay never appends twice. The slot is
			// stored beside the response so a replay after a crash can mark it reported.
			await api.commit(
				(tx) =>
					tx.doc(RunReportWrites).then((doc) => {
						doc.written[key] = { response, slot, atMs: now() };
						for (const [stale, mark] of Object.entries(doc.written)) {
							if (now() - mark.atMs > WRITE_RETENTION_MS) delete doc.written[stale];
						}
					}),
				context,
			);
			await appendRunsLine(stateDir(), line);
			tracker.mark(role.name, slot, fields.counts);
			return reply(response);
		},
	});

	return [reportTool];
}
