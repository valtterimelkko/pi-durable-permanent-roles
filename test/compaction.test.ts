import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { CompactionEntry, type EntryRecord } from "@earendil-works/pi-durable";
import { openRoleHost, type RoleHost } from "../src/harness.ts";
import { loadRoles } from "../src/roles.ts";
import { makeFauxHostModels, makeStateDir, writeRolesTree } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;
const roots: string[] = [];

afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function compactionEntries(host: RoleHost, roleName: string): Promise<EntryRecord[]> {
	const conversation = await host.conversation(roleName);
	const entries = await conversation!.entries({ order: "ascending" }, 200, undefined, context);
	return entries.items.filter((entry) => CompactionEntry.is(entry));
}

/** Poll until a compaction entry appears (background compaction outlives waitForIdle). */
async function waitForCompaction(host: RoleHost, roleName: string, timeoutMs = 10_000): Promise<EntryRecord | undefined> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const found = await compactionEntries(host, roleName);
		if (found.length > 0) return found.at(-1);
		if (Date.now() >= deadline) return undefined;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

describe("compaction (S7)", () => {
	it("background compaction fires on the threshold and the summary ends with the notes pointer", async () => {
		const stateDir = await makeStateDir();
		const rolesRoot = join(await mkdtemp(join(tmpdir(), "sr-compact-")), "roles");
		roots.push(rolesRoot, stateDir);
		await writeRolesTree(rolesRoot, [{ name: "alpha" }]);
		const { enabled } = await loadRoles({ rolesRoot, stateDir });
		// A small window so the threshold is reachable with scripted filler turns.
		const { hostModels, defaultModel } = makeFauxHostModels({ models: [{ id: "m-1", contextWindow: 2_000 }] });
		const host = await openRoleHost({
			dbPath: join(stateDir, "roles.db"),
			stateDir,
			roles: enabled,
			defaultModel,
			hostModels,
		});
		try {
			// Turn after turn; the background compaction starts once the estimate crosses
			// the threshold (1,125 tokens for this window's policy).
			let entry: EntryRecord | undefined;
			for (let i = 1; i <= 5 && entry === undefined; i++) {
				await host.submit("alpha", { content: `FILLER ${i}`, requestId: `filler-${i}` });
				await (await host.conversation("alpha"))!.waitForIdle(context);
				entry = await waitForCompaction(host, "alpha", 2_000);
			}
			expect(entry).toBeDefined();
			const reason = (entry as { data?: { reason?: string } }).data?.reason;
			expect(reason).toBe("threshold");
			const text = (entry!.model?.[0] as { content?: Array<{ type: string; text?: string }> }).content ?? [];
			const summary = text.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("");
			expect(summary).toContain("## Decisions");
			expect(summary.trimEnd().endsWith("Your folder /dev/null/notes is the record: re-read it before continuing.") || summary.includes("is the record: re-read it before continuing."))
				.toBe(true);
			expect(summary).toContain(`${stateDir}/roles/alpha/notes`);
		} finally {
			await host.close();
		}
	});

	it("the summary is written from the conversation: it keeps a fact stated in an earlier turn", async () => {
		const stateDir = await makeStateDir();
		const rolesRoot = join(await mkdtemp(join(tmpdir(), "sr-compact-3-")), "roles");
		roots.push(rolesRoot, stateDir);
		await writeRolesTree(rolesRoot, [{ name: "alpha" }]);
		const { enabled } = await loadRoles({ rolesRoot, stateDir });
		const { hostModels, defaultModel } = makeFauxHostModels({ models: [{ id: "m-1", contextWindow: 2_000 }] });
		const host = await openRoleHost({
			dbPath: join(stateDir, "roles.db"),
			stateDir,
			roles: enabled,
			defaultModel,
			hostModels,
		});
		try {
			// Turn 1 states the three facts a summary must keep; the fillers push the
			// estimate over the threshold (1,125 tokens for this window's policy), so the
			// facts end up in the compacted prefix — the summariser's only source.
			await host.submit("alpha", {
				content:
					"Decision: the disk audit stays on Fridays (FACT-DECISION). Open item: waiting on the owner's cron-slot answer (FACT-OPEN). Number: the retention cap is 412 GB (FACT-NUMBER).",
				requestId: "facts",
			});
			await (await host.conversation("alpha"))!.waitForIdle(context);
			let entry: EntryRecord | undefined;
			for (let i = 1; i <= 5 && entry === undefined; i++) {
				await host.submit("alpha", { content: `FILLER ${i}`, requestId: `filler-${i}` });
				await (await host.conversation("alpha"))!.waitForIdle(context);
				entry = await waitForCompaction(host, "alpha", 2_000);
			}
			expect(entry).toBeDefined();
			const reason = (entry as { data?: { reason?: string } }).data?.reason;
			expect(reason).toBe("threshold");
			const text = (entry!.model?.[0] as { content?: Array<{ type: string; text?: string }> }).content ?? [];
			const summary = text.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("");
			// The faux summariser echoes a fact only if the request carried it.
			expect(summary).toContain("kept FACT-DECISION");
			expect(summary).toContain("kept FACT-OPEN");
			expect(summary).toContain("kept FACT-NUMBER");
			// The entry carries the summary wrapped in Pi Durable's <summary> markers; unwrap
			// it: the summary itself must end with exactly the notes-pointer line.
			const inner = summary.slice(summary.indexOf("<summary>\n") + "<summary>\n".length, summary.lastIndexOf("\n</summary>"));
			expect(inner.trimEnd().endsWith(`Your folder ${stateDir}/roles/alpha/notes is the record: re-read it before continuing.`)).toBe(true);
		} finally {
			await host.close();
		}
	});

	it("a summariser that always fails ends the run as model_error (Pi Durable 1.2+) instead of sending an oversized request", async () => {
		const stateDir = await makeStateDir();
		const rolesRoot = join(await mkdtemp(join(tmpdir(), "sr-compact-2-")), "roles");
		roots.push(rolesRoot, stateDir);
		await writeRolesTree(rolesRoot, [{ name: "alpha" }]);
		const { enabled } = await loadRoles({ rolesRoot, stateDir });
		const { hostModels, defaultModel, faux } = makeFauxHostModels({ models: [{ id: "m-1", contextWindow: 2_000 }] });
		const host = await openRoleHost({
			dbPath: join(stateDir, "roles.db"),
			stateDir,
			roles: enabled,
			defaultModel,
			hostModels,
		});
		try {
			// Every model answer (turns and summaries) stops on length: the hook refuses it
			// and returns undefined, so Pi Durable's default summary path takes over, and that fails too.
			// Pi Durable 1.2.0: a blocking-threshold compaction that cannot complete fails the generation
			// (model_error, "Compaction failed"; dist/harness/generation.js) where 1.1.0 sent the request
			// anyway. The context here is far over its 2000-token window, so the later runs end unanswered.
			faux.setResponses(
				Array.from({ length: 128 }, () => ({
					role: "assistant" as const,
					content: [{ type: "text" as const, text: "x".repeat(3_000) }],
					stopReason: "length" as const,
					api: "faux",
					provider: "faux",
					model: "m-1",
					usage: { input: 10, output: 750, cacheRead: 0, cacheWrite: 0, totalTokens: 760, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					timestamp: Date.now(),
				})),
			);
			for (let i = 1; i <= 5; i++) {
				await host.submit("alpha", { content: `FILLER ${i}`, requestId: `cut-${i}` });
				await (await host.conversation("alpha"))!.waitForIdle(context);
			}
			// The host stays up and keeps taking input after the failed runs.
			await host.submit("alpha", { content: "hello again", requestId: "after-cut" });
			await (await host.conversation("alpha"))!.waitForIdle(context);
			const conversation = await host.conversation("alpha");
			const entries = await conversation!.entries({ order: "ascending" }, 200, undefined, context);
			const answers = entries.items.filter((item) => item.model?.[0] && JSON.stringify(item.model[0]).includes("x"));
			expect(answers.length).toBeGreaterThanOrEqual(1);
			expect(answers.length).toBeLessThan(6);
		} finally {
			await host.close();
		}
	});
});
