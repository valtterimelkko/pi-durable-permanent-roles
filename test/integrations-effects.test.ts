/**
 * The durable integration outbox: presence cards and captures ride a queue, never the critical path.
 *
 * An integration is never on a role's critical path. An effect is written durably at enqueue time with its fully built argv
 * frozen; a pump delivers it at most once per dedupe key, with backoff when the command is down or slow.
 * A crash mid-delivery leaves the entry `inflight`; the next start re-arms it (a board register is idempotent and a
 * capture carries its idempotency key, so the replay is safe).
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { describe, expect, it } from "vitest";
import type { ExternalCli } from "../src/integrations/types.ts";
import {
	IntegrationOutbox,
	backoffDelayMs,
	enqueueIntegrationEffect,
	pumpOutboxOnce,
	recoverInflightEntries,
	startOutboxPump,
	type OutboxEntry,
} from "../src/integrations/effects.ts";

const context: Context = BACKGROUND_CONTEXT;

async function openHarness(): Promise<Harness> {
	return Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, context);
}

const curlArgv = ["board", "who"];

function recordingRunner(
	results: Array<{ code: number; stdout?: string; stderr?: string }> = [],
): { runner: ExternalCli; calls: string[][] } {
	const calls: string[][] = [];
	const runner: ExternalCli = {
		async run(argv) {
			calls.push([...argv]);
			const next = results.shift();
			return { code: next?.code ?? 0, stdout: next?.stdout ?? "", stderr: next?.stderr ?? "" };
		},
	};
	return { runner, calls };
}

async function entries(harness: Harness): Promise<Record<string, OutboxEntry>> {
	const state = await harness.snapshot(IntegrationOutbox, context);
	return (state?.entries ?? {}) as Record<string, OutboxEntry>;
}

describe("enqueueing", () => {
	it("records the entry durably with its argv, once per dedupe key", async () => {
		const harness = await openHarness();
		try {
			await harness.commit(async (tx) => {
				expect(await enqueueIntegrationEffect(tx, { dedupeKey: "board-1", argv: curlArgv })).toBe("queued");
				expect(await enqueueIntegrationEffect(tx, { dedupeKey: "board-1", argv: curlArgv })).toBe("duplicate");
			}, context);
			const stored = await entries(harness);
			expect(Object.keys(stored)).toEqual(["board-1"]);
			expect(stored["board-1"]).toMatchObject({
				dedupeKey: "board-1",
				argv: curlArgv,
				state: "pending",
				attempts: 0,
			});
		} finally {
			await harness.close(context);
		}
	});

	it("re-arms a delivered board card when the caller asks for a refresh (the heartbeat)", async () => {
		const harness = await openHarness();
		try {
			await harness.commit(
				(tx) => enqueueIntegrationEffect(tx, { dedupeKey: "board-1", argv: curlArgv }),
				context,
			);
			const { runner } = recordingRunner();
			await pumpOutboxOnce({ harness, runner }, context);
			expect((await entries(harness))["board-1"].state).toBe("done");
			await harness.commit(
				(tx) => enqueueIntegrationEffect(tx, { dedupeKey: "board-1", argv: curlArgv, refresh: true }),
				context,
			);
			const after = (await entries(harness))["board-1"];
			expect(after.state).toBe("pending");
			expect(after.attempts).toBe(0);
			// Without refresh the delivered key stays delivered: captures must never be re-sent.
			await harness.commit(
				(tx) => enqueueIntegrationEffect(tx, { dedupeKey: "board-1", argv: curlArgv, refresh: false }),
				context,
			);
			expect((await entries(harness))["board-1"].state).toBe("pending");
		} finally {
			await harness.close(context);
		}
	});

	it("delivers a pending entry with exactly its frozen argv and marks it done", async () => {
		const harness = await openHarness();
		try {
			await harness.commit((tx) => enqueueIntegrationEffect(tx, { dedupeKey: "k1", argv: curlArgv }), context);
			const { runner, calls } = recordingRunner();
			const result = await pumpOutboxOnce({ harness, runner }, context);
			expect(result).toEqual({ delivered: 1, failed: 0 });
			expect(calls).toEqual([curlArgv]);
			const entry = (await entries(harness))["k1"];
			expect(entry.state).toBe("done");
			expect(entry.deliveredAtMs).toBeGreaterThan(0);
			// Nothing is delivered twice.
			await pumpOutboxOnce({ harness, runner }, context);
			expect(calls).toHaveLength(1);
		} finally {
			await harness.close(context);
		}
	});

	it("backs off after a failed call and retries once the delay has passed", async () => {
		const harness = await openHarness();
		let nowMs = 1_000_000;
		try {
			await harness.commit((tx) => enqueueIntegrationEffect(tx, { dedupeKey: "k1", argv: curlArgv }), context);
			const { runner, calls } = recordingRunner([{ code: 1, stderr: "integration: store locked" }]);
			const first = await pumpOutboxOnce({ harness, runner, now: () => nowMs }, context);
			expect(first).toEqual({ delivered: 0, failed: 1 });
			const failed = (await entries(harness))["k1"];
			expect(failed.state).toBe("pending");
			expect(failed.attempts).toBe(1);
			expect(failed.lastError).toBe("integration: store locked");
			expect(failed.nextAttemptAtMs).toBe(nowMs + backoffDelayMs(1));
			// Too early: the pump leaves it alone.
			await pumpOutboxOnce({ harness, runner, now: () => nowMs }, context);
			expect(calls).toHaveLength(1);
			// After the delay: delivered, and the error cleared.
			nowMs += backoffDelayMs(1);
			const second = await pumpOutboxOnce({ harness, runner, now: () => nowMs }, context);
			expect(second).toEqual({ delivered: 1, failed: 0 });
			const delivered = (await entries(harness))["k1"];
			expect(delivered.state).toBe("done");
			expect(delivered.lastError).toBeUndefined();
		} finally {
			await harness.close(context);
		}
	});

	it("re-arms an entry a crash left inflight, then delivers it once", async () => {
		const harness = await openHarness();
		try {
			await harness.commit(async (tx) => {
				const doc = await tx.doc(IntegrationOutbox);
				doc.entries["k1"] = {
					dedupeKey: "k1",
					seq: 1,
					argv: curlArgv,
					attempts: 1,
					nextAttemptAtMs: 0,
					state: "inflight",
				};
			}, context);
			await harness.commit((tx) => recoverInflightEntries(tx), context);
			expect((await entries(harness))["k1"].state).toBe("pending");
			const { runner, calls } = recordingRunner();
			await pumpOutboxOnce({ harness, runner }, context);
			expect(calls).toEqual([curlArgv]);
			expect((await entries(harness))["k1"].state).toBe("done");
		} finally {
			await harness.close(context);
		}
	});

	it("never throws when the runner itself throws", async () => {
		const harness = await openHarness();
		try {
			await harness.commit((tx) => enqueueIntegrationEffect(tx, { dedupeKey: "k1", argv: curlArgv }), context);
			const runner: ExternalCli = {
				async run() {
					throw new Error("spawn ENOENT");
				},
			};
			const result = await pumpOutboxOnce({ harness, runner }, context);
			expect(result).toEqual({ delivered: 0, failed: 1 });
			expect((await entries(harness))["k1"].lastError).toMatch(/ENOENT/);
		} finally {
			await harness.close(context);
		}
	});
});

describe("the pump loop", () => {
	it("delivers queued work and stops on request", async () => {
		const harness = await openHarness();
		try {
			const { runner, calls } = recordingRunner();
			const pump = startOutboxPump({ harness, runner, intervalMs: 10 });
			await harness.commit((tx) => enqueueIntegrationEffect(tx, { dedupeKey: "k1", argv: curlArgv }), context);
			pump.kick();
			await waitFor(() => calls.length === 1);
			await pump.stop();
			await harness.commit((tx) => enqueueIntegrationEffect(tx, { dedupeKey: "k2", argv: curlArgv }), context);
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(calls).toHaveLength(1);
		} finally {
			await harness.close(context);
		}
	});

	it("is bounded when a delivery is in flight at stop time", async () => {
		const harness = await openHarness();
		try {
			let release: (() => void) | undefined;
			const runner: ExternalCli = {
				async run() {
					await new Promise<void>((resolve) => {
						release = resolve;
					});
					return { code: 0, stdout: "", stderr: "" };
				},
			};
			const pump = startOutboxPump({ harness, runner, intervalMs: 10 });
			await harness.commit((tx) => enqueueIntegrationEffect(tx, { dedupeKey: "k1", argv: curlArgv }), context);
			pump.kick();
			await waitFor(() => release !== undefined);
			release?.();
			await expect(pump.stop()).resolves.toBeUndefined();
		} finally {
			await harness.close(context);
		}
	});
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("condition never became true");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
