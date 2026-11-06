/**
 * Document checkpoint policies (Pi Durable 1.4's `checkpointWhen`).
 *
 * 1.4 makes `checkpointWhen` a required predicate on every `defineDoc()`/`defineDocFamily()`: it decides, at commit
 * time, whether this ordinary change is stored as a delta on top of the newest base or as a complete base itself.
 * Every document the role host defines is current-only (`scope: "session"`, or a conversation document with
 * `history: "latest"`), and the SQLite storage deletes every earlier revision when it writes a base for one of those.
 * A delta list therefore only ever grows, and each open replays the whole list; a host that keeps five permanent roles
 * for months writes these ledgers thousands of times.
 *
 * So the rule is: a document that is written repeatedly gets a periodic base, which drops the revisions behind it; a
 * document written once per role lifetime keeps plain deltas, where a base rewrite would cost more than the deltas it
 * replaces. `test/doc-checkpoint.test.ts` pins both the policy and the per-document choice.
 */
import type { CheckpointInfo } from "@earendil-works/pi-durable";

/** The predicate shape `checkpointWhen` takes (it may ignore the value and the ops). */
export type CheckpointPolicy = (
	value: unknown,
	ops: readonly unknown[],
	info: CheckpointInfo,
) => boolean;

/**
 * The ledgers a role writes on every run, send or daily check (`roles.schedules`, `roles.watches`,
 * `pi-roles.needs-you-writes`, `pi-roles.notifications`): a base every 64 deltas. At a role's busiest that
 * is a base roughly once a month, and it caps the replay on open at 64 deltas whatever the host's age.
 */
export const LEDGER_BASE_DELTAS = 64;

/**
 * The session documents whose stored value is larger — the integration outbox holds one entry per undelivered effect, and
 * `roles.lastRuns` holds an entry per role per scheduled run — so a base every 128 deltas keeps base rewrites cheap
 * while still bounding the replay for a host that runs for years.
 */
export const SESSION_BASE_DELTAS = 128;

/** Store this change as a complete base once this many deltas follow the newest one. */
export function baseEveryDeltas(maxDeltas: number): CheckpointPolicy {
	if (!Number.isInteger(maxDeltas)) throw new Error(`baseEveryDeltas: maxDeltas must be an integer, got ${maxDeltas}`);
	if (maxDeltas < 1) throw new Error(`baseEveryDeltas: maxDeltas must be at least 1, got ${maxDeltas}`);
	return (_value, _ops, info) => info.deltasSinceBase >= maxDeltas;
}

/**
 * Keep every change as a delta: for a document written a handful of times in the host's life
 * (`roles.conversations`, one write per role when its conversation is created), where replaying a few deltas is
 * cheaper than rewriting the value as a base.
 */
export function deltasOnly(_value: unknown, _ops: readonly unknown[], _info: CheckpointInfo): boolean {
	return false;
}
