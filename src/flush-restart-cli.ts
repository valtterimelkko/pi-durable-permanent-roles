/**
 * flush-restart CLI — the real seams for src/flush-restart.ts.
 *
 * The service list comes from STANDING_ROLES_GUARDED_SERVICES (comma-separated), and the role host's own unit
 * from STANDING_ROLES_SERVICE_NAME (default pi-roles), which is refused before any check: a role never restarts
 * its own host. Idleness is proved per service with FLUSH_RESTART_IDLE_COMMAND_<NAME> (exit 0 = idle, anything
 * else is busy; stdout is the detail), failing closed — a service with no probe answers "not now".
 *
 * Every decision appends one line to $STANDING_ROLES_STATE_DIR/flush-restart.log
 * (default /var/lib/pi-roles/flush-restart.log). Exit codes: 0 restarted, 2 refused (unknown service,
 * or the role host itself), 3 not now, 1 the restart command failed.
 *
 * Usage: bin/flush-restart <service>
 */
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "./config.ts";
import {
	type Decision,
	type IdleCheck,
	type Seams,
	parseArgs,
	runFlushRestart,
} from "./flush-restart.ts";

const execFileP = promisify(execFile);

const stateDir = process.env.STANDING_ROLES_STATE_DIR ?? "/var/lib/pi-roles";
const config = loadConfig(process.env);

function envOf(name: string): string | undefined {
	return process.env[name];
}

/** The real idleness probe: run the configured command; exit 0 is idle, anything else is busy. */
async function probeIdle(service: string): Promise<IdleCheck> {
	const probe = envOf(`FLUSH_RESTART_IDLE_COMMAND_${serviceEnvSuffixUpper(service)}`);
	if (probe === undefined || probe.trim() === "") {
		return { idle: false, detail: `no idle check configured (set FLUSH_RESTART_IDLE_COMMAND_${serviceEnvSuffixUpper(service)})` };
	}
	const words = probe.trim().split(/\s+/);
	try {
		const result = await execFileP(words[0]!, words.slice(1), { timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
		return { idle: true, detail: result.stdout.trim() || "the idle check passed" };
	} catch (error) {
		const err = error as { code?: unknown; stdout?: string; stderr?: string; message?: string };
		const detail = String(err.stdout ?? err.stderr ?? err.message ?? "").trim();
		return { idle: false, detail: detail === "" ? "the idle check did not pass" : detail.slice(0, 200) };
	}
}

function serviceEnvSuffixUpper(service: string): string {
	return service.toUpperCase().replaceAll("-", "_");
}

const seams: Seams = {
	now: () => new Date(),
	env: envOf,
	idle: probeIdle,
	exec: async (command, args) => {
		try {
			const result = await execFileP(command, [...args], { timeout: 120_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
			return { code: 0, output: result.stdout };
		} catch (error) {
			const err = error as { code?: unknown; stdout?: string; stderr?: string };
			const code = typeof err.code === "number" ? err.code : 1;
			return { code, output: String(err.stderr ?? err.stdout ?? "") };
		}
	},
	appendLog: (line) => {
		try {
			mkdirSync(stateDir, { recursive: true });
			appendFileSync(join(stateDir, "flush-restart.log"), `${line}\n`, "utf8");
		} catch {
			// a log write must never change the decision
		}
	},
	print: (text) => process.stdout.write(`${text}\n`),
};

const args = parseArgs(process.argv.slice(2));
const decision: Decision = await runFlushRestart(args.service, seams, {
	services: config.guardedServices,
	ownHost: config.serviceName,
});
process.exit(decision.exitCode);
