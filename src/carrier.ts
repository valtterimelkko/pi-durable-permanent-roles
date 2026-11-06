/**
 * The inbox carrier: messages addressed to a role by name reach its conversation.
 *
 * Each enabled role has a presence name (settings.boardName). This loop claims that role's pending messages through
 * the configured inbox integration, submits each into the role's conversation as a user input, and marks the message
 * delivered; a submit that throws marks it failed with a short reason, so the sender's record is honest.
 *
 * A crash between the claim and the submit can leave a message claimed-but-undelivered, where the next claim never
 * looks. The carrier therefore runs one recovery pass when it starts (and only then): it lists the integration's
 * claimed-but-undelivered messages, then re-submits with the same `requestId` and marks the same way as the normal
 * path. The listing carries no message text, so a stranded message is passed on as a notice naming its id and
 * origin: the role is told to ask the sender to resend.
 *
 * Two guarantees the host needs:
 * - `requestId: inbox:<id>` makes delivery idempotent: Pi Durable delivers the same request id at most once, across a
 *   crash and resume, so a claim replayed after a restart cannot put the same message in front of the role twice.
 * - nothing escapes the loop. A failing claim backs its role off (interval × 2ⁿ, capped) and logs; the other roles
 *   and the next pass carry on.
 */
import { singleLine } from "./args.ts";
import type { HostApi, RoleDefinition } from "./types.ts";
import type { PeerInbox } from "./integrations/types.ts";

const DEFAULT_INTERVAL_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;

type RoleCarrierState = { failures: number; nextAttemptAtMs: number };

export type CarrierDeps = {
	host: HostApi;
	/** The configured inbox bridge (the CLI integration, or the stub that always answers no messages). */
	inbox: PeerInbox;
	log?: (line: string) => void;
};

export type CarrierResult = { claimed: number; delivered: number; failed: number };

function reason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Submit one message into the role's conversation and record the outcome, exactly the same way for a claimed message
 * and for one recovered at start-up: `requestId inbox:<id>` (Pi Durable delivers it at most once), then the mark.
 */
async function submitAndMark(
	deps: CarrierDeps,
	role: RoleDefinition,
	message: { id: string; content: string },
): Promise<"delivered" | "failed"> {
	const log = deps.log ?? (() => undefined);
	let failure: string | undefined;
	try {
		await deps.host.submit(role.name, { content: message.content, requestId: `inbox:${message.id}` });
	} catch (thrown) {
		failure = `submit failed: ${reason(thrown)}`;
	}
	try {
		await deps.inbox.mark(role.settings.boardName, {
			id: message.id,
			event: failure === undefined ? "delivered" : "failed",
			...(failure === undefined ? {} : { detail: failure }),
		});
	} catch (thrown) {
		log(`carrier: ${role.settings.boardName} mark ${message.id} failed: ${singleLine(reason(thrown), 160)}`);
	}
	if (failure === undefined) return "delivered";
	log(`carrier: ${role.settings.boardName} message ${message.id} failed: ${singleLine(failure, 160)}`);
	return "failed";
}

/**
 * One pass over every enabled role. Never throws: a claim failure backs that role off, and a submit failure marks the
 * message failed instead of leaving it pending forever.
 */
export async function carrierPass(
	deps: CarrierDeps,
	states: Map<string, RoleCarrierState>,
	now: () => number = Date.now,
): Promise<CarrierResult> {
	const log = deps.log ?? (() => undefined);
	const result: CarrierResult = { claimed: 0, delivered: 0, failed: 0 };
	for (const role of deps.host.roles()) {
		if (!role.settings.enabled) continue;
		const state = states.get(role.name) ?? { failures: 0, nextAttemptAtMs: 0 };
		states.set(role.name, state);
		if (state.nextAttemptAtMs > now()) continue;

		// Idle CPU: skip the claim when the integration's cheap hint says the role's inbox is empty. The hint is only
		// a hint: an uncertain or throwing answer claims anyway (never skip on doubt).
		if (deps.inbox.hasPending !== undefined) {
			let hasMail = true;
			try {
				hasMail = deps.inbox.hasPending(role.settings.boardName);
			} catch {
				hasMail = true;
			}
			if (!hasMail) continue;
		}

		let claimed;
		try {
			claimed = await deps.inbox.claim(role.settings.boardName);
			state.failures = 0;
			state.nextAttemptAtMs = 0;
		} catch (thrown) {
			state.failures += 1;
			state.nextAttemptAtMs = now() + Math.min(MAX_BACKOFF_MS, 2 ** state.failures * 1_000);
			log(`carrier: ${role.settings.boardName} claim failed (${state.failures} in a row): ${singleLine(reason(thrown), 160)}`);
			continue;
		}

		for (const message of claimed) {
			result.claimed += 1;
			const outcome = await submitAndMark(deps, role, message);
			if (outcome === "delivered") result.delivered += 1;
			else result.failed += 1;
		}
	}
	return result;
}

export type RecoveryResult = { recovered: number; delivered: number; failed: number; pending?: string[] };

/**
 * Start-up recovery: pass on every message a crash stranded between the claim and the delivery. Never throws; a role
 * whose listing fails is logged and skipped, and the normal claim pass carries on.
 */
export async function recoverClaimedMessages(deps: CarrierDeps, only?: ReadonlySet<string>): Promise<RecoveryResult> {
	const log = deps.log ?? (() => undefined);
	const result: RecoveryResult = { recovered: 0, delivered: 0, failed: 0 };
	const pending: string[] = [];
	for (const role of deps.host.roles()) {
		if (!role.settings.enabled) continue;
		if (only !== undefined && !only.has(role.name)) continue;
		let rows;
		try {
			rows = await deps.inbox.listClaimed(role.settings.boardName);
		} catch (thrown) {
			// At start-up the role's presence card may not exist yet, so the inbox cannot resolve the role: try
			// again on the next passes.
			log(`carrier: ${role.settings.boardName} claimed-message listing failed: ${singleLine(reason(thrown), 160)}`);
			pending.push(role.name);
			continue;
		}
		for (const row of rows) {
			result.recovered += 1;
			const origin = row.origin ?? row.via ?? "unknown";
			const content = `Message from ${origin}: [the role host claimed this message and then restarted before passing it on, so its text could not be read back (inbox ${row.id}); if you never saw it, ask the sender to resend]`;
			const outcome = await submitAndMark(deps, role, { id: row.id, content });
			if (outcome === "delivered") result.delivered += 1;
			else result.failed += 1;
		}
		if (rows.length > 0) {
			log(`carrier: ${role.settings.boardName} recovered ${rows.length} claimed message(s) stranded by a restart`);
		}
	}
	if (pending.length > 0) result.pending = pending;
	return result;
}

/** How many passes a role whose start-up recovery listing failed is retried before the carrier gives up on it. */
export const RECOVERY_RETRY_PASSES = 20;

export type Carrier = {
	/** One pass now, awaited (tests and a graceful shutdown). */
	tick(): Promise<void>;
	/** Stop the loop; bounded, never throws. A pass in flight finishes. */
	stop(): Promise<void>;
};

/** The polling loop: one pass per interval, holding no subscription of its own. */
export function startCarrier(deps: CarrierDeps & { intervalMs?: number }): Carrier {
	const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
	const states = new Map<string, RoleCarrierState>();
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

	let pendingRecovery: Set<string> | undefined;
	let recoveryRetries = 0;
	const recover = async (only?: ReadonlySet<string>): Promise<void> => {
		try {
			const result = await recoverClaimedMessages(deps, only);
			pendingRecovery = result.pending !== undefined ? new Set(result.pending) : undefined;
		} catch (thrown) {
			(deps.log ?? (() => undefined))(`carrier: recovery failed: ${singleLine(reason(thrown), 160)}`);
		}
	};

	const loop = (async () => {
		await recover();
		while (!stopped) {
			if (pendingRecovery !== undefined) {
				recoveryRetries += 1;
				if (recoveryRetries > RECOVERY_RETRY_PASSES) {
					(deps.log ?? (() => undefined))(`carrier: gave up recovering claimed messages for ${[...pendingRecovery].join(", ")}`);
					pendingRecovery = undefined;
				} else {
					await recover(pendingRecovery);
				}
			}
			try {
				await carrierPass(deps, states);
			} catch (thrown) {
				(deps.log ?? (() => undefined))(`carrier: pass failed: ${singleLine(reason(thrown), 160)}`);
			}
			if (stopped) break;
			await sleep(intervalMs);
		}
	})();

	return {
		async tick() {
			await carrierPass(deps, states);
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
