/**
 * Shared interfaces for the standing roles host (see docs/ARCHITECTURE.md for the component map).
 */
import type { Extension, Harness } from "@earendil-works/pi-durable";
import type { Integrations } from "./integrations/types.ts";

/** One schedule slot, in the host's configured time zone (STANDING_ROLES_TIMEZONE, default UTC). */
export interface ScheduleSlot {
	/** "HH:MM", 24-hour. */
	at: string;
	days: "daily" | "weekdays";
}

/** The hard limits this host enforces in code for a role that carries them. */
export const ROLE_LIMITS = ["docs-only-commits", "read-only-messaging"] as const;
export type RoleLimit = (typeof ROLE_LIMITS)[number];

export interface ModelChoice {
	provider: string;
	modelId: string;
}

/** `roles/<name>/settings.json`. Unknown keys are kept and ignored. */
export interface RoleSettings {
	/** One-line switch: false = no schedule, no board card, no inbox claims. */
	enabled: boolean;
	/** Human title, also the board task, e.g. "Runtime keeper". */
	title: string;
	/** Board entry name and inbox address, e.g. "role-runtime-keeper". Unique. */
	boardName: string;
	/** Overrides roles/defaults.json when present. */
	model?: ModelChoice;
	thinking?: "low" | "medium" | "high" | "max";
	schedule: ScheduleSlot[];
	/** Text submitted at each scheduled run after "Scheduled run <slot>.". */
	runPrompt?: string;
	/** Working directory for the coding tools. */
	cwd: string;
	/** Tool groups selected for this role's conversation. */
	tools: Array<"coding" | "integrations" | "notify">;
	/**
	 * Hard limits carried in code: "docs-only-commits" gives the role the docs_commit tool and
	 * refuses the git write commands in its bash (src/docs-commit.ts); "read-only-messaging" refuses
	 * the write commands of the role's configured message CLIs (src/messaging-limit.ts, rules in the
	 * role folder's never-run.json).
	 */
	limits?: RoleLimit[];
	/**
	 * A read-only-messaging role's never-run table, as a file path relative to its folder
	 * (JSON: [{"cli","surface","verbs","flags"}], src/messaging-limit.ts). Required with the
	 * read-only-messaging limit; validated at load.
	 */
	readOnlyRules?: string;
	/** Host-side watch triggers (src/watches.ts): one firing input per mismatch episode. */
	watches?: RoleWatch[];
	/** The role's named report counts, filled into {counts}. */
	reportCounts?: string[];
	/**
	 * Count names (from reportCounts) that must be above zero on every scheduled run. The host reminds a scheduled
	 * run that reports one as 0 or leaves it out once, then raises a card (everyRunNudgeText); the morning digest
	 * flags a slot whose newest report still misses it. Chat, inbox, watch and reference-change runs are not checked.
	 */
	everyRunCounts?: string[];
	/**
	 * Absolute paths of files OUTSIDE the role folder the role works from, e.g. a runbook the role reads
	 * from another folder. The host hashes them with the role's folder and submits one input when one
	 * changes, so a changed reference reaches the role instead of going stale.
	 */
	referenceFiles?: string[];
}

/** One watch in a role's `watches` list: a host-side trigger, nothing more. */
export interface RoleWatch {
	/** Short name, e.g. "tmp-mode"; part of the firing requestId. */
	name: string;
	/** The shell command whose stdout is compared to expect. */
	command: string;
	/** The exact trimmed stdout that means "fine"; anything else (or a non-zero exit) fires. */
	expect: string;
	/** Seconds between checks; at least 30. */
	everySeconds: number;
}

/** `roles/defaults.json`. */
export interface RoleDefaults {
	model: ModelChoice;
	thinking: "low" | "medium" | "high" | "max";
}

/** A loaded role: folder + settings + composed prompt. */
export interface RoleDefinition {
	/** Folder name under roles/, e.g. "runtime-keeper". */
	name: string;
	/** Absolute path of roles/<name>/. */
	dir: string;
	settings: RoleSettings;
	/** The effective model (settings.model ?? defaults.model). */
	model: ModelChoice;
	thinking: RoleDefaults["thinking"];
	/** PREAMBLE.md + instructions.md with {role}, {title}, {notes} filled. */
	instructions: string;
	/** Absolute path of <state>/roles/<name>/notes/. */
	notesDir: string;
}

/** Runs one external command without a shell. Tests inject a fake; the real one is in src/integrations/cli.ts. */
export type ExternalCli = import("./integrations/types.ts").ExternalCli;
export type ExternalCliRunner = ExternalCli;

/** Sends the owner one message. Tests inject a recording sender; production uses the configured command or the JSONL file. */
export type OwnerNotifier = (title: string, body: string) => Promise<void>;

/** What the core host offers the plumbing. Implemented by host-core in main.ts. */
export interface HostApi {
	/** The open, resumed harness (for the plumbing's durable tasks: outbox, notify). */
	harness: Harness;
	/** Enabled roles only. */
	roles(): readonly RoleDefinition[];
	/** The role whose conversation this is, or undefined. Tools use it to know who calls them. */
	roleForConversation(conversationId: string): RoleDefinition | undefined;
	/** The slot of the role's current run (the last submit), or undefined before its first run. report_run tags its record with it. */
	currentSlot(roleName: string): string | undefined;
	/**
	 * Submit an input into a role's conversation (whenBusy followUp). The same requestId is delivered at most once,
	 * also across a crash and resume.
	 */
	submit(roleName: string, input: { content: string; requestId: string }): Promise<void>;
}

/** What the plumbing offers the core host. Implemented by host-plumb in src/plumbing.ts (createPlumbing). */
export interface Plumbing {
	/**
	 * Extensions to install in the harness registry, keyed by tool group. Install all; a role's conversation selects the
	 * groups in its settings.tools. "coding" is the core's (Pi Durable CodingTools + the hard-limit wrap), not here.
	 */
	extensions(): { integrations: Extension; notify: Extension; tasks: Extension[] };
	/** Start the carrier loops and the presence heartbeat. Called once after the harness is open and resumed. */
	start(host: HostApi): Promise<void>;
	/** Stop loops; bounded, never throws. */
	stop(): Promise<void>;
	/** Presence status changes; queued through the outbox, never on the critical path. */
	runStarted(role: RoleDefinition, step: string): void;
	runEnded(role: RoleDefinition): void;
}

export interface PlumbingOptions {
	/** The configured integrations (the CLI adapter, or the stub). */
	integrations: Integrations;
	/** The integration CLI in CLI mode; undefined in stub mode (nothing queues, the loops do not start). */
	integrationsCli?: ExternalCli;
	/** Where one owner notification goes. */
	notify: OwnerNotifier;
	/** Carrier poll interval; default 5000. */
	carrierIntervalMs?: number;
	/** Board heartbeat interval; default 600000. */
	heartbeatIntervalMs?: number;
}
