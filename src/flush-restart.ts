/**
 * flush-restart — the one restart tool the roles use.
 *
 * A flush restart lets running work finish: it restarts a service as soon as it is idle — at any hour. Idleness is
 * checked per service, failing closed; when it cannot be proved the tool prints why and exits 3 ("not now"), and the
 * caller tries again when the service has gone idle. Every decision appends exactly one line to the log the CLI
 * wires up.
 *
 * The role host itself — its own unit name (STANDING_ROLES_SERVICE_NAME, default `pi-roles`) — is refused outright:
 * a role never restarts its own host; the refusal tells it to notify_owner, and another agent runs the restart when
 * no role is busy.
 *
 * Per service (name upper-cased, dashes to underscores for the variable suffix):
 * - `FLUSH_RESTART_IDLE_COMMAND_<NAME>` — the idleness probe; exit 0 means idle, anything else is busy (stdout is
 *   the detail). No probe configured: "not now", never a blind restart.
 * - `FLUSH_RESTART_RESTART_COMMAND_<NAME>` — the restart command (split on whitespace); default
 *   `systemctl restart <service>`.
 *
 * This module is the pure, tested part: the decision and the argument handling. Every system call (the clock, the
 * environment, the idleness probe, the restart command, the log, stdout) sits behind `Seams` — tests inject fakes
 * and never touch systemctl or a probe. `src/flush-restart-cli.ts` holds the real seams.
 */

/** The result of an idle check: a service is restartable only when `idle` is true; the detail explains. */
export interface IdleCheck {
	idle: boolean;
	detail: string;
}

export interface Seams {
	now(): Date;
	env(name: string): string | undefined;
	idle(service: string): Promise<IdleCheck>;
	exec(command: string, args: readonly string[]): Promise<{ code: number; output?: string }>;
	appendLog(line: string): void;
	print(text: string): void;
}

export type Decision = {
	service: string;
	action: "restarted" | "not-now" | "refused" | "failed";
	reason: string;
	/** The restart command as one string, or null when nothing was (or could be) run. */
	command: string | null;
	exitCode: number;
	/** A post-restart notice the caller should pass on (printed, never swallowed). */
	wakeNotice?: string;
};

/** `bin/flush-restart <service>` — the service is the first other argument. */
export function parseArgs(argv: readonly string[]): { service?: string } {
	for (const arg of argv) {
		return { service: arg };
	}
	return { service: undefined };
}

const tail = (text: string | undefined, max = 200): string => {
	const flat = (text ?? "").replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/** One flat log line per decision; quotes are narrowed so the line stays one line. */
export function logLine(now: Date, d: Decision): string {
	const reason = d.reason.replace(/"/g, "'").replace(/\s+/g, " ").trim();
	return `${now.toISOString()} service=${d.service} decision=${d.action} exit=${d.exitCode} command="${d.command ?? "-"}" reason="${reason}"`;
}

/** The env-var suffix for a service name: upper-cased, dashes to underscores. */
export function serviceEnvSuffix(service: string): string {
	return service.toUpperCase().replaceAll("-", "_");
}

/** The restart command for a service: the configured words, else `systemctl restart <service>`. */
export function restartCommandFor(service: string, env: (name: string) => string | undefined): { command: string; args: readonly string[] } {
	const configured = env(`FLUSH_RESTART_RESTART_COMMAND_${serviceEnvSuffix(service)}`);
	if (configured !== undefined && configured.trim() !== "") {
		const words = configured.trim().split(/\s+/);
		return { command: words[0]!, args: words.slice(1) };
	}
	return { command: "systemctl", args: ["restart", service] };
}

/** Why the role host itself is never restarted by a role, and what to do instead. */
export function ownHostNotice(ownHost: string): string {
	return `refused: ${ownHost} is the role host itself; a role never restarts its own host. notify_owner instead — "the role host needs a restart after <what>"; another agent should run "systemctl restart ${ownHost}" when no role is busy`;
}

/**
 * Run the tool for one service argument: validate, check idleness, restart, log, print.
 * Returns the decision; the caller turns `exitCode` into the process exit code.
 */
export async function runFlushRestart(
	serviceArg: string | undefined,
	seams: Seams,
	options: { services?: readonly string[]; ownHost?: string } = {},
): Promise<Decision> {
	const services = options.services ?? [];
	const ownHost = options.ownHost ?? "pi-roles";
	const service = (serviceArg ?? "").trim();
	let decision: Decision;
	if (service === ownHost) {
		decision = { service, action: "refused", reason: ownHostNotice(ownHost), command: null, exitCode: 2 };
	} else if (!services.includes(service)) {
		decision = {
			service: serviceArg ?? "(none)",
			action: "refused",
			reason: `unknown service "${serviceArg ?? ""}"; expected one of: ${services.length === 0 ? "(none configured — see STANDING_ROLES_GUARDED_SERVICES and docs/ADOPTING.md)" : services.join(", ")}`,
			command: null,
			exitCode: 2,
		};
	} else {
		decision = await decideAndRestart(service, seams);
	}
	seams.appendLog(logLine(seams.now(), decision));
	seams.print(
		decision.action === "restarted"
			? `${decision.service}: restarted (${decision.command})`
			: `${decision.service}: not now (${decision.action}, exit ${decision.exitCode}) — ${decision.reason}`,
	);
	if (decision.action === "restarted" && decision.wakeNotice) seams.print(decision.wakeNotice);
	return decision;
}

async function decideAndRestart(service: string, seams: Seams): Promise<Decision> {
	let idle: IdleCheck;
	try {
		idle = await seams.idle(service);
	} catch (error) {
		return {
			service,
			action: "not-now",
			reason: `idle check failed (${error instanceof Error ? error.message : String(error)}); a restart needs proof of idle`,
			command: null,
			exitCode: 3,
		};
	}
	if (!idle.idle) {
		return { service, action: "not-now", reason: `busy: ${idle.detail}`, command: null, exitCode: 3 };
	}
	const { command, args } = restartCommandFor(service, (name) => seams.env(name));
	let result: { code: number; output?: string };
	try {
		result = await seams.exec(command, args);
	} catch (error) {
		return {
			service,
			action: "failed",
			reason: `${command} could not run: ${error instanceof Error ? error.message : String(error)}`,
			command: [command, ...args].join(" "),
			exitCode: 1,
		};
	}
	if (result.code !== 0) {
		return {
			service,
			action: "failed",
			reason: `${command} exited ${result.code}: ${tail(result.output)}`,
			command: [command, ...args].join(" "),
			exitCode: 1,
		};
	}
	return {
		service,
		action: "restarted",
		reason: "service idle",
		command: [command, ...args].join(" "),
		exitCode: 0,
	};
}
