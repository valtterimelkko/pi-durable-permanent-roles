/**
 * flush-restart, pure: the decision over injected seams. The service list and the own-host unit are
 * options; the idle probe is the configured command, failing closed; every decision logs exactly one line.
 */
import { describe, expect, it } from "vitest";
import {
	type IdleCheck,
	logLine,
	parseArgs,
	restartCommandFor,
	runFlushRestart,
	serviceEnvSuffix,
	type Seams,
} from "../src/flush-restart.ts";

function seams(options: {
	idle?: IdleCheck;
	idleThrows?: Error;
	execResult?: { code: number; output?: string };
	now?: Date;
} = {}): { seams: Seams; execs: Array<{ command: string; args: readonly string[] }>; logs: string[]; printed: string[] } {
	const execs: Array<{ command: string; args: readonly string[] }> = [];
	const logs: string[] = [];
	const printed: string[] = [];
	return {
		execs,
		logs,
		printed,
		seams: {
			now: () => options.now ?? new Date("2026-11-06T09:00:00.000Z"),
			env: (name) => (name === "FLUSH_RESTART_RESTART_COMMAND_MY_APP" ? "sudo systemctl restart my-app --now" : undefined),
			idle: async () => {
				if (options.idleThrows !== undefined) throw options.idleThrows;
				return options.idle ?? { idle: true, detail: "0 active turns" };
			},
			exec: async (command, args) => {
				execs.push({ command, args });
				return options.execResult ?? { code: 0 };
			},
			appendLog: (line) => logs.push(line),
			print: (text) => printed.push(text),
		},
	};
}

const SERVICES = ["my-app", "other-app"];

describe("argument handling", () => {
	it("takes the service from the first argument and ignores a removed --self flag", () => {
		expect(parseArgs(["my-app"])).toEqual({ service: "my-app" });
		expect(parseArgs([])).toEqual({ service: undefined });
	});

	it("maps a service name to its env suffix", () => {
		expect(serviceEnvSuffix("my-app")).toBe("MY_APP");
	});
});

describe("the decision", () => {
	it("refuses the role host itself before any check, with the notify_owner answer", async () => {
		const rig = seams();
		const decision = await runFlushRestart("pi-roles", rig.seams, { services: SERVICES, ownHost: "pi-roles" });
		expect(decision).toMatchObject({ service: "pi-roles", action: "refused", exitCode: 2 });
		expect(decision.reason).toContain("a role never restarts its own host");
		expect(decision.reason).toContain("systemctl restart pi-roles");
		expect(rig.execs).toHaveLength(0);
	});

	it("refuses an unknown service with the configured list", async () => {
		const rig = seams();
		const decision = await runFlushRestart("nope", rig.seams, { services: SERVICES, ownHost: "pi-roles" });
		expect(decision).toMatchObject({ action: "refused", exitCode: 2 });
		expect(decision.reason).toContain("my-app, other-app");
	});

	it("refuses when no services are configured at all", async () => {
		const rig = seams();
		const decision = await runFlushRestart("my-app", rig.seams, { ownHost: "pi-roles" });
		expect(decision).toMatchObject({ action: "refused", exitCode: 2 });
		expect(decision.reason).toContain("none configured");
	});

	it("restarts through the configured command when the probe says idle", async () => {
		const rig = seams();
		const decision = await runFlushRestart("my-app", rig.seams, { services: SERVICES, ownHost: "pi-roles" });
		expect(decision).toMatchObject({ service: "my-app", action: "restarted", exitCode: 0 });
		expect(rig.execs[0]).toEqual({ command: "sudo", args: ["systemctl", "restart", "my-app", "--now"] });
	});

	it("falls back to systemctl restart <service> without a configured restart command", async () => {
		const rig = seams();
		const decision = await runFlushRestart("other-app", rig.seams, { services: SERVICES, ownHost: "pi-roles" });
		expect(decision.action).toBe("restarted");
		expect(rig.execs[0]).toEqual({ command: "systemctl", args: ["restart", "other-app"] });
	});

	it("answers not-now (exit 3) when the probe says busy, and never executes", async () => {
		const rig = seams({ idle: { idle: false, detail: "2 active turns" } });
		const decision = await runFlushRestart("my-app", rig.seams, { services: SERVICES, ownHost: "pi-roles" });
		expect(decision).toMatchObject({ action: "not-now", exitCode: 3 });
		expect(decision.reason).toContain("2 active turns");
		expect(rig.execs).toHaveLength(0);
	});

	it("fails closed when the probe throws — a restart needs proof of idle", async () => {
		const rig = seams({ idleThrows: new Error("probe went away") });
		const decision = await runFlushRestart("my-app", rig.seams, { services: SERVICES, ownHost: "pi-roles" });
		expect(decision).toMatchObject({ action: "not-now", exitCode: 3 });
		expect(decision.reason).toContain("probe went away");
		expect(rig.execs).toHaveLength(0);
	});

	it("reports a failed restart command (exit 1) with its output", async () => {
		const rig = seams({ execResult: { code: 1, output: "job failed" } });
		const decision = await runFlushRestart("my-app", rig.seams, { services: SERVICES, ownHost: "pi-roles" });
		expect(decision).toMatchObject({ action: "failed", exitCode: 1 });
		expect(decision.reason).toContain("job failed");
	});
});

describe("logging and printing", () => {
	it("every decision appends exactly one flat log line and one print, whatever happened", async () => {
		const rig = seams();
		await runFlushRestart("my-app", rig.seams, { services: SERVICES, ownHost: "pi-roles" });
		const busy = seams({ idle: { idle: false, detail: "busy" } });
		await runFlushRestart("my-app", busy.seams, { services: SERVICES, ownHost: "pi-roles" });
		const refused = seams();
		await runFlushRestart("pi-roles", refused.seams, { services: SERVICES, ownHost: "pi-roles" });
		expect(rig.logs).toHaveLength(1);
		expect(rig.logs[0]).toContain("decision=restarted");
		expect(rig.logs[0]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(busy.logs).toHaveLength(1);
		expect(busy.logs[0]).toContain("decision=not-now");
		expect(refused.logs).toHaveLength(1);
		expect(refused.logs[0]).toContain("decision=refused");
		expect(rig.printed[0]).toContain("my-app: restarted");
	});

	it("logLine narrows quotes and newlines so the line stays one line", () => {
		const line = logLine(new Date("2026-11-06T09:00:00.000Z"), {
			service: "s",
			action: "failed",
			reason: 'said "stop"\nthen continued',
			command: null,
			exitCode: 1,
		});
		expect(line).toContain('reason="said \'stop\' then continued"');
		expect(line.split("\n")).toHaveLength(1);
	});
});
