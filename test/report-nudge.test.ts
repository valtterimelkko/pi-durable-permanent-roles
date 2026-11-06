/**
 * The report nudge: a run that settles without report_run gets ONE reminder in the same conversation; if it still has not reported,
 * the host raises a needs-you card itself, so an unreported run is never silent. Real host, faux provider, temp
 * state dir — no real model calls and no live state directory.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { openRoleHost, REPORT_NUDGE_TEXT, type RoleHost } from "../src/harness.ts";
import { loadRoles } from "../src/roles.ts";
import { markReportedRun, readRunsFile } from "../src/run-report.ts";
import { readNeedsYouLines } from "../src/needs-you.ts";
import { makeFauxHostModels, makeStateDir, messageTextOf, writeRolesTree } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A host whose faux model answers the nudge by "reporting" (marking the slot) when reportOnNudge is set. */
async function hostWith(opts: { reportOnNudge: boolean }): Promise<{ host: RoleHost; stateDir: string; prompts: string[] }> {
	const stateDir = await makeStateDir();
	const parent = mkdtempSync(join(tmpdir(), "sr-nudge-"));
	const rolesRoot = join(parent, "roles");
	roots.push(parent, stateDir);
	await writeRolesTree(rolesRoot, [{ name: "alpha" }]);
	const { enabled } = await loadRoles({ rolesRoot, stateDir });
	const { hostModels, defaultModel, faux } = makeFauxHostModels();
	const prompts: string[] = [];
	let host: RoleHost | undefined;
	const route: FauxResponseStep = (request) => {
		const text = messageTextOf(request.messages.findLast((m) => m.role !== "system"));
		prompts.push(text);
		if (opts.reportOnNudge && text.includes(REPORT_NUDGE_TEXT)) {
			const slot = host?.currentSlot("alpha");
			if (slot !== undefined) markReportedRun("alpha", slot);
		}
		return fauxAssistantMessage([fauxText(`Reply to: ${text.slice(0, 40)}`)]);
	};
	faux.setResponses(Array.from({ length: 32 }, () => route));
	host = await openRoleHost({ dbPath: join(stateDir, "roles.db"), stateDir, roles: enabled, defaultModel, hostModels, reportNudge: true });
	return { host, stateDir, prompts };
}

async function runEnd(stateDir: string, slot: string): Promise<Record<string, unknown>> {
	const deadline = Date.now() + 5_000;
	for (;;) {
		const line = readRunsFile(stateDir).find((l) => l.kind === "run-end" && (l as { slot?: string }).slot === slot);
		if (line !== undefined) return line as unknown as Record<string, unknown>;
		if (Date.now() > deadline) throw new Error(`no run-end line for ${slot}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}

describe("the report nudge", () => {
	it("a run that reported gets no nudge and no card", async () => {
		const { host, stateDir, prompts } = await hostWith({ reportOnNudge: false });
		try {
			markReportedRun("alpha", "ok-1");
			await host.submit("alpha", { content: "a round", requestId: "ok-1" });
			const end = await runEnd(stateDir, "ok-1");
			expect(end.reported).toBe(true);
			expect(prompts.some((p) => p.includes(REPORT_NUDGE_TEXT))).toBe(false);
			expect(readNeedsYouLines(stateDir).filter((l) => l.type === "item")).toEqual([]);
		} finally {
			await host.close();
		}
	});

	it("an unreported run gets exactly one nudge; reporting on it marks the run reported and raises no card", async () => {
		const { host, stateDir, prompts } = await hostWith({ reportOnNudge: true });
		try {
			await host.submit("alpha", { content: "a round", requestId: "nudge-1" });
			const end = await runEnd(stateDir, "nudge-1");
			expect(prompts.filter((p) => p.includes(REPORT_NUDGE_TEXT))).toHaveLength(1);
			expect(end.reported).toBe(true);
			expect(readNeedsYouLines(stateDir).filter((l) => l.type === "item")).toEqual([]);
		} finally {
			await host.close();
		}
	});

	it("a run still unreported after the nudge raises one problem card naming the role, slot and transcript", async () => {
		const { host, stateDir, prompts } = await hostWith({ reportOnNudge: false });
		try {
			await host.submit("alpha", { content: "a round", requestId: "silent-1" });
			const end = await runEnd(stateDir, "silent-1");
			expect(prompts.filter((p) => p.includes(REPORT_NUDGE_TEXT))).toHaveLength(1);
			expect(end.reported).toBe(false);
			const items = readNeedsYouLines(stateDir).filter((l) => l.type === "item");
			expect(items).toHaveLength(1);
			expect(items[0]).toMatchObject({ role: "alpha", kind: "problem" });
			expect(String(items[0].title)).toContain("without a report");
			expect(String(items[0].body)).toContain("silent-1");
			expect(String(items[0].body)).toContain("transcript");
		} finally {
			await host.close();
		}
	});

	it("never nudges a run that has another run queued behind it (the report could land under the wrong slot); the card still comes", async () => {
		const { host, stateDir, prompts } = await hostWith({ reportOnNudge: true });
		try {
			await host.submit("alpha", { content: "first", requestId: "q-1" });
			await host.submit("alpha", { content: "second", requestId: "q-2" });
			const end1 = await runEnd(stateDir, "q-1");
			expect(end1.reported).toBe(false);
			const items = readNeedsYouLines(stateDir).filter((l) => l.type === "item" && String(l.body).includes("q-1"));
			expect(items).toHaveLength(1);
			await runEnd(stateDir, "q-2");
			// q-2 had nothing queued behind it: it was nudged once and reported on the nudge.
			expect(prompts.filter((p) => p.includes(REPORT_NUDGE_TEXT))).toHaveLength(1);
		} finally {
			await host.close();
		}
	});

	it("is off unless the host is told to nudge (the production config turns it on)", async () => {
		const { loadConfig } = await import("../src/config.ts");
		expect(loadConfig({}).reportNudge).toBe(true);
		expect(loadConfig({ STANDING_ROLES_REPORT_NUDGE: "off" }).reportNudge).toBe(false);
	});
});

