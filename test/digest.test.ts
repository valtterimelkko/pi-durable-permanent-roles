/**
 * The digest: pure functions over fixture state dirs in a temp folder. Never the
 * live state directory, never a network call, never a model.
 */
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunEndLine, RunReportLine } from "../src/oversight-types.ts";
import { zoneDate } from "../src/host-time.ts";
import {
	buildDigest,
	diffLines,
	notificationText,
	NOTIFICATION_MAX_CHARS,
	parseDigestArgs,
	parseRunsLines,
	pendingProposals,
	renderMarkdown,
	windowFor,
	writeDigest,
	SNAPSHOT_KEEP_DAYS,
} from "../src/digest.ts";

const NOW = new Date("2026-10-28T06:30:00.000Z");

const report = (role: string, slot: string, at: string, fields: Partial<RunReportLine> = {}): RunReportLine => ({
	v: 1,
	kind: "report",
	role,
	slot,
	at,
	counts: {},
	did: [],
	notCovered: "",
	proposals: 0,
	...fields,
});

const end = (role: string, slot: string, endedAt: string, fields: Partial<RunEndLine> = {}): RunEndLine => ({
	v: 1,
	kind: "run-end",
	role,
	slot,
	startedAt: new Date(new Date(endedAt).getTime() - 20 * 60_000).toISOString(),
	endedAt,
	reported: false,
	...fields,
});

async function tempRoot(): Promise<string> {
	return mkdtemp(join(tmpdir(), "sr-digest-"));
}

/** A state dir with runs.jsonl and per-role notes; a roles/ tree alongside it. */
async function fixture(): Promise<{ stateDir: string; rolesDir: string }> {
	const root = await tempRoot();
	const stateDir = join(root, "state");
	const rolesDir = join(root, "roles");
	await mkdir(stateDir, { recursive: true });
	await mkdir(rolesDir, { recursive: true });
	return { stateDir, rolesDir };
}

async function writeRole(
	rolesDir: string,
	name: string,
	settings: { title?: string; enabled?: boolean; everyRunCounts?: string[] } | undefined,
): Promise<void> {
	const dir = join(rolesDir, name);
	await mkdir(dir, { recursive: true });
	if (settings === undefined) {
		await writeFile(join(dir, "instructions.md"), "Do the thing.\n", "utf8");
		return;
	}
	await writeFile(
		join(dir, "settings.json"),
		JSON.stringify({
			enabled: settings.enabled ?? true,
			title: settings.title ?? name,
			boardName: `role-${name}`,
			schedule: [{ at: "07:40", days: "daily" }],
			cwd: "/root",
			tools: ["coding"],
			...(settings.everyRunCounts === undefined ? {} : { everyRunCounts: settings.everyRunCounts }),
		}),
		"utf8",
	);
	await writeFile(join(dir, "instructions.md"), "Do the thing.\n", "utf8");
}

async function writeNotes(stateDir: string, role: string, files: Record<string, string>): Promise<void> {
	const dir = join(stateDir, "roles", role, "notes");
	await mkdir(dir, { recursive: true });
	for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text, "utf8");
}

async function writeRuns(stateDir: string, lines: Array<RunReportLine | RunEndLine>): Promise<void> {
	await writeFile(join(stateDir, "runs.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
}

/** The two-role fixture: alpha has two runs in the window (one reported, one not) and history; beta has none. */
async function twoRoleFixture(): Promise<{ stateDir: string; rolesDir: string }> {
	const { stateDir, rolesDir } = await fixture();
	await writeRole(rolesDir, "alpha", { title: "Alpha role", enabled: true });
	await writeRole(rolesDir, "beta", { title: "Beta role", enabled: true });
	await writeRole(rolesDir, "example", { title: "Example role", enabled: false });
	await writeRole(rolesDir, "not-a-role", undefined);
	await writeNotes(stateDir, "alpha", {
		"STATE.md": "# State\nline one\nline two\n",
		"LOG.md": "# Log\n",
	});
	await writeNotes(stateDir, "beta", {
		"RULE-PROPOSALS.md": [
			"# Rule proposals",
			"",
			"- 2026-10-25 — skip same-author posts for 7 days — would have changed post 1 — noise",
			"0126-10-26 never mind, dropped this one",
			"2026-10-26 — follow relevant accounts — would have changed 2 skips — discovery",
			"2026-10-26 — already approved: keep it",
			"just a note in the middle",
			"- 2026-10-27 — declined by the owner",
			"2026-10-24 — reply once per author per day — posts 7, 9 — less noise — yes 2026-10-27 \"fine by me\"",
			"",
		].join("\n"),
	});
	const history: RunReportLine[] = [];
	for (const day of ["22", "23", "24", "25", "26"]) {
		history.push(report("alpha", `alpha:2026-10-${day}T07:40`, `2026-10-${day}T07:05:00.000Z`, { counts: { judged: 3 } }));
	}
	await writeRuns(stateDir, [
		end("alpha", "alpha:2026-10-27T03:00", "2026-10-27T03:10:00.000Z"),
		...history,
		end("alpha", "alpha:2026-10-27T07:40", "2026-10-27T07:05:00.000Z"),
		report("alpha", "alpha:2026-10-27T07:40", "2026-10-27T07:05:00.000Z", {
			counts: { judged: 4, alerted: 1 },
			did: ["Read the queue", "Alerted one post"],
			notCovered: "could not read LinkedIn",
		}),
		end("alpha", "alpha:2026-10-28T07:40", "2026-10-28T06:00:00.000Z"),
	]);
	return { stateDir, rolesDir };
}

describe("digest time and parsing helpers", () => {
	it("takes the configured zone's calendar date of an instant, not the UTC date", () => {
		process.env.STANDING_ROLES_TIMEZONE = "Europe/London";
		try {
			// British Summer Time is one hour ahead: 23:30Z is the next zone day.
			expect(zoneDate("2026-07-01T23:30:00.000Z")).toBe("2026-07-02");
			expect(zoneDate("2026-10-27T23:30:00.000Z")).toBe("2026-10-27");
			expect(zoneDate("2026-12-31T23:30:00.000Z")).toBe("2026-12-31");
		} finally {
			delete process.env.STANDING_ROLES_TIMEZONE;
		}
	});

	it("is the 24 hours ending at --now, dated by its end", () => {
		const window = windowFor(NOW);
		expect(window.endMs).toBe(NOW.getTime());
		expect(window.startMs).toBe(NOW.getTime() - 24 * 3_600_000);
		expect(window.date).toBe("2026-10-28");
	});

	it("skips malformed and foreign lines in runs.jsonl", () => {
		const text = [
			JSON.stringify(report("alpha", "s1", "2026-10-27T07:05:00.000Z", { counts: { judged: 1 } })),
			"",
			"not json",
			JSON.stringify({ v: 1, kind: "something-else", role: "alpha" }),
			JSON.stringify({ v: 1, kind: "report", role: "alpha", slot: "s2", at: "2026-10-27T08:05:00.000Z" }),
			JSON.stringify(end("alpha", "s3", "2026-10-27T09:05:00.000Z")),
		].join("\n");
		const lines = parseRunsLines(text);
		expect(lines.map((line) => line.kind)).toEqual(["report", "report", "run-end"]);
		// A report line missing its optional fields is still a report, with safe defaults.
		expect(lines[1]).toMatchObject({ kind: "report", slot: "s2", counts: {}, did: [], notCovered: "" });
	});

	it("counts a line multiset difference and samples the added lines", () => {
		const diff = diffLines(["a", "b", "b"], ["b", "c", "b", "d"]);
		expect(diff.added).toBe(2);
		expect(diff.removed).toBe(1);
		expect(diff.sampleAdded).toEqual(["c", "d"]);
		expect(diffLines(["long".repeat(100)], []).sampleAdded).toEqual([]);
		expect(diffLines([], ["x".repeat(500)]).sampleAdded[0]).toHaveLength(200);
		// Blank lines count as changes but stay out of the readable sample.
		const blank = diffLines([], ["", "  ", "real line"]);
		expect(blank.added).toBe(3);
		expect(blank.sampleAdded).toEqual(["real line"]);
	});

	it("reads only pending rule proposals", () => {
		const text = [
			"# heading",
			"- 2026-10-25 — a rule — cases — why",
			"2026-10-26 — dated rule",
			"  - 2026-10-26 — indented pending",
			"2026-10-26 — declined by the owner",
			"2026-10-26 — DROPPED it",
			"2026-10-26 — approved by the owner",
			"2026-10-26 — accepted",
			"prose without a dash",
			"",
		].join("\n");
		expect(pendingProposals(text)).toEqual([
			"- 2026-10-25 — a rule — cases — why",
			"2026-10-26 — dated rule",
			"- 2026-10-26 — indented pending",
		]);
	});

	it("keeps at most ten pending proposals", () => {
		const text = Array.from({ length: 14 }, (_, i) => `- 2026-10-${String(i + 1).padStart(2, "0")} — rule ${i}`).join("\n");
		expect(pendingProposals(text)).toHaveLength(10);
	});
});

describe("buildDigest", () => {
	it("joins runs and reports per role, counting unreported runs by report lines, not the flag", async () => {
		const { stateDir, rolesDir } = await twoRoleFixture();
		// The flag says "reported" but there is no report line: still unreported (the flag alone is not trusted).
		await writeFile(
			join(stateDir, "runs.jsonl"),
			(await readFile(join(stateDir, "runs.jsonl"), "utf8")) + JSON.stringify(end("beta", "beta:s1", "2026-10-28T05:00:00.000Z", { reported: true })) + "\n",
			"utf8",
		);
		const digest = await buildDigest({ now: NOW, stateDir, rolesDir });
		const alpha = digest.roles.find((r) => r.role === "alpha")!;
		const beta = digest.roles.find((r) => r.role === "beta")!;
		expect(alpha.runs).toBe(2); // the 2026-10-27T03:00 run is outside the window
		expect(alpha.unreported).toBe(1);
		expect(beta.runs).toBe(1);
		expect(beta.unreported).toBe(1);
	});

	it("counts a run reported when a report line with its role and slot exists", async () => {
		const { stateDir, rolesDir } = await fixture();
		await writeRole(rolesDir, "alpha", { title: "Alpha role" });
		await writeRuns(stateDir, [
			end("alpha", "alpha:s1", "2026-10-28T05:00:00.000Z", { reported: false }),
			report("alpha", "alpha:s1", "2026-10-28T05:01:00.000Z", { counts: { judged: 2 } }),
		]);
		const digest = await buildDigest({ now: NOW, stateDir, rolesDir });
		expect(digest.roles[0]!.runs).toBe(1);
		expect(digest.roles[0]!.unreported).toBe(0);
	});

	it("a reused slot name (watch:<name>) is reported only by a report made during that run", async () => {
		const { stateDir, rolesDir } = await fixture();
		await writeRole(rolesDir, "alpha", { title: "Alpha role" });
		await writeRuns(stateDir, [
			end("alpha", "watch:scout", "2026-10-26T10:00:00.000Z"),
			report("alpha", "watch:scout", "2026-10-26T09:59:00.000Z", { counts: { judged: 2 } }),
			end("alpha", "watch:scout", "2026-10-28T05:00:00.000Z"),
			end("alpha", "watch:scout", "2026-10-28T06:00:00.000Z"),
			report("alpha", "watch:scout", "2026-10-28T05:59:00.000Z", { counts: { judged: 1 } }),
		]);
		const digest = await buildDigest({ now: NOW, stateDir, rolesDir });
		expect(digest.roles[0]!.runs).toBe(2);
		expect(digest.roles[0]!.unreported).toBe(1);
	});

	it("lists every role folder with settings.json except example, and the example is left out", async () => {
		const { stateDir, rolesDir } = await twoRoleFixture();
		const digest = await buildDigest({ now: NOW, stateDir, rolesDir });
		expect(digest.roles.map((role) => role.role)).toEqual(["alpha", "beta"]);
		expect(digest.roles[0]!.title).toBe("Alpha role");
		expect(digest.v).toBe(1);
		expect(digest.date).toBe("2026-10-28");
		expect(digest.windowStart).toBe("2026-10-27T06:30:00.000Z");
		expect(digest.windowEnd).toBe("2026-10-28T06:30:00.000Z");
	});

	it("sums the window's counts and takes the median of the 7 previous days", async () => {
		const { stateDir, rolesDir } = await twoRoleFixture();
		const digest = await buildDigest({ now: NOW, stateDir, rolesDir });
		const alpha = digest.roles.find((r) => r.role === "alpha")!;
		expect(alpha.counts).toEqual([
			{ name: "alerted", value: 1, median7d: 0 },
			{ name: "judged", value: 4, median7d: 3 },
		]);
		const beta = digest.roles.find((r) => r.role === "beta")!;
		expect(beta.counts).toEqual([]);
	});

	it("gives no median when fewer than three of the previous days had a report", async () => {
		const { stateDir, rolesDir } = await fixture();
		await writeRole(rolesDir, "alpha", { title: "Alpha role" });
		// Only two of the seven previous days in the zone carry a report: no usual value is shown.
		await writeRuns(stateDir, [
			report("alpha", "alpha:s0", "2026-10-24T07:05:00.000Z", { counts: { judged: 3 } }),
			report("alpha", "alpha:s2", "2026-10-27T07:05:00.000Z", { counts: { judged: 4 } }),
		]);
		const digest = await buildDigest({ now: NOW, stateDir, rolesDir });
		expect(digest.roles[0]!.counts).toEqual([{ name: "judged", value: 4, median7d: null }]);
	});

	it("lists the window's did lines newest first, at most ten, and its not-covered texts", async () => {
		const { stateDir, rolesDir } = await fixture();
		await writeRole(rolesDir, "alpha", { title: "Alpha role" });
		await writeRuns(stateDir, [
			report("alpha", "s1", "2026-10-27T08:00:00.000Z", {
				did: ["older one", "older two"],
				notCovered: "could not read LinkedIn",
			}),
			report("alpha", "s2", "2026-10-28T05:00:00.000Z", {
				did: Array.from({ length: 10 }, (_, i) => `newer ${i}`),
				notCovered: "  ",
			}),
		]);
		const digest = await buildDigest({ now: NOW, stateDir, rolesDir });
		const alpha = digest.roles[0]!;
		expect(alpha.did).toHaveLength(10);
		expect(alpha.did[0]).toBe("newer 0");
		expect(alpha.did).not.toContain("older one");
		expect(alpha.notCovered).toEqual(["could not read LinkedIn"]);
	});

	it("flags a scheduled run whose every-run count is zero or missing, and ignores chat, inbox and watch runs", async () => {
		const { stateDir, rolesDir } = await fixture();
		await writeRole(rolesDir, "alpha", { title: "Alpha role", everyRunCounts: ["channels_read"] });
		await writeRole(rolesDir, "beta", { title: "Beta role" });
		await writeRuns(stateDir, [
			report("alpha", "alpha:2026-10-27T13:00", "2026-10-27T13:04:00.000Z", { counts: { channels_read: 12 } }),
			report("alpha", "alpha:2026-10-27T15:30", "2026-10-27T15:34:00.000Z", { counts: { channels_read: 0 } }),
			report("alpha", "alpha:2026-10-27T18:00", "2026-10-27T18:02:00.000Z", { counts: { messages_read: 4 } }),
			report("alpha", "chat:2026-10-27T12:52:31.283Z", "2026-10-27T12:56:00.000Z", { counts: {} }),
			report("alpha", "inbox:abc", "2026-10-27T12:58:00.000Z", { counts: {} }),
			report("alpha", "watch:poll", "2026-10-27T12:59:00.000Z", { counts: {} }),
			report("beta", "beta:2026-10-27T15:30", "2026-10-27T15:34:00.000Z", { counts: { channels_read: 0 } }),
			end("alpha", "alpha:2026-10-27T13:00", "2026-10-27T13:05:00.000Z"),
			end("alpha", "alpha:2026-10-27T15:30", "2026-10-27T15:35:00.000Z"),
			end("alpha", "alpha:2026-10-27T18:00", "2026-10-27T18:03:00.000Z"),
		]);
		const digest = await buildDigest({ now: NOW, stateDir, rolesDir });
		const alpha = digest.roles.find((role) => role.role === "alpha")!;
		const beta = digest.roles.find((role) => role.role === "beta")!;
		expect(alpha.everyRunMisses).toEqual([
			"alpha:2026-10-27T18:00: channels_read not reported (required every scheduled run)",
			"alpha:2026-10-27T15:30: channels_read 0 (required every scheduled run)",
		]);
		expect(beta.everyRunMisses).toBeUndefined();
		expect(renderMarkdown(digest)).toContain("Every-run counts missed:\n- alpha:2026-10-27T18:00: channels_read not reported");
		expect(digest.notification).toContain("Alpha role: 3 runs");
		expect(digest.notification).toMatch(/Alpha role:.*⚠ every-run/);
	});

	it("snapshots each role's notes and diffs against the previous snapshot", async () => {
		const { stateDir, rolesDir } = await twoRoleFixture();
		await mkdir(join(stateDir, "digest", "snapshots", "alpha", "2026-10-27"), { recursive: true });
		const before = join(stateDir, "digest", "snapshots", "alpha", "2026-10-27");
		await writeFile(join(before, "STATE.md"), "# State\nline one\nold line\n", "utf8");
		await writeFile(join(before, "LOG.md"), "# Log\n", "utf8"); // unchanged: not listed
		await writeFile(join(before, "GONE.md"), "# Gone\n", "utf8");

		const digest = await buildDigest({ now: NOW, stateDir, rolesDir });
		const alpha = digest.roles.find((r) => r.role === "alpha")!;
		expect(alpha.notesChanges).toEqual([
			{ file: "GONE.md", added: 0, removed: 1, sampleAdded: [] },
			{ file: "STATE.md", added: 1, removed: 1, sampleAdded: ["line two"] },
		]);
		// The snapshot for today holds the current notes, top-level .md only.
		const today = join(stateDir, "digest", "snapshots", "alpha", "2026-10-28");
		expect((await readdir(today)).sort()).toEqual(["LOG.md", "STATE.md"]);
		expect(await readFile(join(today, "STATE.md"), "utf8")).toBe("# State\nline one\nline two\n");
	});

	it("lists no notes change when the role has no earlier snapshot", async () => {
		const { stateDir, rolesDir } = await twoRoleFixture();
		const digest = await buildDigest({ now: NOW, stateDir, rolesDir });
		const alpha = digest.roles.find((r) => r.role === "alpha")!;
		expect(alpha.notesChanges).toEqual([]);
	});

	it("keeps 14 days of snapshots and deletes older snapshot folders", async () => {
		const { stateDir, rolesDir } = await twoRoleFixture();
		const keep = join(stateDir, "digest", "snapshots", "alpha", "2026-10-27");
		const old = join(stateDir, "digest", "snapshots", "alpha", "2026-10-01");
		await mkdir(keep, { recursive: true });
		await mkdir(old, { recursive: true });
		await writeFile(join(old, "STATE.md"), "# State\n", "utf8");
		await buildDigest({ now: NOW, stateDir, rolesDir });
		expect(SNAPSHOT_KEEP_DAYS).toBe(14);
		expect(existsSync(old)).toBe(false);
		expect(existsSync(keep)).toBe(true);
		expect(existsSync(join(stateDir, "digest", "snapshots", "alpha", "2026-10-28"))).toBe(true);
	});

	it("reads the pending proposals of each role", async () => {
		const { stateDir, rolesDir } = await twoRoleFixture();
		const digest = await buildDigest({ now: NOW, stateDir, rolesDir });
		const beta = digest.roles.find((r) => r.role === "beta")!;
		expect(beta.pendingProposals).toEqual([
			"- 2026-10-25 — skip same-author posts for 7 days — would have changed post 1 — noise",
			"2026-10-26 — follow relevant accounts — would have changed 2 skips — discovery",
		]);
	});

	it("copes with a missing runs.jsonl and missing notes", async () => {
		const { stateDir, rolesDir } = await fixture();
		await writeRole(rolesDir, "alpha", { title: "Alpha role" });
		const digest = await buildDigest({ now: NOW, stateDir, rolesDir });
		expect(digest.roles[0]!.runs).toBe(0);
		expect(digest.roles[0]!.notesChanges).toEqual([]);
		expect(digest.roles[0]!.pendingProposals).toEqual([]);
	});
});

describe("the notification text", () => {
	it("is one short message: runs, key counts against the usual, warnings and proposals", async () => {
		const { stateDir, rolesDir } = await twoRoleFixture();
		const digest = await buildDigest({ now: NOW, stateDir, rolesDir });
		expect(digest.notification).toBe(
			[
				"Roles, last 24 h (2026-10-28)",
				"Alpha role: 2 runs · alerted 1 (usual 0), judged 4 (usual 3) ⚠ 1 unreported",
				"Beta role: no runs ⚠",
				"Rule proposals waiting: 2",
			].join("\n"),
		);
		expect(digest.notification.length).toBeLessThanOrEqual(NOTIFICATION_MAX_CHARS);
	});

	it("leaves out the proposals line when nothing is waiting, and roles that are disabled", async () => {
		const { stateDir, rolesDir } = await fixture();
		await writeRole(rolesDir, "alpha", { title: "Alpha role" });
		await writeRole(rolesDir, "quiet", { title: "Quiet role", enabled: false });
		const digest = await buildDigest({ now: NOW, stateDir, rolesDir });
		expect(digest.notification).toBe(
			["Roles, last 24 h (2026-10-28)", "Alpha role: no runs ⚠"].join("\n"),
		);
		expect(digest.roles.map((role) => role.role)).toEqual(["alpha", "quiet"]);
	});

	it("stays within 1,200 characters when many roles have long titles", () => {
		const roles = Array.from({ length: 20 }, (_, i) => ({
			role: `role-${i}`,
			title: `A very long role title number ${i} that carries on and on`,
			enabled: true,
			runs: 2,
			unreported: 1,
			counts: [{ name: "judged", value: 3, median7d: 1 }],
			did: [],
			notCovered: [],
			notesChanges: [],
			pendingProposals: [],
		}));
		const text = notificationText("2026-10-28", roles);
		expect(text.length).toBeLessThanOrEqual(NOTIFICATION_MAX_CHARS);
		expect(text.startsWith("Roles, last 24 h (2026-10-28)")).toBe(true);
		expect(text).toMatch(/\u2026 \d+ more roles$/);
	});
});

describe("writing and rendering the digest", () => {
	it("writes <date>.json and <date>.md into <stateDir>/digest", async () => {
		const { stateDir, rolesDir } = await twoRoleFixture();
		const digest = await buildDigest({ now: NOW, stateDir, rolesDir });
		const paths = writeDigest(stateDir, digest);
		expect(paths.jsonPath).toBe(join(stateDir, "digest", "2026-10-28.json"));
		const json = JSON.parse(await readFile(paths.jsonPath, "utf8"));
		expect(json.v).toBe(1);
		expect(json.date).toBe("2026-10-28");
		expect(json.notification).toBe(digest.notification);
		const markdown = await readFile(paths.mdPath, "utf8");
		expect(markdown).toContain("# Roles digest — 2026-10-28");
		expect(markdown).toContain("## Alpha role");
		expect(markdown).toContain("Read the queue");
		expect(markdown).toContain("could not read LinkedIn");
		expect(markdown).toContain("Pending rule proposals (2)");
	});

	it("renders counts against the usual, notes changes and proposals", () => {
		const markdown = renderMarkdown({
			v: 1,
			date: "2026-10-28",
			windowStart: "2026-10-27T06:30:00.000Z",
			windowEnd: "2026-10-28T06:30:00.000Z",
			roles: [
				{
					role: "alpha",
					title: "Alpha role",
					enabled: true,
					runs: 2,
					unreported: 1,
					counts: [{ name: "judged", value: 4, median7d: 3 }],
					did: ["Read the queue"],
					notCovered: ["could not read LinkedIn"],
					notesChanges: [{ file: "STATE.md", added: 1, removed: 0, sampleAdded: ["new line"] }],
					pendingProposals: ["- 2026-10-25 — a rule"],
				},
			],
			notification: "…",
		});
		expect(markdown).toContain("2 runs · 1 unreported");
		expect(markdown).toContain("judged 4 (usual 3)");
		expect(markdown).toContain("STATE.md +1 −0");
		expect(markdown).toContain("new line");
		expect(markdown).toContain("Pending rule proposals (1)");
	});
});

describe("the CLI arguments", () => {
	it("defaults to now, the standard state dir and the repository's roles/", () => {
		const args = parseDigestArgs([], {}, "/repo/roles");
		expect(args.stateDir).toBe("/var/lib/pi-roles");
		expect(args.rolesDir).toBe("/repo/roles");
		expect(args.send).toBe(false);
		expect(Math.abs(args.now.getTime() - Date.now())).toBeLessThan(5_000);
	});

	it("takes --now, --state-dir, --roles-dir and --send", () => {
		const args = parseDigestArgs(
			["--now", "2026-10-28T06:30:00.000Z", "--state-dir", "/tmp/state", "--roles-dir", "/tmp/roles", "--send"],
			{ STANDING_ROLES_STATE_DIR: "/env/state" },
			"/repo/roles",
		);
		expect(args.now.toISOString()).toBe("2026-10-28T06:30:00.000Z");
		expect(args.stateDir).toBe("/tmp/state");
		expect(args.rolesDir).toBe("/tmp/roles");
		expect(args.send).toBe(true);
	});

	it("reads STANDING_ROLES_STATE_DIR, and rejects an unusable --now", () => {
		expect(parseDigestArgs([], { STANDING_ROLES_STATE_DIR: "/env/state" }, "/repo/roles").stateDir).toBe("/env/state");
		expect(() => parseDigestArgs(["--now", "yesterday"], {}, "/repo/roles")).toThrow();
		expect(() => parseDigestArgs(["--state-dir"], {}, "/repo/roles")).toThrow();
	});

	it("keeps the card off by default, and takes --card", () => {
		const defaults = parseDigestArgs([], {}, "/repo/roles");
		expect(defaults.card).toBe(false);
		const args = parseDigestArgs(["--card"], {}, "/repo/roles");
		expect(args.card).toBe(true);
		expect(() => parseDigestArgs(["--check"], {}, "/repo/roles")).toThrow(/unknown argument/);
	});
});
