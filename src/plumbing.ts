/**
 * `createPlumbing` — the wiring the core host installs: the tool groups, the durable outbox, the presence cards with
 * their heartbeat, and the inbox carrier, all behind the `Plumbing` interface in `types.ts`.
 *
 * Everything here is off a role's critical path. A tool call queues durable work and returns; the outbox delivers it
 * with backoff; presence and the carrier poll on their own timers. `stop()` is bounded and cannot throw, because the
 * host calls it during shutdown, before it closes the harness.
 *
 * Two modes, chosen by the config (src/config.ts):
 * - CLI mode (STANDING_ROLES_INTEGRATIONS=on + command set): presence effects and memory captures queue durably and
 *   the pump delivers them through the integration CLI; the carrier polls the integration's inbox.
 * - Stub mode (default): nothing queues and nothing leaves the host — captures land in the state directory's JSONL
 *   file, presence is a no-op, the inbox always answers empty, so the loops are not started at all.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Extension } from "@earendil-works/pi-durable";
import type { HostApi, Plumbing, PlumbingOptions, RoleDefinition } from "./types.ts";
import { buildMemoryCaptureArgv } from "./integrations/argv.ts";
import { IDLE_PRESENCE_STATE, heartbeatEffects, presenceEffect, type PresenceEffect, type PresenceState } from "./integrations/presence.ts";
import { startOutboxPump, type EnqueueRequest, type OutboxPump, enqueueIntegrationEffect } from "./integrations/effects.ts";
import { integrationsExtension } from "./integrations/tools.ts";
import { notifyExtension, notifyTasksExtension, setOwnerNotifier } from "./notify.ts";
import { startCarrier, type Carrier } from "./carrier.ts";

/** How long `stop()` waits for the loops: the host is shutting down, so a stuck loop must not hold it. */
const STOP_TIMEOUT_MS = 2_000;

/** The outbox pass interval: short, because `kick()` normally delivers a queued effect within milliseconds. */
const OUTBOX_INTERVAL_MS = 2_000;

/**
 * What `createPlumbing` adds beyond the `Plumbing` interface: the reload path queues every enabled role's
 * presence card at once, exactly as start does, instead of waiting up to ten minutes for the heartbeat.
 */
export interface PlumbingWithPresenceRefresh extends Plumbing {
	refreshPresenceCards(): void;
}

export function createPlumbing(options: PlumbingOptions): PlumbingWithPresenceRefresh {
	const log = (line: string): void => console.error(`[pi-roles] ${line}`);
	const cliMode = options.integrationsCli !== undefined;
	const states = new Map<string, PresenceState>();
	let host: HostApi | undefined;
	let outbox: OutboxPump | undefined;
	let carrier: Carrier | undefined;
	let heartbeat: NodeJS.Timeout | undefined;
	let stopping = false;

	/** Queue one integration effect durably, then wake the pump so it is delivered now rather than at the next pass. */
	const enqueue = async (request: EnqueueRequest): Promise<void> => {
		const current = host;
		if (current === undefined || stopping) throw new Error("the role host is not running");
		await current.harness.commit((tx) => enqueueIntegrationEffect(tx, request), BACKGROUND_CONTEXT);
		outbox?.kick();
	};

	/** Presence cards are never on the critical path: queue and forget, logging anything that cannot be queued. */
	const queuePresence = (effect: PresenceEffect): void => {
		void enqueue(effect).catch((error: unknown) => {
			log(`presence: could not queue ${effect.dedupeKey}: ${error instanceof Error ? error.message : String(error)}`);
		});
	};

	const integrations = integrationsExtension({
		cli: options.integrationsCli,
		capture: async ({ note, idempotencyKey }) => {
			if (cliMode) {
				await enqueue({ dedupeKey: `capture:${idempotencyKey}`, argv: buildMemoryCaptureArgv({ note, idempotencyKey }) });
				return;
			}
			// Stub mode: the capture lands in the state directory's JSONL file, inline (it is a local append).
			await options.integrations.memory.capture({ note, idempotencyKey });
		},
		channel: options.integrations.channel,
		roleForConversation: (conversationId) => host?.roleForConversation(conversationId),
	});

	const notify = notifyExtension({
		stateDir: process.env.STANDING_ROLES_STATE_DIR,
		roleForConversation: (conversationId) => host?.roleForConversation(conversationId),
		currentSlot: (roleName) => host?.currentSlot(roleName),
	});

	const presenceFor = (role: RoleDefinition): void => {
		if (!cliMode) return; // stub mode: nowhere to publish a card
		queuePresence(presenceEffect(role, states.get(role.name) ?? IDLE_PRESENCE_STATE));
	};

	return {
		extensions(): { integrations: Extension; notify: Extension; tasks: Extension[] } {
			return { integrations, notify, tasks: [notifyTasksExtension] };
		},

		async start(next: HostApi): Promise<void> {
			if (host !== undefined) return;
			host = next;
			stopping = false;
			setOwnerNotifier(options.notify);
			if (cliMode) {
				outbox = startOutboxPump({
					harness: next.harness,
					runner: options.integrationsCli!,
					intervalMs: OUTBOX_INTERVAL_MS,
					log,
				});
				carrier = startCarrier({
					host: next,
					inbox: options.integrations.inbox,
					intervalMs: options.carrierIntervalMs ?? 5_000,
					log,
				});
			}
			// Every enabled role gets its card at start, then the heartbeat keeps it current.
			for (const role of next.roles()) {
				if (role.settings.enabled) presenceFor(role);
			}
			if (!cliMode) return;
			const intervalMs = options.heartbeatIntervalMs ?? 600_000;
			heartbeat = setInterval(() => {
				if (host === undefined || stopping) return;
				for (const effect of heartbeatEffects(host.roles(), states)) queuePresence(effect);
			}, intervalMs);
			heartbeat.unref?.();
		},

		async stop(): Promise<void> {
			stopping = true;
			if (heartbeat !== undefined) {
				clearInterval(heartbeat);
				heartbeat = undefined;
			}
			const loops: Array<Promise<void>> = [];
			if (outbox !== undefined) loops.push(outbox.stop());
			if (carrier !== undefined) loops.push(carrier.stop());
			outbox = undefined;
			carrier = undefined;
			await Promise.race([
				Promise.allSettled(loops).then(() => undefined),
				new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, STOP_TIMEOUT_MS);
					timer.unref?.();
				}),
			]);
			setOwnerNotifier(undefined);
			host = undefined;
		},

		runStarted(role: RoleDefinition, step: string): void {
			states.set(role.name, { status: "working", step });
			if (host === undefined || stopping) return;
			presenceFor(role);
		},

		runEnded(role: RoleDefinition): void {
			states.set(role.name, { status: "waiting", step: "idle" });
			if (host === undefined || stopping) return;
			presenceFor(role);
		},

		/** Queue the card for every enabled role now (start's rule); the reload path calls this. */
		refreshPresenceCards(): void {
			if (host === undefined || stopping) return;
			for (const role of host.roles()) {
				if (role.settings.enabled) presenceFor(role);
			}
		},
	};
}
