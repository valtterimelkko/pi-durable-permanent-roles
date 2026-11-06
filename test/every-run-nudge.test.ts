/**
 * The every-run nudge (built after a role repeatedly skipped its core channels in scheduled runs). A scheduled run that reports one of its
 * role's everyRunCounts as 0 or leaves it out gets ONE reminder in the same conversation; if its newest report still
 * misses it, the host raises a problem card. Chat, inbox, watch and refchange runs are never checked. Real host,
 * faux provider, temp state dir — no real model calls and no live state directory.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { everyRunNudgeText, openRoleHost, type RoleHost } from "../src/harness.ts";
import { loadRoles } from "../src/roles.ts";
import { markReportedRun, readRunsFile } from "../src/run-report.ts";
import { readNeedsYouLines } from "../src/needs-you.ts";
import { missedEveryRun } from "../src/digest.ts";
import { makeFauxHostModels, makeStateDir, messageTextOf, writeRolesTree } from "./helpers.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const NUDGE_MARK = "required on every scheduled run";

/** The faux model "reports" each run with firstCounts, and the nudge with nudgeCounts (undefined = no report). */
async function hostWith(opts: {
	firstCounts: Record<string, number>;
	nudgeCounts?: Record<string, number>;
}): Promise<{ host: RoleHost; stateDir: string; prompts: string[] }> {
	const stateDir = await makeStateDir();
	const parent = mkdtempSync(join(tmpdir(), "sr-everyrun-"));
	const rolesRoot = join(parent, "roles");
	roots.push(parent, stateDir);
	await writeRolesTree(rolesRoot, [{ name: "alpha", reportCounts: ["read", "moved"], everyRunCounts: ["read"] }]);
	const { enabled } = await loadRoles({ rolesRoot, stateDir });
	const { hostModels, defaultModel, faux } = makeFauxHostModels();
	const prompts: string[] = [];
	let host: RoleHost | undefined;
	const route: FauxResponseStep = (request) => {
		const text = messageTextOf(request.messages.findLast((m) => m.role !== "system"));
		prompts.push(text);
		const slot = host?.currentSlot("alpha");
		if (slot !== undefined) {
			if (text.includes(NUDGE_MARK)) {
				if (opts.nudgeCounts !== undefined) markReportedRun("alpha", slot, opts.nudgeCounts);
			} else {
				markReportedRun("alpha", slot, opts.firstCounts);
			}
		}
		return fauxAssistantMessage([fauxText(`Reply to: ${text.slice(0, 40)}`)]);
	};
	faux.setResponses(Array.from({ length: 32 }, () => route));
	host = await openRoleHost({ dbPath: join(stateDir, "roles.db"), stateDir, roles: enabled, defaultModel, hostModels, reportNudge: true });
	return { host, stateDir, prompts };
}

async function runEnd(stateDir: string, slot: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	for (;;) {
		if (readRunsFile(stateDir).some((l) => l.kind === "run-end" && (l as { slot?: string }).slot === slot)) return;
		if (Date.now() > deadline) throw new Error(`no run-end line for ${slot}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}

const items = (stateDir: string) => readNeedsYouLines(stateDir).filter((l) => l.type === "item");

describe("the every-run nudge", () => {
	it("names the missed count in its text", () => {
		expect(everyRunNudgeText(["channels_read"])).toContain("channels_read");
		expect(everyRunNudgeText(["channels_read"])).toContain(NUDGE_MARK);
	});

	it("a scheduled run that met its every-run counts gets no nudge and no card", async () => {
		const { host, stateDir, prompts } = await hostWith({ firstCounts: { read: 5, moved: 0 } });
		try {
			await host.submit("alpha", { content: "a round", requestId: "r1", step: "alpha:2026-11-05T13:00" });
			await runEnd(stateDir, "alpha:2026-11-05T13:00");
			expect(prompts.some((p) => p.includes(NUDGE_MARK))).toBe(false);
			expect(items(stateDir)).toEqual([]);
		} finally {
			await host.close();
		}
	});

	it("a scheduled run reporting the count as 0 gets exactly one nudge; fixing it on the nudge raises no card", async () => {
		const { host, stateDir, prompts } = await hostWith({ firstCounts: { read: 0, moved: 2 }, nudgeCounts: { read: 129, moved: 2 } });
		try {
			await host.submit("alpha", { content: "a round", requestId: "r2", step: "alpha:2026-11-05T15:30" });
			await runEnd(stateDir, "alpha:2026-11-05T15:30");
			expect(prompts.filter((p) => p.includes(NUDGE_MARK))).toHaveLength(1);
			expect(prompts.find((p) => p.includes(NUDGE_MARK))).toContain("read");
			expect(items(stateDir)).toEqual([]);
		} finally {
			await host.close();
		}
	});

	it("a count still 0 after the nudge raises one problem card naming the count and slot", async () => {
		const { host, stateDir, prompts } = await hostWith({ firstCounts: { read: 0, moved: 2 }, nudgeCounts: { read: 0, moved: 2 } });
		try {
			await host.submit("alpha", { content: "a round", requestId: "r3", step: "alpha:2026-11-05T18:00" });
			await runEnd(stateDir, "alpha:2026-11-05T18:00");
			expect(prompts.filter((p) => p.includes(NUDGE_MARK))).toHaveLength(1);
			const cards = items(stateDir);
			expect(cards).toHaveLength(1);
			expect(cards[0]).toMatchObject({ role: "alpha", kind: "problem" });
			expect(String(cards[0].body)).toContain("read");
			expect(String(cards[0].body)).toContain("alpha:2026-11-05T18:00");
		} finally {
			await host.close();
		}
	});

	it("never checks chat, inbox, watch or refchange runs", async () => {
		const { host, stateDir, prompts } = await hostWith({ firstCounts: { read: 0, moved: 0 } });
		try {
			for (const step of ["chat:2026-11-05T10:00:00.000Z", "inbox:x", "watch:y", "refchange:alpha:abc"]) {
				await host.submit("alpha", { content: "a turn", requestId: step, step });
				await runEnd(stateDir, step);
			}
			expect(prompts.some((p) => p.includes(NUDGE_MARK))).toBe(false);
			expect(items(stateDir)).toEqual([]);
		} finally {
			await host.close();
		}
	});
});

describe("the digest's every-run check", () => {
	const report = (slot: string, read: number, at: string) => ({ v: 1 as const, kind: "report" as const, role: "alpha", slot, at, counts: { read }, did: [], notCovered: "", proposals: 0 });

	it("judges each slot by its newest report, so a run fixed on the nudge is not flagged", () => {
		const reports = [report("alpha:2026-11-05T15:30", 129, "2026-11-05T15:40:00Z"), report("alpha:2026-11-05T15:30", 0, "2026-11-05T15:35:00Z")];
		expect(missedEveryRun(reports, ["read"])).toEqual([]);
	});

	it("does not count refchange runs as scheduled", () => {
		expect(missedEveryRun([report("refchange:alpha:abc", 0, "2026-11-05T15:40:00Z")], ["read"])).toEqual([]);
	});
});
