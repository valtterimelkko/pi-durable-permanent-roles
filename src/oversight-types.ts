/**
 * Oversight record formats.
 *
 * `<stateDir>/runs.jsonl` is append-only, one JSON object per line, written only by the host: a `report` line when a
 * role calls `report_run`, and a `run-end` line for every run when its conversation goes idle. The digest
 * (`bin/roles-digest`) joins them by role + slot.
 *
 * `<stateDir>/digest/<YYYY-MM-DD>.json` is the digest the morning notification line is built from.
 */

export const RUNS_FILENAME = "runs.jsonl";
export const DIGEST_DIRNAME = "digest";

/** Bounds of a report: small enough that a line stays under one 4 KiB block. */
export const REPORT_COUNTS_MAX = 12;
export const REPORT_COUNT_NAME_MAX = 40;
export const REPORT_DID_MAX = 5;
export const REPORT_LINE_TEXT_MAX = 200;
export const REPORT_NOT_COVERED_MAX = 300;

/** Written when the role calls report_run (once per run, at its end). */
export interface RunReportLine {
	v: 1;
	kind: "report";
	role: string;
	/** The run's slot as the host knows it (schedule slot id, inbox:<id>, watch:<name>, chat:<iso>). */
	slot: string;
	/** ISO time of the call. */
	at: string;
	/** The role's own named counts, e.g. { judged: 34, alerted: 0 }. Non-negative integers. */
	counts: Record<string, number>;
	/** What it did, at most REPORT_DID_MAX short lines. */
	did: string[];
	/** What it could not do or check this run; "" when everything was covered. */
	notCovered: string;
	/** New rule proposals written to RULE-PROPOSALS.md this run. */
	proposals: number;
}

/** Written by the host for every run when the conversation goes idle after it. */
export interface RunEndLine {
	v: 1;
	kind: "run-end";
	role: string;
	slot: string;
	startedAt: string;
	endedAt: string;
	/** True when a report line for this role + slot was written during the run. */
	reported: boolean;
}

export type RunsLine = RunReportLine | RunEndLine;

/** One count with its usual range. */
export interface DigestCount {
	name: string;
	/** Sum over the window. */
	value: number;
	/** Median of the daily sums over the previous 7 days; null when fewer than 3 days of history. */
	median7d: number | null;
}

/** One notes file that changed since the previous snapshot. */
export interface DigestNotesChange {
	file: string;
	added: number;
	removed: number;
	/** Up to 20 added lines, each cut to 200 characters. */
	sampleAdded: string[];
}

export interface DigestRole {
	role: string;
	title: string;
	enabled: boolean;
	runs: number;
	/** Runs that ended without a report. */
	unreported: number;
	counts: DigestCount[];
	/** The did-lines of the window's reports, newest first, at most 10. */
	did: string[];
	/** Non-empty notCovered texts of the window. */
	notCovered: string[];
	notesChanges: DigestNotesChange[];
	/** Pending proposals read from RULE-PROPOSALS.md (raw lines, at most 10). */
	pendingProposals: string[];
	/**
	 * Scheduled runs whose `everyRunCounts` (role settings) were 0 or missing, newest first; absent when the role
	 * declares none or none was missed. A mechanical check: a rule written twice was still skipped in real runs.
	 */
	everyRunMisses?: string[];
}

export interface Digest {
	v: 1;
	/** The digest's date in the host's time zone (the morning it is read). */
	date: string;
	windowStart: string;
	windowEnd: string;
	roles: DigestRole[];
	/** The one notification message, as sent. */
	notification: string;
	/** Needs-you item id raised for this digest, if any. */
	cardId?: string;
}
