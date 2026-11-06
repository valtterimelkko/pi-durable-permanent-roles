/**
 * Crash-gate guard: arming must be impossible outside test mode. The refusal itself is
 * proven in a fresh `node -e` process whose environment carries neither `VITEST` nor
 * `STANDING_ROLES_CRASH_GATES`; there `armCrashGate` must refuse and an unarmed
 * `crashPoint` must be a no-op.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const GATE_MODULE = fileURLToPath(new URL("../src/crash-gate.ts", import.meta.url));

function runOutsideTestMode(script: string): { stdout: string; status: number | null } {
	const result = spawnSync(process.execPath, ["-e", script], {
		encoding: "utf8",
		timeout: 15_000,
		env: { PATH: process.env.PATH ?? "" },
	});
	return { stdout: result.stdout.trim(), status: result.status };
}

it("armCrashGate refuses outside test mode and crashPoint stays a no-op", () => {
	const { stdout, status } = runOutsideTestMode(`
		import("${GATE_MODULE}").then((gate) => {
			let armed = "ARMED";
			try {
				gate.armCrashGate("probe", "/tmp/sr-guard-should-not-exist", "/tmp/sr-guard-should-not-exist");
			} catch {
				armed = "REFUSED";
			}
			const started = Date.now();
			gate.crashPoint("never-armed").then(() => {
				const noop = Date.now() - started < 1000 ? "NOOP-OK" : "NOOP-SLOW";
				process.stdout.write(armed + " " + noop);
			});
		});
	`);
	expect(status).toBe(0);
	expect(stdout).toBe("REFUSED NOOP-OK");
});

it("armCrashGate accepts STANDING_ROLES_CRASH_GATES=1 as test mode (the crash-test children)", () => {
	const result = spawnSync(
		process.execPath,
		["-e", `
			import("${GATE_MODULE}").then((gate) => {
				try {
					gate.armCrashGate("probe", "/tmp/sr-guard-child-armed", "/tmp/sr-guard-child-release");
					process.stdout.write("ARMED-OK");
				} catch {
					process.stdout.write("REFUSED");
				}
			});
		`],
		{ encoding: "utf8", timeout: 15_000, env: { PATH: process.env.PATH ?? "", STANDING_ROLES_CRASH_GATES: "1" } },
	);
	expect(result.status).toBe(0);
	expect(result.stdout.trim()).toBe("ARMED-OK");
});
