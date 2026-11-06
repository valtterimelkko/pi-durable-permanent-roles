/**
 * The durable integration outbox: presence cards and memory captures ride a queue, never a role's critical path.
 *
 * An effect is written durably at enqueue time, with its fully built argv frozen, so a later code change cannot alter
 * what a queued effect does. A pump delivers one entry at a time, marks the attempt before the call and the result
 * after it, and backs off (2 s → 60 s) when the integration is down or slow: an integration being down means effects
 * wait, never that a run fails.
 *
 * At-most-once per dedupe key. A presence register is idempotent by design (re-registering the same card updates
 * it), and a capture carries its idempotency key, so an entry a crash left `inflight` is re-armed at the next start
 * and the replay is safe. The queue is a session document: one outbox serves every role.
 */
import { BACKGROUND_CONTEXT as BACKGROUND } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { defineDoc, type Harness, type Tx } from "@earendil-works/pi-durable";
import { baseEveryDeltas, SESSION_BASE_DELTAS } from "../doc-checkpoint.ts";
import { WRITE_TIMEOUT_MS } from "../args.ts";
import type { ExternalCli } from "./types.ts";

export type OutboxEntry = {
	dedupeKey: string;
	/** Monotonic enqueue order: the pump takes the oldest due entry first. */
	seq: number;
	/** The fully built CLI argv, frozen at enqueue time. */
	argv: string[];
	attempts: number;
	/** Epoch ms: no attempt before this. */
	nextAttemptAtMs: number;
	state: "pending" | "inflight" | "done";
	deliveredAtMs?: number;
	lastError?: string;
};

export type OutboxState = {
	nextSeq: number;
	entries: Record<string, OutboxEntry>;
};

/** One session-wide queue, shared by every role. */
export const IntegrationOutbox = defineDoc<OutboxState>({
	kind: "roles.integrations-outbox",
	version: 1,
	scope: "session",
	initial: () => ({ nextSeq: 1, entries: {} }),
	// Written on every enqueue, delivery attempt and prune, and its value carries every undelivered effect: a base
	// every 128 deltas keeps base rewrites cheap while still bounding the replay.
	checkpointWhen: baseEveryDeltas(SESSION_BASE_DELTAS),
});

/** Delivered entries are kept this long as dedupe memory, then pruned. */
const DELIVERED_RETENTION_MS = 24 * 60 * 60 * 1_000;

/** Deliveries per pass: a burst is drained without starving the event loop. */
const MAX_PER_PASS = 20;

/** Backoff after `attempts` failures: 2 s, 4 s, 8 s … capped at 60 s. */
export function backoffDelayMs(attempts: number): number {
	return Math.min(60_000, 2 ** Math.max(1, attempts) * 1_000);
}

export type EnqueueRequest = {
	dedupeKey: string;
	argv: string[];
	/**
	 * A presence card is re-registered on every heartbeat, so a delivered key can be re-armed. Captures are never
	 * re-armed: their key is their idempotency key.
	 */
	refresh?: boolean;
};

/**
 * Queue one effect inside the caller's commit. Idempotent per dedupe key: a replayed commit finds the entry its first
 * attempt recorded and adds nothing. The argv always comes from the pure builders in `argv.ts`; there is no second
 * validation pass, because the runner passes it without a shell.
 */
export async function enqueueIntegrationEffect(
	tx: Tx,
	request: EnqueueRequest,
): Promise<"queued" | "refreshed" | "duplicate"> {
	const doc = await tx.doc(IntegrationOutbox);
	const existing = doc.entries[request.dedupeKey];
	if (existing !== undefined) {
		if (existing.state !== "done" || request.refresh !== true) return "duplicate";
		existing.state = "pending";
		existing.attempts = 0;
		existing.nextAttemptAtMs = 0;
		existing.argv = [...request.argv];
		existing.seq = doc.nextSeq;
		existing.deliveredAtMs = undefined;
		existing.lastError = undefined;
		doc.nextSeq += 1;
		return "refreshed";
	}
	doc.entries[request.dedupeKey] = {
		dedupeKey: request.dedupeKey,
		seq: doc.nextSeq,
		argv: [...request.argv],
		attempts: 0,
		nextAttemptAtMs: 0,
		state: "pending",
	};
	doc.nextSeq += 1;
	return "queued";
}

/**
 * Re-arm entries a crash left `inflight`. Called once when the pump starts: the call may or may not have reached the
 * CLI, and both shapes of the effect are safe to repeat (a presence register is idempotent; a capture carries its key).
 */
export async function recoverInflightEntries(tx: Tx): Promise<number> {
	const doc = await tx.doc(IntegrationOutbox);
	let recovered = 0;
	for (const entry of Object.values(doc.entries)) {
		if (entry.state !== "inflight") continue;
		entry.state = "pending";
		entry.nextAttemptAtMs = 0;
		recovered += 1;
	}
	return recovered;
}

export type PumpDeps = {
	harness: Harness;
	runner: ExternalCli;
	now?: () => number;
	log?: (line: string) => void;
};

const NOOP_LOG = (): void => undefined;

function oldestDue(state: Readonly<OutboxState> | undefined, now: number): OutboxEntry | undefined {
	return Object.values(state?.entries ?? {})
		.filter((entry) => entry.state === "pending" && entry.nextAttemptAtMs <= now)
		.sort((left, right) => left.seq - right.seq)[0];
}

function pruneDelivered(doc: OutboxState, now: number): void {
	for (const [key, entry] of Object.entries(doc.entries)) {
		if (entry.state === "done" && entry.deliveredAtMs !== undefined && now - entry.deliveredAtMs > DELIVERED_RETENTION_MS) {
			delete doc.entries[key];
		}
	}
}

/**
 * Deliver every due entry, oldest first, at most once each. Never throws: a failing or missing integration leaves
 * entries pending with their error recorded.
 */
export async function pumpOutboxOnce(
	deps: PumpDeps,
	context: Context = BACKGROUND,
): Promise<{ delivered: number; failed: number }> {
	const now = deps.now ?? Date.now;
	const log = deps.log ?? NOOP_LOG;
	let delivered = 0;
	let failed = 0;
	for (let round = 0; round < MAX_PER_PASS; round++) {
		const due = oldestDue(await deps.harness.snapshot(IntegrationOutbox, context), now());
		if (due === undefined) break;
		// Claim: the attempt counter steps durably before the call, and the entry leaves `pending`.
		const claimed = await deps.harness.commit(async (tx) => {
			const doc = await tx.doc(IntegrationOutbox);
			const entry = doc.entries[due.dedupeKey];
			if (entry === undefined || entry.state !== "pending" || entry.nextAttemptAtMs > now()) return false;
			entry.state = "inflight";
			entry.attempts += 1;
			return true;
		}, context);
		if (!claimed) continue;

		let ok = false;
		let error: string | undefined;
		try {
			const result = await deps.runner.run(due.argv, { timeoutMs: WRITE_TIMEOUT_MS });
			ok = result.code === 0;
			if (!ok) error = (result.stderr.trim() || `integration command exited ${result.code}`).slice(0, 200);
		} catch (thrown) {
			error = (thrown instanceof Error ? thrown.message : String(thrown)).slice(0, 200);
		}

		await deps.harness.commit(async (tx) => {
			const doc = await tx.doc(IntegrationOutbox);
			const entry = doc.entries[due.dedupeKey];
			if (entry === undefined || entry.state === "done") return;
			if (ok) {
				entry.state = "done";
				entry.deliveredAtMs = now();
				entry.lastError = undefined;
			} else {
				entry.state = "pending";
				entry.nextAttemptAtMs = now() + backoffDelayMs(entry.attempts);
				entry.lastError = error;
			}
			pruneDelivered(doc, now());
		}, context);

		if (ok) delivered += 1;
		else {
			failed += 1;
			log(`outbox: ${due.dedupeKey} failed: ${error ?? "unknown error"}`);
		}
	}
	return { delivered, failed };
}

export type OutboxPump = {
	/** Deliver now instead of waiting for the next interval (called after an enqueue). */
	kick(): void;
	/** One delivery pass, awaited (used by tests and by a graceful shutdown). */
	pass(): Promise<{ delivered: number; failed: number }>;
	/** Stop the loop; bounded, never throws. */
	stop(): Promise<void>;
};

/** The polling pump: one pass per interval, one entry at a time inside the pass. */
export function startOutboxPump(deps: PumpDeps & { intervalMs?: number }): OutboxPump {
	const intervalMs = deps.intervalMs ?? 2_000;
	let stopped = false;
	let timer: NodeJS.Timeout | undefined;
	let wake: (() => void) | undefined;

	const sleep = (ms: number): Promise<void> =>
		new Promise((resolve) => {
			wake = () => resolve();
			timer = setTimeout(() => {
				wake = undefined;
				timer = undefined;
				resolve();
			}, ms);
			timer.unref?.();
		});

	const loop = (async () => {
		// Entries a crash left `inflight` are re-armed once at start (their delivery is safe to repeat).
		try {
			await deps.harness.commit((tx) => recoverInflightEntries(tx), BACKGROUND);
		} catch (thrown) {
			(deps.log ?? NOOP_LOG)(`outbox: recovery failed: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
		}
		while (!stopped) {
			try {
				await pumpOutboxOnce(deps);
			} catch (thrown) {
				(deps.log ?? NOOP_LOG)(`outbox: pass failed: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
			}
			if (stopped) break;
			await sleep(intervalMs);
		}
	})();

	return {
		kick() {
			wake?.();
		},
		pass() {
			return pumpOutboxOnce(deps);
		},
		async stop() {
			stopped = true;
			wake?.();
			if (timer !== undefined) clearTimeout(timer);
			await Promise.race([
				loop.then(() => undefined),
				new Promise<void>((resolve) => {
					const t = setTimeout(resolve, 2_000);
					t.unref?.();
				}),
			]);
		},
	};
}
