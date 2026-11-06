/**
 * The crash test, on the Phone Steward project's pattern: a child process running
 * the host (faux model, temp state dir) is SIGKILLed after a run is submitted and before it
 * finishes (the "after-submit-before-ledger" gate in the schedule tick); on reopen the run
 * continues, is not submitted twice (the stable requestId dedupes), and the conversation
 * ids are the same.
 *
 * The scenario runs twice from fresh state: once with the normal requestId prefix (the
 * assertion: delivered exactly once) and once with a different prefix on reopen (the
 * RED-proof knob: the run IS delivered twice, which is exactly what the dedupe prevents —
 * so the test can fail).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { writeRolesTree } from "./helpers.ts";

const CHILD = fileURLToPath(new URL("./child-process.ts", import.meta.url));
const CLOCK_MS = Date.UTC(2026, 9, 20, 9, 0, 0); // London 2026-10-20 (Tue) 10:00

type ChildRun = {
	child: ChildProcess;
	stdout: string;
	stderr: string;
	done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

function spawnChild(stage: Record<string, unknown>, crashGates: boolean): ChildRun {
	const env: NodeJS.ProcessEnv = { ...process.env };
	if (crashGates) env.STANDING_ROLES_CRASH_GATES = "1";
	else delete env.STANDING_ROLES_CRASH_GATES;
	const child = spawn(process.execPath, ["--experimental-strip-types", CHILD, JSON.stringify(stage)], {
		stdio: ["ignore", "pipe", "pipe"],
		env,
	});
	const run: ChildRun = { child, stdout: "", stderr: "", done: undefined as never };
	run.done = new Promise((resolve, reject) => {
		child.stdout!.on("data", (chunk: Buffer) => (run.stdout += chunk.toString()));
		child.stderr!.on("data", (chunk: Buffer) => (run.stderr += chunk.toString()));
		child.on("error", reject);
		child.on("close", (code, signal) => resolve({ code, signal }));
	});
	return run;
}

function markers(run: ChildRun): Array<Record<string, unknown>> {
	return run.stdout
		.split("\n")
		.filter((line) => line.startsWith("MARKER "))
		.map((line) => JSON.parse(line.slice("MARKER ".length)) as Record<string, unknown>);
}

async function waitForMarker(run: ChildRun, event: string, timeoutMs = 20_000): Promise<Record<string, unknown>> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const found = markers(run).find((marker) => marker.event === event);
		if (found !== undefined) return found;
		if (Date.now() >= deadline) {
			throw new Error(`marker ${event} never arrived; stdout=${JSON.stringify(run.stdout)} stderr=${JSON.stringify(run.stderr)}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function waitForFile(path: string, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(path)) {
		if (Date.now() >= deadline) throw new Error(`marker file ${path} never appeared`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** One full crash-and-recover scenario; returns what the reopened storage held. */
async function scenario(dedupe: boolean): Promise<{ idsMatch: boolean; userEntries: number; assistantEntries: number; resumedSubmitted: string[] }> {
	const stateDir = await mkdtemp(join(tmpdir(), "sr-crash-"));
	const rolesRoot = join(await mkdtemp(join(tmpdir(), "sr-crash-roles-")), "roles");
	await mkdir(rolesRoot, { recursive: true });
	await writeRolesTree(rolesRoot, [{ name: "alpha", schedule: [{ at: "09:00", days: "daily" }] }]);
	const markerFile = join(stateDir, "gate-marker");
	const releaseFile = join(stateDir, "gate-release");
	try {
		// Child A: opens the host, arms the gate, ticks — submits and blocks in the gate.
		const a = spawnChild(
			{ stage: "crash-submit", db: join(stateDir, "roles.db"), stateDir, rolesRoot, markerFile, releaseFile, clockMs: CLOCK_MS },
			true,
		);
		const openedA = await waitForMarker(a, "opened");
		// The gate's marker proves the tick is past the durable submit, stuck before the mark.
		await waitForFile(markerFile);
		a.child.kill("SIGKILL");
		const killed = await a.done;
		expect(killed.signal).toBe("SIGKILL");

		// Child B: a fresh process opens the same SQLite file and resumes.
		const b = spawnChild(
			{ stage: "resume-verify", db: join(stateDir, "roles.db"), stateDir, rolesRoot, clockMs: CLOCK_MS, dedupe },
			false,
		);
		const openedB = await waitForMarker(b, "opened");
		const idsMatch = JSON.stringify(openedB.conversations) === JSON.stringify(openedA.conversations);
		const submittedB = await waitForMarker(b, "submitted");
		const result = await waitForMarker(b, "result");
		const { code } = await b.done;
		expect(code, `child exited ${code}; stderr=${JSON.stringify(b.stderr)}`).toBe(0);
		return {
			idsMatch,
			userEntries: result.userEntries as number,
			assistantEntries: result.assistantEntries as number,
			resumedSubmitted: submittedB.submitted as string[],
		};
	} finally {
		await rm(stateDir, { recursive: true, force: true });
		await rm(rolesRoot, { recursive: true, force: true });
	}
}

it("SIGKILL after the run is submitted and before it finishes; reopen continues exactly once, same conversation ids", async () => {
	const good = await scenario(true);
	expect(good.idsMatch).toBe(true);
	// The slot was never marked, so the reopened tick does try to run it again...
	expect(good.resumedSubmitted).toEqual(["alpha:2026-10-20T09:00"]);
	// ...but the stable requestId delivers it exactly once.
	expect(good.userEntries).toBe(1);
	expect(good.assistantEntries).toBe(1);
}, 60_000);

it("the RED-proof knob: with a different requestId on reopen the run is delivered twice", async () => {
	const bad = await scenario(false);
	expect(bad.userEntries).toBe(2);
	expect(bad.assistantEntries).toBe(2);
}, 60_000);
