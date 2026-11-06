/**
 * Presence effects: the card for each role on the shared board (when an integration provides one).
 *
 * A card is registered at host start, when a run starts and ends, and every heartbeat re-registers every enabled
 * role with its current status, so the board shows a role as working or waiting and stale cards cannot linger.
 * There is no `idle`: a finished run reports `waiting` with the step `idle`.
 *
 * Effects are pure values (argv + dedupe key + refresh) so the plumbing can queue them through the outbox and tests
 * can assert the exact argv. Re-registering a card is idempotent, so a delivered key is re-armed on the next
 * heartbeat, while a key still pending (the integration down) is simply reused instead of piling up.
 */
import { createHash } from "node:crypto";
import type { RoleDefinition } from "../types.ts";
import { buildPresenceRegisterArgv, type PresenceStatus } from "./argv.ts";

export type PresenceState = { status: PresenceStatus; step: string };

/** A role that has not run yet is waiting, with nothing in hand. */
export const IDLE_PRESENCE_STATE: PresenceState = { status: "waiting", step: "idle" };

export type PresenceEffect = {
	dedupeKey: string;
	argv: string[];
	/** A presence card is re-registered on every heartbeat, so a delivered key may be re-armed. */
	refresh: true;
};

function stepHash(step: string): string {
	return createHash("sha256").update(step).digest("hex").slice(0, 8);
}

/** The register effect for one role in one state. */
export function presenceEffect(role: RoleDefinition, state: PresenceState): PresenceEffect {
	const argv = buildPresenceRegisterArgv({
		name: role.settings.boardName,
		title: role.settings.title,
		step: state.step,
		status: state.status,
	});
	return {
		dedupeKey: `presence:${role.settings.boardName}:${state.status}:${stepHash(state.step)}`,
		argv,
		refresh: true,
	};
}

/** Every enabled role's heartbeat, in the order the host lists them. */
export function heartbeatEffects(
	roles: readonly RoleDefinition[],
	states: ReadonlyMap<string, PresenceState>,
): PresenceEffect[] {
	return roles
		.filter((role) => role.settings.enabled)
		.map((role) => presenceEffect(role, states.get(role.name) ?? IDLE_PRESENCE_STATE));
}
