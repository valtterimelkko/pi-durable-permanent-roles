/**
 * Deterministic crash points for durability tests — adapted from the Phone Steward project, a sibling repository.
 *
 * A test arms a gate for a named step with a marker file and a release file. When the
 * product code reaches `crashPoint(step)` the marker file is written and the call blocks
 * until the release file appears — which the crash test never creates, so the child
 * process stays exactly at that point until the test parent SIGKILLs it.
 *
 * Gates are armed per process; production code never arms one, so `crashPoint` is a no-op
 * outside tests.
 */
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";

type CrashGate = {
	readonly markerFile: string;
	readonly releaseFile: string;
};

const gates = new Map<string, CrashGate>();

/**
 * Arming is test-only: vitest workers get `VITEST`, and the crash-test child processes are
 * launched by the test harness with `STANDING_ROLES_CRASH_GATES=1`. Production code has
 * neither, so it cannot arm a gate.
 */
function inTestMode(): boolean {
	return process.env.VITEST !== undefined || process.env.STANDING_ROLES_CRASH_GATES === "1";
}

/** Arm (or re-arm) the gate for `step`. Throws outside test mode. */
export function armCrashGate(step: string, markerFile: string, releaseFile: string): void {
	if (!inTestMode()) {
		throw new Error("crash gates can only be armed in test mode (VITEST or STANDING_ROLES_CRASH_GATES=1)");
	}
	gates.set(step, { markerFile, releaseFile });
}

/**
 * Reachable from product code at points a crash test wants to catch. Without an armed gate
 * this returns immediately.
 */
export async function crashPoint(step: string): Promise<void> {
	const gate = gates.get(step);
	if (gate === undefined) return;
	await writeFile(gate.markerFile, new Date().toISOString(), "utf8");
	// The release file never arrives in a crash test; the deadline only frees a child whose
	// test parent already died, so the suite cannot leak a hung process.
	const deadline = Date.now() + 60_000;
	while (!existsSync(gate.releaseFile) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
