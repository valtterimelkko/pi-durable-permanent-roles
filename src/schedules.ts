/**
 * The roles' schedules: one in-process tick (60 s, interval injectable), a durable
 * per-conversation ledger doc, and run ids `<role>:<YYYY-MM-DD>T<HH:MM>` in the host's time zone
 * (STANDING_ROLES_TIMEZONE, default UTC; src/host-time.ts). A slot missed while the host was down
 * is caught up late, once, the same zone-day; older ones are skipped. The submit happens
 * first (the stable requestId dedupes a crash between submit and ledger mark), then the ledger mark in its own commit; a crash gate sits between the two for
 * the crash tests. A run is a submitted input "Scheduled run <slot>. <runPrompt or the
 * default>" with requestId `run:<slot id>`, whenBusy followUp.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { defineDoc, type ConversationId } from "@earendil-works/pi-durable";
import { crashPoint } from "./crash-gate.ts";
import { zoneMs, zoneParts } from "./host-time.ts";
import { baseEveryDeltas, LEDGER_BASE_DELTAS } from "./doc-checkpoint.ts";
import type { RoleHost } from "./harness.ts";
import type { RoleDefinition } from "./types.ts";

export const DEFAULT_RUN_PROMPT =
	"Work through your instructions for this round, update your notes, and notify the owner only if there is something for them.";

/** Per-role ledger: the runs already created (the find-before-create guard). */
export const ScheduleLedgerDoc = defineDoc<{ createdRuns: Record<string, true>; lastRunAtMs: number | null }>({
	kind: "roles.schedules",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ createdRuns: {}, lastRunAtMs: null }),
	// A growing set of run ids plus one write per run (src/doc-checkpoint.ts): a periodic base bounds the replay.
	checkpointWhen: baseEveryDeltas(LEDGER_BASE_DELTAS),
});

/** Run ids older than this many days are dropped from the ledger: the find-before-create guard only needs today's slots. */
const LEDGER_KEEP_DAYS = 7;

/** Drop ledger entries whose slot date (`<role>:<YYYY-MM-DD>T<HH:MM>`) is before `today` minus the keep window. */
function pruneLedger(createdRuns: Record<string, true>, today: string): void {
	const [y, m, d] = today.split("-").map(Number);
	const cutoff = new Date(Date.UTC(y, m - 1, d - LEDGER_KEEP_DAYS)).toISOString().slice(0, 10);
	for (const id of Object.keys(createdRuns)) {
		const slotDate = /(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}$/.exec(id)?.[1];
		if (slotDate !== undefined && slotDate < cutoff) delete createdRuns[id];
	}
}

/** The host-zone calendar date, HH:MM and weekday of an instant (src/host-time.ts). */
export const zonePartsOf = zoneParts;

/** The UTC instant of a host-zone wall-clock date and HH:MM (corrects twice for DST edges). */
export const zoneMsOf = zoneMs;

/** The next run of a role's schedule after `nowMs` (the host's time zone), or null with no slots. */
export function nextRunAtMs(role: RoleDefinition, nowMs: number): number | null {
	const { date } = zoneParts(nowMs);
	const dayNumber = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
	const candidates: number[] = [];
	for (let offset = 0; offset < 8; offset++) {
		const ms = dayNumber + offset * 86_400_000;
		const { weekday } = zoneParts(ms);
		for (const slot of role.settings.schedule) {
			if (slot.days === "weekdays" && (weekday === "Sat" || weekday === "Sun")) continue;
			const at = zoneMs(zoneParts(ms).date, slot.at);
			if (at > nowMs) candidates.push(at);
		}
		if (candidates.length > 0) break;
	}
	return candidates.length === 0 ? null : Math.min(...candidates);
}

export type Scheduler = {
	stop(): void;
	/** One due-ness pass; returns the slot ids submitted (run ids without the "run:" prefix). */
	tick(): Promise<string[]>;
};

export function startSchedulers(options: {
	host: RoleHost;
	/** config.schedules: nothing runs when false. */
	enabled: boolean;
	clock?: () => number;
	intervalMs?: number;
	context?: Context;
	/** The requestId prefix (default "run:"); the crash test's RED knob uses another one. */
	requestIdPrefix?: string;
}): Scheduler {
	const clock = options.clock ?? (() => Date.now());
	const intervalMs = options.intervalMs ?? 60_000;
	const requestIdPrefix = options.requestIdPrefix ?? "run:";
	const context = options.context ?? BACKGROUND_CONTEXT;
	let stopped = false;
	let ticking = false;

	const tick = async (): Promise<string[]> => {
		if (!options.enabled || stopped || ticking) return [];
		ticking = true;
		const submitted: string[] = [];
		try {
			for (const role of options.host.roles()) {
				if (role.settings.schedule.length === 0) continue;
				const { date, time, weekday } = zoneParts(clock());
				for (const slot of role.settings.schedule) {
					if (slot.days === "weekdays" && (weekday === "Sat" || weekday === "Sun")) continue;
					if (time < slot.at) continue; // not due yet today
					const slotId = `${role.name}:${date}T${slot.at}`;
					const conversation = await options.host.conversation(role.name);
					if (conversation === undefined) continue;
					const ledger = await options.host.harness.snapshot(ScheduleLedgerDoc, conversation.id, context);
					if (ledger?.createdRuns[slotId] === true) continue;
					const content = `Scheduled run ${slot.at}. ${role.settings.runPrompt ?? DEFAULT_RUN_PROMPT}`;
					await options.host.submit(role.name, { content, requestId: `${requestIdPrefix}${slotId}`, step: slotId });
					// Crash point: after the submit (durable, requestId will dedupe) and before
					// the ledger mark. Only a test arms this gate.
					await crashPoint("after-submit-before-ledger");
					await options.host.harness.commit(
						async (tx) => {
							const doc = await tx.doc(ScheduleLedgerDoc, conversation.id as ConversationId);
							doc.createdRuns[slotId] = true;
							pruneLedger(doc.createdRuns, date);
							doc.lastRunAtMs = clock();
						},
						context,
					);
					submitted.push(slotId);
				}
			}
		} finally {
			ticking = false;
		}
		return submitted;
	};

	const timer = setInterval(() => void tick().catch(() => undefined), intervalMs);
	timer.unref?.();
	return {
		stop() {
			stopped = true;
			clearInterval(timer);
		},
		tick,
	};
}
