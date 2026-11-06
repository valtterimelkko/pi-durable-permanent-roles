/**
 * Environment → host configuration. Every flag is an on/off switch so a systemd unit (or any launcher) decides what
 * runs; the defaults are quiet: schedules off until the adopter switches them on, integrations off, notifications to
 * a local JSONL file.
 */

export interface HostConfig {
	/** Durable state: roles.db, admin.sock, roles/<name>/{notes,transcript.jsonl,status.json}. */
	stateDir: string;
	/** The roles/ folder root (the repository's roles/ in production). */
	rolesRoot: string;
	/** STANDING_ROLES_SCHEDULES: the 60 s schedule tick (default off). */
	schedules: boolean;
	/** STANDING_ROLES_REPORT_NUDGE: remind a run that ended without report_run, then card it (default on). */
	reportNudge?: boolean;
	/**
	 * STANDING_ROLES_INTEGRATIONS: the real integration CLI (default off — the stub answers locally).
	 * When on, STANDING_ROLES_INTEGRATIONS_COMMAND must name the program (docs/ADOPTING.md).
	 */
	integrations: boolean;
	/** STANDING_ROLES_INTEGRATIONS_COMMAND: the integration CLI program, run with the built argv, no shell. */
	integrationsCommand?: string;
	/**
	 * STANDING_ROLES_NOTIFY_COMMAND: the owner-notification program, run as `<command> <title> <body>`.
	 * Default unset: notifications append to `<stateDir>/notifications.jsonl`.
	 */
	notifyCommand?: string;
	/** STANDING_ROLES_TIMEZONE: the zone schedules, digests and dedupe keys read (default "UTC"). */
	timezone: string;
	/** STANDING_ROLES_GUARDED_SERVICES: comma-separated systemd units a role may never stop or restart directly. */
	guardedServices: string[];
	/** STANDING_ROLES_SERVICE_NAME: the role host's own unit, which no role may restart (default "pi-roles"). */
	serviceName: string;
	/**
	 * STANDING_ROLES_GUIDE_CHECK: the repo-guide checker the docs_commit tool runs when a role edits
	 * AGENTS.md/CLAUDE.md (default unset: the step is skipped).
	 */
	guideCheck?: string;
	/** Pi's agent dir, read for the model registry and credentials (default ~/.pi/agent). */
	piAgentDir: string;
}

function flag(value: string | undefined, fallback: boolean): boolean {
	if (value === "on") return true;
	if (value === "off") return false;
	return fallback;
}

/** The repository's own roles/ folder, resolved from this module's location. */
function defaultRolesRoot(): string {
	return new URL("../roles/", import.meta.url).pathname.replace(/\/$/, "");
}

function defaultAgentDir(env: NodeJS.ProcessEnv): string {
	return `${env.HOME ?? "/root"}/.pi/agent`;
}

function commaList(value: string | undefined): string[] {
	if (value === undefined) return [];
	return value
		.split(",")
		.map((name) => name.trim().replace(/\.service$/, ""))
		.filter((name) => name !== "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HostConfig {
	return {
		stateDir: env.STANDING_ROLES_STATE_DIR ?? "/var/lib/pi-roles",
		rolesRoot: env.STANDING_ROLES_ROOT ?? defaultRolesRoot(),
		schedules: flag(env.STANDING_ROLES_SCHEDULES, false),
		reportNudge: flag(env.STANDING_ROLES_REPORT_NUDGE, true),
		integrations: flag(env.STANDING_ROLES_INTEGRATIONS, false),
		integrationsCommand: env.STANDING_ROLES_INTEGRATIONS_COMMAND,
		notifyCommand: env.STANDING_ROLES_NOTIFY_COMMAND,
		timezone: env.STANDING_ROLES_TIMEZONE ?? "UTC",
		guardedServices: commaList(env.STANDING_ROLES_GUARDED_SERVICES),
		serviceName: env.STANDING_ROLES_SERVICE_NAME ?? "pi-roles",
		guideCheck: env.STANDING_ROLES_GUIDE_CHECK,
		piAgentDir: env.STANDING_ROLES_PI_DIR ?? defaultAgentDir(env),
	};
}
