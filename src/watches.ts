/**
 * The roles' watches: a host-side trigger, nothing more — thin code, intelligent
 * agent. A role's settings.json may carry a `watches` list (`src/types.ts`, validated in `src/roles.ts`);
 * for an enabled role the host runs each watch's command on its interval — only while schedules are on,
 * the same switch — and when the trimmed stdout is not `expect`, or the command exits non-zero, submits
 * ONE input to that role's conversation:
 *
 *   Watch fired: <name>. `<command>` gave "<output>", expected "<expect>". Act per your instructions.
 *
 * Each firing episode carries a durable requestId, `watch:<role>:<name>:<ISO of the first mismatch>`,
 * and is recorded in a durable per-conversation ledger, in the same pattern as the schedules
 * (src/schedules.ts): a crash between the submit and the ledger mark is deduped by the requestId; a
 * restart cannot double-submit while the episode is open; and the episode closes only when one check
 * matches `expect` again, which re-arms the watch. What the role then does is its own instructions'
 * business (R5: restore /tmp to 1777, name the culprit from the audit log, notify_owner once). No shell
 * output is kept beyond 2 KB.
 */
import { spawn } from "node:child_process";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { defineDoc, type ConversationId } from "@earendil-works/pi-durable";
import { crashPoint } from "./crash-gate.ts";
import { baseEveryDeltas, LEDGER_BASE_DELTAS } from "./doc-checkpoint.ts";
import type { RoleHost } from "./harness.ts";
import type { RoleWatch } from "./types.ts";

/** Per-role ledger: the open firing episode per watch — the watch's name → its requestId. */
export const WatchLedgerDoc = defineDoc<{ open: Record<string, string> }>({
	kind: "roles.watches",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ open: {} }),
	// Two writes per firing episode, a few watches per role (src/doc-checkpoint.ts): a periodic base bounds replay.
	checkpointWhen: baseEveryDeltas(LEDGER_BASE_DELTAS),
});

/** No shell output is kept beyond this many characters. */
export const WATCH_OUTPUT_MAX = 2048;

/** The exact input a firing submits. */
export function watchFiredContent(watch: RoleWatch, output: string): string {
	return `Watch fired: ${watch.name}. \`${watch.command}\` gave "${output}", expected "${watch.expect}". Act per your instructions.`;
}

/**
 * The prefix stamped on a firing that is submitted while the role is busy: the
 * follow-up waits behind the running turn, so its picture may be stale by delivery. HH:MM is the submit time, UTC.
 */
export function queuedWatchPrefix(nowMs: number): string {
	return `Queued since ${new Date(nowMs).toISOString().slice(11, 16)} UTC behind a running turn — what it describes may have moved on; recheck before acting.`;
}

export function watchRequestId(role: string, watch: RoleWatch, firstMismatchMs: number): string {
	return `watch:${role}:${watch.name}:${new Date(firstMismatchMs).toISOString()}`;
}

export type WatchResult = { code: number; stdout: string };
export type WatchRunner = (command: string) => Promise<WatchResult>;

/**
 * The real seam: the command runs through /bin/sh, killed after `timeoutMs`; at most WATCH_OUTPUT_MAX
 * characters of stdout are kept (the rest is discarded as it arrives, never buffered); a spawn failure
 * answers 127, a timeout 124 — both are mismatches, never exceptions.
 */
export function shellWatchRunner(timeoutMs = 10_000): WatchRunner {
	return (command) =>
		new Promise((resolve) => {
			const child = spawn("/bin/sh", ["-c", command], { stdio: ["ignore", "pipe", "ignore"] });
			let stdout = "";
			let settled = false;
			let killer: NodeJS.Timeout | undefined;
			const done = (code: number): void => {
				if (settled) return;
				settled = true;
				if (killer !== undefined) clearTimeout(killer);
				resolve({ code, stdout });
			};
			child.stdout.on("data", (chunk: Buffer) => {
				if (stdout.length >= WATCH_OUTPUT_MAX) return;
				stdout = (stdout + chunk.toString("utf8")).slice(0, WATCH_OUTPUT_MAX);
			});
			child.on("error", () => done(127));
			child.on("close", (code) => done(code ?? 1));
			killer = setTimeout(() => {
				child.kill("SIGKILL");
				done(124);
			}, timeoutMs);
			killer.unref?.();
		});
}

/**
 * The tick's fixed phase: :30 past the minute, whatever time the host started. A fixed phase keeps
 * many short-interval watches off the round minute, where rate limits and scheduled jobs crowd.
 */
export const WATCH_TICK_PHASE_MS = 30_000;

/** Milliseconds from `nowMs` to the next tick on the phase (0 when on it). */
export function watchTickDelayMs(nowMs: number, intervalMs: number): number {
	return (((WATCH_TICK_PHASE_MS - nowMs) % intervalMs) + intervalMs) % intervalMs;
}

export type Watcher = {
	stop(): void;
	/** One due-ness pass; returns the requestIds of the firings it submitted. */
	tick(): Promise<string[]>;
};

export function startWatches(options: {
	host: RoleHost;
	/** config.schedules: nothing runs when false — the watches share the schedules' switch. */
	enabled: boolean;
	clock?: () => number;
	intervalMs?: number;
	context?: Context;
	/** The command runner; tests inject a scripted fake. Default shellWatchRunner(). */
	runner?: WatchRunner;
}): Watcher {
	const clock = options.clock ?? (() => Date.now());
	const intervalMs = options.intervalMs ?? 60_000;
	const runner = options.runner ?? shellWatchRunner();
	const context = options.context ?? BACKGROUND_CONTEXT;
	let stopped = false;
	let ticking = false;
	/** In-memory due-ness only: after a restart every watch is checked once, and the ledger keeps the episodes. */
	const nextDueMs = new Map<string, number>();

	const tick = async (): Promise<string[]> => {
		if (!options.enabled || stopped || ticking) return [];
		ticking = true;
		const fired: string[] = [];
		try {
			for (const role of options.host.roles()) {
				if (role.settings.enabled === false) continue;
				for (const watch of role.settings.watches ?? []) {
					const key = `${role.name}:${watch.name}`;
					const nowMs = clock();
					if ((nextDueMs.get(key) ?? 0) > nowMs) continue;
					nextDueMs.set(key, nowMs + watch.everySeconds * 1000);
					const conversation = await options.host.conversation(role.name);
					if (conversation === undefined) continue;
					let result: WatchResult;
					try {
						result = await runner(watch.command);
					} catch {
						result = { code: 127, stdout: "" };
					}
					const output = result.stdout.trim().slice(0, WATCH_OUTPUT_MAX);
					const matched = result.code === 0 && output === watch.expect;
					const ledger = await options.host.harness.snapshot(WatchLedgerDoc, conversation.id, context);
					if (matched) {
						if (ledger?.open[watch.name] !== undefined) {
							// The episode closes on one clean check; the watch re-arms.
							await options.host.harness.commit(async (tx) => {
								const doc = await tx.doc(WatchLedgerDoc, conversation.id);
								delete doc.open[watch.name];
							}, context);
						}
						continue;
					}
					if (ledger?.open[watch.name] !== undefined) continue; // this episode already fired
					const requestId = watchRequestId(role.name, watch, nowMs);
					const firedContent = watchFiredContent(watch, output);
					await options.host.submit(role.name, {
						// A firing submitted while the role is busy waits behind the running turn: stamp it.
						content: options.host.isBusy(role.name) ? `${queuedWatchPrefix(nowMs)}\n${firedContent}` : firedContent,
						requestId,
						step: `watch:${watch.name}`,
					});
					// Crash point: after the submit (durable; the requestId dedupes) and before the ledger mark.
					await crashPoint("after-submit-before-ledger");
					await options.host.harness.commit(async (tx) => {
						const doc = await tx.doc(WatchLedgerDoc, conversation.id);
						doc.open[watch.name] = requestId;
					}, context);
					fired.push(requestId);
				}
			}
		} finally {
			ticking = false;
		}
		return fired;
	};

	let timer: NodeJS.Timeout | undefined;
	const starter = setTimeout(() => {
		if (stopped) return;
		void tick().catch(() => undefined);
		timer = setInterval(() => void tick().catch(() => undefined), intervalMs);
		timer.unref?.();
	}, watchTickDelayMs(clock(), intervalMs));
	starter.unref?.();
	return {
		stop() {
			stopped = true;
			clearTimeout(starter);
			if (timer !== undefined) clearInterval(timer);
		},
		tick,
	};
}
