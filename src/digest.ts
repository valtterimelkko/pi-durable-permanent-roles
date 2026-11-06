/**
 * The role digest: no model, no network. It joins `<stateDir>/runs.jsonl`
 * by role + slot, takes each role's named counts against its 7-day median, snapshots the roles' notes and diffs them,
 * reads the pending rule proposals, and renders the one notification message plus `<stateDir>/digest/<date>.{json,md}`.
 *
 * Everything here works on the paths it is given (so tests use a temp dir); the CLI (src/digest-cli.ts) is thin.
 * A run counts as reported when a `report` line with its role + slot exists: the `reported` flag alone is not trusted.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zoneDate } from "./host-time.ts";
import {
	DIGEST_DIRNAME,
	RUNS_FILENAME,
	type Digest,
	type DigestCount,
	type DigestNotesChange,
	type DigestRole,
	type RunEndLine,
	type RunReportLine,
	type RunsLine,
} from "./oversight-types.ts";

/** Snapshots live under `<stateDir>/digest/snapshots/<role>/<date>/`. */
export const SNAPSHOT_DIRNAME = "snapshots";
/** Snapshot folders older than this many days (today included) are deleted. */
export const SNAPSHOT_KEEP_DAYS = 14;
/** The notification message stays inside one readable message. */
export const NOTIFICATION_MAX_CHARS = 1_200;
/** Days of history the medians are taken over, before the window. */
export const HISTORY_DAYS = 7;
/** Fewer days than this with any report and no median is shown. */
export const MEDIAN_MIN_DAYS = 3;
/** Bounds of the rendered digest. */
export const DID_MAX = 10;
export const NOT_COVERED_MAX = 10;
export const PROPOSALS_MAX = 10;
export const SAMPLE_ADDED_MAX = 20;
export const SAMPLE_LINE_MAX = 200;
export const KEY_COUNTS_MAX = 3;
/** The role folder that is a template, never a role of the host. */
const SKIPPED_ROLE_FOLDERS = new Set(["example"]);

// ---------------------------------------------------------------- time

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A `YYYY-MM-DD` day shifted by whole days (calendar arithmetic, no time zone). */
export function shiftDate(day: string, days: number): string {
	const [y, m, d] = day.split("-").map(Number);
	return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

/** The digest window: the 24 hours ending at `now`, dated by its end date in the host's time zone. */
export function windowFor(now: Date): { startMs: number; endMs: number; date: string } {
	return { startMs: now.getTime() - 24 * 3_600_000, endMs: now.getTime(), date: zoneDate(now) };
}

// ---------------------------------------------------------------- records

/** `runs.jsonl` → its usable lines; a malformed or foreign line is skipped, never fatal. */
export function parseRunsLines(text: string): RunsLine[] {
	const lines: RunsLine[] = [];
	for (const raw of text.split("\n")) {
		const trimmed = raw.trim();
		if (trimmed === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (!isRecord(parsed) || typeof parsed.role !== "string" || typeof parsed.slot !== "string") continue;
		if (parsed.kind === "report" && typeof parsed.at === "string") {
			lines.push({
				v: 1,
				kind: "report",
				role: parsed.role,
				slot: parsed.slot,
				at: parsed.at,
				counts: isRecord(parsed.counts) ? numericCounts(parsed.counts) : {},
				did: Array.isArray(parsed.did) ? parsed.did.filter((line): line is string => typeof line === "string") : [],
				notCovered: typeof parsed.notCovered === "string" ? parsed.notCovered : "",
				proposals: typeof parsed.proposals === "number" && Number.isFinite(parsed.proposals) ? parsed.proposals : 0,
			});
		} else if (parsed.kind === "run-end" && typeof parsed.endedAt === "string") {
			lines.push({
				v: 1,
				kind: "run-end",
				role: parsed.role,
				slot: parsed.slot,
				startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : parsed.endedAt,
				endedAt: parsed.endedAt,
				reported: parsed.reported === true,
			});
		}
	}
	return lines;
}

/** Only the non-negative integers of a role's own count names (anything else is ignored). */
function numericCounts(raw: Record<string, unknown>): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const [name, value] of Object.entries(raw)) {
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) counts[name] = value;
	}
	return counts;
}

/** The runs record of a state dir; a missing file is an empty record, not an error. */
export function readRuns(stateDir: string): RunsLine[] {
	const path = join(stateDir, RUNS_FILENAME);
	if (!existsSync(path)) return [];
	return parseRunsLines(readFileSync(path, "utf8"));
}

/** The middle value of a non-empty list of numbers (lower middle for an even length). */
export function median(values: number[]): number {
	if (values.length === 0) throw new Error("median: empty list");
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

// ---------------------------------------------------------------- notes

/** A line-multiset difference: how many lines were added and removed, and the first added ones as a sample. */
export function diffLines(
	before: string[],
	after: string[],
): { added: number; removed: number; sampleAdded: string[] } {
	const remaining = new Map<string, number>();
	for (const line of before) remaining.set(line, (remaining.get(line) ?? 0) + 1);
	const added: string[] = [];
	for (const line of after) {
		const left = remaining.get(line) ?? 0;
		if (left > 0) remaining.set(line, left - 1);
		else added.push(line);
	}
	let removed = 0;
	for (const left of remaining.values()) removed += left;
	return {
		added: added.length,
		removed,
		// The sample is for reading: whitespace-only lines are in the counts but would render as empty bullets.
		sampleAdded: added
			.filter((line) => line.trim() !== "")
			.slice(0, SAMPLE_ADDED_MAX)
			.map((line) => line.slice(0, SAMPLE_LINE_MAX)),
	};
}

function markdownFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((entry) => entry.name);
}

/** A file's lines; the empty tail a trailing newline leaves is not a line of its own. */
function readLines(path: string): string[] {
	if (!existsSync(path)) return [];
	const lines = readFileSync(path, "utf8").split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

/** Copy a role's top-level `notes/*.md` into the snapshot folder for `date` (overwrites: a re-run stays idempotent). */
/** Copy a role's top-level notes into the snapshot folder for `date` (exported for the outside check's bundles). */
export function snapshotNotes(notesDir: string, snapshotDir: string): void {
	mkdirSync(snapshotDir, { recursive: true });
	for (const name of markdownFiles(notesDir)) copyFileSync(join(notesDir, name), join(snapshotDir, name));
}

/** The most recent snapshot folder of a role dated before `date`, or undefined when this is the first snapshot. */
export function previousSnapshot(roleSnapshotDir: string, date: string): string | undefined {
	if (!existsSync(roleSnapshotDir)) return undefined;
	const earlier = readdirSync(roleSnapshotDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name) && entry.name < date)
		.map((entry) => entry.name)
		.sort();
	const last = earlier.at(-1);
	return last === undefined ? undefined : join(roleSnapshotDir, last);
}

/** Snapshot folders older than the keep window, deleted (only inside this role's snapshots). */
function pruneSnapshots(roleSnapshotDir: string, date: string): void {
	if (!existsSync(roleSnapshotDir)) return;
	const cutoff = shiftDate(date, -(SNAPSHOT_KEEP_DAYS - 1));
	for (const entry of readdirSync(roleSnapshotDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
		if (entry.name < cutoff) rmSync(join(roleSnapshotDir, entry.name), { recursive: true, force: true });
	}
}

/** The notes files that changed between two snapshots; no changes at all when nothing differs. */
function diffSnapshots(beforeDir: string, afterDir: string): DigestNotesChange[] {
	const files = [...new Set([...markdownFiles(beforeDir), ...markdownFiles(afterDir)])].sort((a, b) => a.localeCompare(b));
	const changes: DigestNotesChange[] = [];
	for (const file of files) {
		const diff = diffLines(readLines(join(beforeDir, file)), readLines(join(afterDir, file)));
		if (diff.added === 0 && diff.removed === 0) continue;
		changes.push({ file, added: diff.added, removed: diff.removed, sampleAdded: diff.sampleAdded });
	}
	return changes;
}

/** The pending lines of a `RULE-PROPOSALS.md`: dated or bulleted, minus anything settled or declined. */
export function pendingProposals(text: string): string[] {
	const SETTLED = /declined|dropped|approved|accepted|\byes \d{4}-\d{2}-\d{2}/i;
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && (line.startsWith("- ") || /^\d{4}-\d{2}-\d{2}/.test(line)))
		.filter((line) => !SETTLED.test(line))
		.slice(0, PROPOSALS_MAX);
}

// ---------------------------------------------------------------- roles

interface RoleHeader {
	name: string;
	title: string;
	enabled: boolean;
	everyRunCounts: string[];
}

/** Every role folder with a settings.json, except the template; a broken settings.json still shows the folder. */
function discoverRoles(rolesDir: string): RoleHeader[] {
	if (!existsSync(rolesDir)) return [];
	const headers: RoleHeader[] = [];
	for (const entry of readdirSync(rolesDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		if (SKIPPED_ROLE_FOLDERS.has(entry.name)) continue;
		const settingsPath = join(rolesDir, entry.name, "settings.json");
		if (!existsSync(settingsPath)) continue;
		let settings: unknown;
		try {
			settings = JSON.parse(readFileSync(settingsPath, "utf8"));
		} catch {
			settings = undefined;
		}
		const raw = isRecord(settings) ? settings : {};
		headers.push({
			name: entry.name,
			title: typeof raw.title === "string" && raw.title.trim() !== "" ? raw.title.trim() : entry.name,
			enabled: raw.enabled === true,
			everyRunCounts: Array.isArray(raw.everyRunCounts)
				? raw.everyRunCounts.filter((name): name is string => typeof name === "string")
				: [],
		});
	}
	return headers.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- notification

/** The counts shown on a role's notification line: the biggest moves against the usual, else the first few names. */
function keyCounts(counts: DigestCount[]): DigestCount[] {
	const withMedian = counts
		.filter((count) => count.median7d !== null)
		.sort(
			(a, b) =>
				Math.abs(b.value - b.median7d!) - Math.abs(a.value - a.median7d!) || a.name.localeCompare(b.name),
		)
		.slice(0, KEY_COUNTS_MAX);
	if (withMedian.length === KEY_COUNTS_MAX) return withMedian;
	const chosen = new Set(withMedian.map((count) => count.name));
	return [...withMedian, ...counts.filter((count) => !chosen.has(count.name))].slice(0, KEY_COUNTS_MAX);
}

/** One count as `judged 4 (usual 3)`; without a median it is just `judged 4`. */
function countText(count: DigestCount): string {
	return count.median7d === null ? `${count.name} ${count.value}` : `${count.name} ${count.value} (usual ${count.median7d})`;
}

/** One enabled role's notification line. */
function roleLine(role: DigestRole): string {
	if (role.runs === 0) return `${role.title}: no runs ⚠`;
	const parts = [`${role.runs} runs`];
	const counts = keyCounts(role.counts);
	if (counts.length > 0) parts.push(counts.map(countText).join(", "));
	let line = `${role.title}: ${parts.join(" · ")}`;
	if (role.unreported > 0) line += ` ⚠ ${role.unreported} unreported`;
	if ((role.everyRunMisses?.length ?? 0) > 0) line += " ⚠ every-run";
	return line;
}

/** The one notification message (plain text): a line per enabled role, and the proposals waiting. */
export function notificationText(date: string, roles: DigestRole[]): string {
	const header = `Roles, last 24 h (${date})`;
	const enabled = roles.filter((role) => role.enabled).map(roleLine);
	const proposals = roles.reduce((total, role) => total + role.pendingProposals.length, 0);
	const footer = proposals > 0 ? [`Rule proposals waiting: ${proposals}`] : [];
	const size = (lines: string[]): number => lines.join("\n").length;
	let kept = [...enabled];
	while (kept.length > 0 && size([header, ...kept, ...footer]) > NOTIFICATION_MAX_CHARS) kept.pop();
	const dropped = enabled.length - kept.length;
	const marker = dropped > 0 ? [`… ${dropped} more roles`] : [];
	return [header, ...kept, ...marker, ...footer].join("\n");
}

// ---------------------------------------------------------------- markdown

function countsLine(counts: DigestCount[]): string {
	return counts.length === 0 ? "none" : counts.map(countText).join(", ");
}

function markdownRole(role: DigestRole): string {
	const out: string[] = [];
	out.push(`## ${role.title} (${role.role})${role.enabled ? "" : " — disabled"}`);
	out.push("");
	out.push(`${role.runs} runs · ${role.unreported} unreported`);
	out.push("");
	out.push(`Counts: ${countsLine(role.counts)}`);
	if (role.did.length > 0) {
		out.push("", "Did:");
		for (const line of role.did) out.push(`- ${line}`);
	}
	if (role.notCovered.length > 0) {
		out.push("", "Not covered:");
		for (const text of role.notCovered) out.push(`- ${text}`);
	}
	if ((role.everyRunMisses?.length ?? 0) > 0) {
		out.push("", "Every-run counts missed:");
		for (const miss of role.everyRunMisses!) out.push(`- ${miss}`);
	}
	if (role.notesChanges.length > 0) {
		out.push("", "Notes changes:");
		for (const change of role.notesChanges) {
			out.push(`- ${change.file} +${change.added} −${change.removed}`);
			for (const sample of change.sampleAdded) out.push(`  - ${sample}`);
		}
	}
	if (role.pendingProposals.length > 0) {
		out.push("", `Pending rule proposals (${role.pendingProposals.length}):`);
		for (const proposal of role.pendingProposals) out.push(`- ${proposal}`);
	}
	out.push("");
	return out.join("\n");
}

/** The readable rendering of a digest, one section per role. */
export function renderMarkdown(digest: Digest): string {
	const out: string[] = [];
	out.push(`# Roles digest — ${digest.date}`);
	out.push("");
	out.push(`Window: ${digest.windowStart} → ${digest.windowEnd}`);
	out.push("");
	for (const role of digest.roles) out.push(markdownRole(role));
	return out.join("\n");
}

// ---------------------------------------------------------------- build and write

export interface BuildOptions {
	/** The window end; defaults to now. */
	now?: Date;
	stateDir: string;
	rolesDir: string;
}

function countsFor(
	reports: RunReportLine[],
	windowEnd: number,
	windowStart: number,
	date: string,
): DigestCount[] {
	const windowSums = new Map<string, number>();
	const historyDays = Array.from({ length: HISTORY_DAYS }, (_, i) => shiftDate(date, i - HISTORY_DAYS));
	const dayIsReported = new Set<string>();
	const daySums = new Map<string, Map<string, number>>();
	for (const report of reports) {
		const at = new Date(report.at).getTime();
		if (Number.isNaN(at)) continue;
		const day = zoneDate(at);
		if (at >= windowStart && at <= windowEnd) {
			for (const [name, value] of Object.entries(report.counts)) {
				windowSums.set(name, (windowSums.get(name) ?? 0) + value);
			}
		}
		if (!historyDays.includes(day)) continue;
		dayIsReported.add(day);
		const sums = daySums.get(day) ?? new Map<string, number>();
		for (const [name, value] of Object.entries(report.counts)) sums.set(name, (sums.get(name) ?? 0) + value);
		daySums.set(day, sums);
	}
	const names = new Set<string>(windowSums.keys());
	for (const sums of daySums.values()) for (const name of sums.keys()) names.add(name);
	const hasHistory = dayIsReported.size >= MEDIAN_MIN_DAYS;
	return [...names]
		.sort((a, b) => a.localeCompare(b))
		.map((name) => ({
			name,
			value: windowSums.get(name) ?? 0,
			median7d: hasHistory ? median(historyDays.map((day) => daySums.get(day)?.get(name) ?? 0)) : null,
		}));
}

/** Slots that are not scheduled runs: an owner chat, an inbox message, a watch firing or a reference change. */
const UNSCHEDULED_SLOT = /^(chat|inbox|watch|refchange):/;

/** Whether a run slot is a scheduled run (the only runs everyRunCounts apply to). */
export function isScheduledSlot(slot: string): boolean {
	return !UNSCHEDULED_SLOT.test(slot);
}

/** One line per scheduled run whose newest report has an every-run count 0 or missing (reports newest first). */
export function missedEveryRun(reports: readonly RunReportLine[], names: readonly string[]): string[] {
	if (names.length === 0) return [];
	const misses: string[] = [];
	// Each slot is judged by its newest report: a run that re-reported after the every-run nudge is not a miss.
	const newest = new Map<string, RunReportLine>();
	for (const report of reports) {
		const seen = newest.get(report.slot);
		if (seen === undefined || report.at > seen.at) newest.set(report.slot, report);
	}
	for (const report of reports) {
		if (newest.get(report.slot) !== report) continue;
		if (UNSCHEDULED_SLOT.test(report.slot)) continue;
		for (const name of names) {
			const value = report.counts[name];
			if (value === undefined) misses.push(`${report.slot}: ${name} not reported (required every scheduled run)`);
			else if (value === 0) misses.push(`${report.slot}: ${name} 0 (required every scheduled run)`);
		}
	}
	return misses.slice(0, NOT_COVERED_MAX);
}

/** Build the digest: reads the records and notes, snapshots the notes, and renders the notification text. */
export async function buildDigest(options: BuildOptions): Promise<Digest> {
	const now = options.now ?? new Date();
	const window = windowFor(now);
	const lines = readRuns(options.stateDir);
	const ends = lines.filter((line): line is RunEndLine => line.kind === "run-end");
	const reports = lines.filter((line): line is RunReportLine => line.kind === "report");
	const snapshotsRoot = join(options.stateDir, DIGEST_DIRNAME, SNAPSHOT_DIRNAME);

	const discovered: DigestRole[] = discoverRoles(options.rolesDir).map((header) => {
		const roleReports = reports.filter((report) => report.role === header.name);
		const roleEnds = ends.filter((end) => end.role === header.name);
		const inWindow = (iso: string): boolean => {
			const ms = new Date(iso).getTime();
			return !Number.isNaN(ms) && ms >= window.startMs && ms <= window.endMs;
		};
		const windowEnds = roleEnds.filter((end) => inWindow(end.endedAt));
		const windowReports = roleReports.filter((report) => inWindow(report.at));
		// A slot name can repeat (watch:<name>, every firing), so a run counts as reported only by a report with its
		// slot made while it ran (a little slack after the end for clock and write order).
		const reportedDuring = (end: RunEndLine): boolean => {
			const from = new Date(end.startedAt).getTime();
			const to = new Date(end.endedAt).getTime() + REPORT_SLACK_MS;
			return roleReports.some((report) => {
				const at = new Date(report.at).getTime();
				return report.slot === end.slot && at >= from && at <= to;
			});
		};
		const unreported = windowEnds.filter((end) => !reportedDuring(end)).length;
		const newestFirst = [...windowReports].sort((a, b) => b.at.localeCompare(a.at));
		const did = newestFirst.flatMap((report) => report.did).slice(0, DID_MAX);
		const notCovered: string[] = [];
		for (const report of newestFirst) {
			const text = report.notCovered.trim();
			if (text !== "" && !notCovered.includes(text) && notCovered.length < NOT_COVERED_MAX) notCovered.push(text);
		}

		const everyRunMisses = missedEveryRun(newestFirst, header.everyRunCounts);

		// Notes: snapshot today's top-level notes, diff against the most recent earlier snapshot, then prune.
		const notesDir = join(options.stateDir, "roles", header.name, "notes");
		const roleSnapshots = join(snapshotsRoot, header.name);
		const todaySnapshot = join(roleSnapshots, window.date);
		snapshotNotes(notesDir, todaySnapshot);
		const earlier = previousSnapshot(roleSnapshots, window.date);
		const notesChanges = earlier === undefined ? [] : diffSnapshots(earlier, todaySnapshot);
		pruneSnapshots(roleSnapshots, window.date);

		const proposalsPath = join(notesDir, "RULE-PROPOSALS.md");
		return {
			role: header.name,
			title: header.title,
			enabled: header.enabled,
			runs: windowEnds.length,
			unreported,
			counts: countsFor(roleReports, window.endMs, window.startMs, window.date),
			did,
			notCovered,
			notesChanges,
			pendingProposals: existsSync(proposalsPath) ? pendingProposals(readFileSync(proposalsPath, "utf8")) : [],
			...(everyRunMisses.length === 0 ? {} : { everyRunMisses }),
		};
	});

	const digest: Digest = {
		v: 1,
		date: window.date,
		windowStart: new Date(window.startMs).toISOString(),
		windowEnd: new Date(window.endMs).toISOString(),
		roles: discovered,
		notification: notificationText(window.date, discovered),
	};
	return digest;
}

/** Write `<stateDir>/digest/<date>.json` and `.md`; returns both paths. */
export function writeDigest(stateDir: string, digest: Digest): { jsonPath: string; mdPath: string } {
	const dir = join(stateDir, DIGEST_DIRNAME);
	mkdirSync(dir, { recursive: true });
	const jsonPath = join(dir, `${digest.date}.json`);
	const mdPath = join(dir, `${digest.date}.md`);
	writeFileSync(jsonPath, `${JSON.stringify(digest, undefined, "\t")}\n`, "utf8");
	writeFileSync(mdPath, renderMarkdown(digest), "utf8");
	return { jsonPath, mdPath };
}

// ---------------------------------------------------------------- CLI arguments

export interface DigestArgs {
	now: Date;
	stateDir: string;
	rolesDir: string;
	send: boolean;
	/** Raise the digest's needs-you card when there is something to decide; off by default. */
	card: boolean;
}

/** How long after a run's end a report with its slot still counts for it. */
const REPORT_SLACK_MS = 2 * 60_000;

/** `[--now ISO] [--state-dir DIR] [--roles-dir DIR] [--send] [--card]`, with the host's defaults. */
export function parseDigestArgs(argv: string[], env: NodeJS.ProcessEnv, defaultRolesDir: string): DigestArgs {
	const args: DigestArgs = {
		now: new Date(),
		stateDir: env.STANDING_ROLES_STATE_DIR ?? "/var/lib/pi-roles",
		rolesDir: defaultRolesDir,
		send: false,
		card: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const value = (): string => {
			const next = argv[i + 1];
			if (next === undefined || next === "" || next.startsWith("--")) throw new Error(`${arg} needs a value`);
			i++;
			return next;
		};
		if (arg === "--now") {
			const iso = value();
			const now = new Date(iso);
			if (Number.isNaN(now.getTime())) throw new Error(`--now: not a date: ${iso}`);
			args.now = now;
		} else if (arg === "--state-dir") {
			args.stateDir = value();
		} else if (arg === "--roles-dir") {
			args.rolesDir = value();
		} else if (arg === "--send") {
			args.send = true;
		} else if (arg === "--card") {
			args.card = true;
		} else {
			throw new Error(`unknown argument: ${arg}`);
		}
	}
	return args;
}
