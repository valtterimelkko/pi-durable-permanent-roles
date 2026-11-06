/**
 * Pi Durable 1.4 made `checkpointWhen` a required predicate on every document definition.
 * Our documents are current-only ledgers: every write is a delta applied
 * on top of the newest base, and a delta list never shrinks by itself. SQLite drops every earlier revision when a
 * base is written for a current-only document, so a periodic base is what keeps both the stored revisions and the
 * replay a process does on open bounded for a host that runs for months.
 *
 * These tests pin the two halves of that: the predicate itself, and the per-document choice — made explicit here so a
 * later definition cannot quietly fall back to "never" when it grows.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, defineDoc } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { IntegrationOutbox } from "../src/integrations/effects.ts";
import { baseEveryDeltas, deltasOnly, LEDGER_BASE_DELTAS, SESSION_BASE_DELTAS } from "../src/doc-checkpoint.ts";
import { RoleConversationsDoc, RoleLastRunsDoc } from "../src/harness.ts";
import { NeedsYouWrites } from "../src/needs-you.ts";
import { RoleNotifications } from "../src/notify.ts";
import { ScheduleLedgerDoc } from "../src/schedules.ts";
import { WatchLedgerDoc } from "../src/watches.ts";
import { makeFauxHostModels } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;
const roots: string[] = [];

afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const UNCHANGED = { ops: [] as const, value: {} };

describe("baseEveryDeltas", () => {
	it("keeps changes as deltas below the limit and stores a base once the replay depth reaches it", () => {
		const policy = baseEveryDeltas(4);
		expect(policy(UNCHANGED.value, UNCHANGED.ops, { deltasSinceBase: 0 })).toBe(false);
		expect(policy(UNCHANGED.value, UNCHANGED.ops, { deltasSinceBase: 3 })).toBe(false);
		expect(policy(UNCHANGED.value, UNCHANGED.ops, { deltasSinceBase: 4 })).toBe(true);
		expect(policy(UNCHANGED.value, UNCHANGED.ops, { deltasSinceBase: 9 })).toBe(true);
	});

	it("refuses a limit that would never fire or would fire on every write", () => {
		expect(() => baseEveryDeltas(0)).toThrow(/at least 1/);
		expect(() => baseEveryDeltas(1.5)).toThrow(/integer/);
	});

	it("deltasOnly never checkpoints", () => {
		expect(deltasOnly(UNCHANGED.value, UNCHANGED.ops, { deltasSinceBase: 100_000 })).toBe(false);
	});
});

describe("every role-host document declares its checkpoint policy", () => {
	// The seven definitions the 1.4 upgrade has to touch (src/schedules.ts, src/watches.ts, src/needs-you.ts,
	// src/notify.ts, src/harness.ts ×2, src/integrations/effects.ts). A new document must be added here with its reason.
	const definitions: Array<[string, { definition: { checkpointWhen?: unknown } }, number | null]> = [
		["roles.conversations", RoleConversationsDoc, null],
		["roles.lastRuns", RoleLastRunsDoc, SESSION_BASE_DELTAS],
		["roles.schedules", ScheduleLedgerDoc, LEDGER_BASE_DELTAS],
		["roles.watches", WatchLedgerDoc, LEDGER_BASE_DELTAS],
		["pi-roles.needs-you-writes", NeedsYouWrites, LEDGER_BASE_DELTAS],
		["pi-roles.notifications", RoleNotifications, LEDGER_BASE_DELTAS],
		["roles.integrations-outbox", IntegrationOutbox, SESSION_BASE_DELTAS],
	];

	it("declares one on all seven documents", () => {
		expect(definitions).toHaveLength(7);
		for (const [kind, token] of definitions) {
			expect([kind, typeof token.definition.checkpointWhen]).toEqual([kind, "function"]);
		}
	});

	it("gives the never-checkpointed and periodic documents the policies they declare", () => {
		for (const [kind, token, every] of definitions) {
			const policy = token.definition.checkpointWhen as (
				value: unknown,
				ops: readonly unknown[],
				info: { deltasSinceBase: number },
			) => boolean;
			if (every === null) {
				expect([kind, policy(UNCHANGED.value, UNCHANGED.ops, { deltasSinceBase: 5_000 })]).toEqual([kind, false]);
				continue;
			}
			expect([kind, policy(UNCHANGED.value, UNCHANGED.ops, { deltasSinceBase: every - 1 })]).toEqual([kind, false]);
			expect([kind, policy(UNCHANGED.value, UNCHANGED.ops, { deltasSinceBase: every })]).toEqual([kind, true]);
		}
	});
});

describe("a periodic base really bounds the stored revisions (real SQLite)", () => {
	it("drops the deltas behind the newest base and replays at most one period", async () => {
		const dir = await mkdtemp(join(tmpdir(), "sr-checkpoint-"));
		roots.push(dir);
		const dbPath = join(dir, "checkpoint.db");
		const Counter = defineDoc<{ n: number }>({
			kind: "test.counter",
			version: 1,
			scope: "session",
			initial: () => ({ n: 0 }),
			checkpointWhen: baseEveryDeltas(4),
		});
		const { hostModels, defaultModel } = makeFauxHostModels();
		const storage = await openNodeSqliteStorage(dbPath);
		const harness = await Harness.open(storage, { models: hostModels.models, registry: createRegistry() }, context);
		const writes = 12;
		for (let i = 0; i < writes; i++) {
			await harness.commit(async (tx) => {
				const doc = await tx.doc(Counter);
				doc.n += 1;
			}, context);
		}
		expect((await harness.snapshot(Counter, context))?.n).toBe(writes);
		await harness.close(context);

		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(dbPath, { readOnly: true });
		try {
			// The storage stores a document's `kind` JSON-encoded, hence JSON.stringify below.
			const rows = db
				.prepare(
					"SELECT r.kind AS kind, COUNT(*) AS n FROM document_revisions r JOIN documents d ON d.id = r.document_id WHERE d.kind = ? GROUP BY r.kind ORDER BY r.kind",
				)
				.all(JSON.stringify("test.counter")) as Array<{ kind: string; n: number }>;
			const byKind = Object.fromEntries(rows.map((row) => [row.kind, Number(row.n)]));
			// Every base rewrite deletes the earlier revisions of a current-only document, so exactly one base and at
			// most one period of deltas survive twelve writes.
			expect(byKind["base"]).toBe(1);
			expect(byKind["delta"] ?? 0).toBeLessThanOrEqual(4);
			expect(byKind["base"] + (byKind["delta"] ?? 0)).toBeLessThanOrEqual(5);
		} finally {
			db.close();
		}
	}, 30_000);
});
