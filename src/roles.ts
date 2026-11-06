/**
 * The roles/ folder: defaults.json, PREAMBLE.md and one folder per role.
 * Loading is total: a bad role folder is reported and skipped, never crashes the host.
 * The intelligence lives in each role's instructions.md; this module only validates the
 * shape and composes the prompt (preamble + instructions, {role}, {title}, {notes} filled, and a generated
 * "Your files" section listing the role folder's files and the notes folder).
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RoleDefaults, RoleDefinition, RoleSettings } from "./types.ts";
import { ROLE_LIMITS } from "./types.ts";

export type LoadedRoles = {
	/** The defaults.json in force (the fallback when the file is missing or malformed). */
	defaults: RoleDefaults;
	enabled: RoleDefinition[];
	disabled: RoleDefinition[];
	/** Human-readable problems, one per skipped folder or missing shared file. */
	problems: string[];
};

/** roles/defaults.json when the file is missing or unreadable. Set your own model there; this fallback only keeps the host booting. */
export const FALLBACK_DEFAULTS: RoleDefaults = {
	model: { provider: "faux", modelId: "unset" },
	thinking: "high",
};

const THINKING_LEVELS = new Set(["low", "medium", "high", "max"]);
const TOOL_GROUPS = new Set(["coding", "integrations", "notify"]);
// The limits this host enforces in code: the names in src/types.ts (src/messaging-limit.ts serves
// the read-only one from the role folder's rules file).
const KNOWN_LIMITS: readonly string[] = [...ROLE_LIMITS];
const DAYS = new Set(["daily", "weekdays"]);
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse and validate `settings.json`; the problems are collected, not thrown. */
export function parseSettings(roleName: string, raw: unknown, problems: string[]): RoleSettings | undefined {
	if (!isRecord(raw)) {
		problems.push(`role ${roleName}: settings.json is not a JSON object; skipped`);
		return undefined;
	}
	const s = raw as Record<string, unknown>;
	const fail = (message: string): undefined => {
		problems.push(`role ${roleName}: ${message}; skipped`);
		return undefined;
	};
	if (typeof s.enabled !== "boolean") return fail("enabled must be true or false");
	if (typeof s.title !== "string" || s.title.trim() === "") return fail("title must be a non-empty string");
	if (typeof s.boardName !== "string" || s.boardName.trim() === "") return fail("boardName must be a non-empty string");
	if (typeof s.cwd !== "string" || s.cwd.trim() === "") return fail("cwd must be a non-empty string");
	if (!Array.isArray(s.schedule)) return fail("schedule must be an array");
	for (const slot of s.schedule) {
		if (!isRecord(slot)) return fail("every schedule slot must be an object");
		if (typeof slot.at !== "string" || !TIME_RE.test(slot.at)) return fail(`schedule slot at must be "HH:MM" 24-hour, got ${JSON.stringify(slot.at)}`);
		if (slot.days !== "daily" && slot.days !== "weekdays") return fail(`schedule slot days must be "daily" or "weekdays", got ${JSON.stringify(slot.days)}`);
	}
	if (!Array.isArray(s.tools) || s.tools.some((tool) => !TOOL_GROUPS.has(tool as string))) {
		return fail(`tools must be a list drawn from coding, integrations, notify`);
	}
	if (s.limits !== undefined) {
		const unknown = !Array.isArray(s.limits) || s.limits.some((limit) => !KNOWN_LIMITS.includes(limit as string));
		if (unknown) return fail(`limits must be a list drawn from ${KNOWN_LIMITS.join(", ")}`);
	}
	if (s.thinking !== undefined && !THINKING_LEVELS.has(s.thinking as string)) {
		return fail(`thinking must be one of low, medium, high, max, got ${JSON.stringify(s.thinking)}`);
	}
	if (s.model !== undefined) {
		const model = s.model as Record<string, unknown>;
		if (!isRecord(model) || typeof model.provider !== "string" || typeof model.modelId !== "string") {
			return fail("model must be {provider, modelId}");
		}
	}
	if (s.runPrompt !== undefined && typeof s.runPrompt !== "string") return fail("runPrompt must be a string");
	if (s.readOnlyRules !== undefined && typeof s.readOnlyRules !== "string") return fail("readOnlyRules must be a file path relative to the role folder");
	if (s.watches !== undefined) {
		if (!Array.isArray(s.watches)) return fail("watches must be a list of {name, command, expect, everySeconds}");
		for (const watch of s.watches) {
			if (!isRecord(watch)) return fail("every watch must be an object");
			const w = watch as Record<string, unknown>;
			if (typeof w.name !== "string" || w.name.trim() === "") return fail("every watch needs a non-empty name");
			if (typeof w.command !== "string" || w.command.trim() === "") return fail("every watch needs a non-empty command");
			if (typeof w.expect !== "string") return fail("every watch needs an expect string");
			if (typeof w.everySeconds !== "number" || !Number.isInteger(w.everySeconds) || w.everySeconds < 30) {
				return fail("every watch needs everySeconds of at least 30");
			}
		}
	}
	if (s.reportCounts !== undefined) {
		const names = s.reportCounts;
		const ok = Array.isArray(names) && names.length <= 12 && names.every((n) => typeof n === "string" && COUNT_NAME_RE.test(n));
		if (!ok) return fail("reportCounts must be a list of at most 12 snake_case names, e.g. [\"judged\", \"alerted\"]");
	}
	if (s.everyRunCounts !== undefined) {
		const names = s.everyRunCounts;
		const declared = Array.isArray(s.reportCounts) ? (s.reportCounts as unknown[]) : [];
		const ok = Array.isArray(names) && names.every((n) => typeof n === "string" && declared.includes(n));
		if (!ok) return fail("everyRunCounts must be a list of names that reportCounts also declares");
	}
	if (s.referenceFiles !== undefined) {
		const ok =
			Array.isArray(s.referenceFiles) &&
			s.referenceFiles.every((path) => typeof path === "string" && path.startsWith("/"));
		if (!ok) return fail("referenceFiles must be a list of absolute paths, e.g. [\"/srv/example/RUNBOOK.md\"]");
	}
	const limits = Array.isArray(s.limits) ? (s.limits as unknown[]).map(String) : [];
	if (limits.includes("read-only-messaging") && typeof s.readOnlyRules !== "string") {
		return fail('read-only-messaging needs "readOnlyRules": a rules file relative to the role folder (see roles/work-messages)');
	}
	return s as unknown as RoleSettings;
}

const COUNT_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** The {counts} text: the role's named counts, or the fallback when its settings name none. */
export function countsText(names: readonly string[] | undefined): string {
	if (names === undefined || names.length === 0) return "names of your own choosing, the same every run";
	return names.map((name) => `\`${name}\``).join(", ");
}

/** Fill {role}, {title}, {roleDir}, {notes} and {counts} in the prompt text. */
export function composeInstructions(
	text: string,
	role: { name: string; title: string; roleDir: string; notesDir: string; reportCounts?: readonly string[] },
): string {
	return text
		.replaceAll("{counts}", countsText(role.reportCounts))
		.replaceAll("{role}", role.name)
		.replaceAll("{title}", role.title)
		.replaceAll("{roleDir}", role.roleDir)
		.replaceAll("{notes}", role.notesDir);
}

/** The role folder's files as absolute paths (settings.json, dotfiles and subfolders excepted), sorted. */
async function roleFiles(dir: string): Promise<string[] | undefined> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries
			.filter((entry) => !entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "settings.json")
			.map((entry) => entry.name)
			.sort()
			.map((name) => join(dir, name));
	} catch {
		return undefined;
	}
}

/** The generated "Your files" section appended to every role prompt: open by path, never search the disk. */
export function yourFilesSection(files: string[], notesDir: string): string {
	return [
		"## Your files",
		"",
		"Open these by these paths; never search the disk for them.",
		...files,
		`${notesDir} — your notes folder`,
	].join("\n");
}

/** Read and validate the roles/ folder. Never throws for a bad role folder. */
export async function loadRoles(options: { rolesRoot: string; stateDir: string }): Promise<LoadedRoles> {
	const problems: string[] = [];
	let defaults = FALLBACK_DEFAULTS;
	try {
		const parsed: unknown = JSON.parse(await readFile(join(options.rolesRoot, "defaults.json"), "utf8"));
		if (isRecord(parsed) && isRecord(parsed.model) && typeof parsed.thinking === "string" && THINKING_LEVELS.has(parsed.thinking)) {
			defaults = parsed as unknown as RoleDefaults;
		} else {
			problems.push("roles/defaults.json is malformed; using the plan default model");
		}
	} catch {
		problems.push("roles/defaults.json is missing or unreadable; using the plan default model");
	}
	let preamble = "";
	try {
		preamble = await readFile(join(options.rolesRoot, "PREAMBLE.md"), "utf8");
	} catch {
		problems.push("roles/PREAMBLE.md is missing or unreadable; roles run without the shared preamble");
	}
	const seenBoardNames = new Map<string, string>();
	const enabled: RoleDefinition[] = [];
	const disabled: RoleDefinition[] = [];
	const result = (): LoadedRoles => ({ defaults, enabled, disabled, problems });
	let entries: string[] = [];
	try {
		entries = (await readdir(options.rolesRoot)).filter(
			(name) => !name.startsWith(".") && name !== "defaults.json" && name !== "PREAMBLE.md",
		);
	} catch (error) {
		problems.push(`roles/ could not be read: ${error instanceof Error ? error.message : String(error)}`);
		return result();
	}
	for (const name of entries.sort()) {
		const dir = join(options.rolesRoot, name);
		let rawSettings: unknown;
		try {
			rawSettings = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
		} catch {
			problems.push(`role ${name}: settings.json is missing or not valid JSON; skipped`);
			continue;
		}
		const settings = parseSettings(name, rawSettings, problems);
		if (settings === undefined) continue;
		const previous = seenBoardNames.get(settings.boardName);
		if (previous !== undefined) {
			problems.push(`role ${name}: boardName ${settings.boardName} is already used by role ${previous}; skipped`);
			continue;
		}
		seenBoardNames.set(settings.boardName, name);
		let instructionsText: string;
		try {
			instructionsText = await readFile(join(dir, "instructions.md"), "utf8");
		} catch {
			problems.push(`role ${name}: instructions.md is missing or unreadable; skipped`);
			continue;
		}
		const notesDir = join(options.stateDir, "roles", name, "notes");
		const files = await roleFiles(dir);
		let prompt = `${preamble}${preamble === "" ? "" : "\n\n"}${instructionsText}`;
		if (files === undefined) {
			problems.push(`role ${name}: the folder could not be listed for the file section; continuing without it`);
		} else {
			prompt = `${prompt}\n\n${yourFilesSection(files, notesDir)}`;
		}
		const definition: RoleDefinition = {
			name,
			dir,
			settings,
			model: settings.model ?? defaults.model,
			thinking: settings.thinking ?? defaults.thinking,
			instructions: composeInstructions(prompt, {
				name,
				title: settings.title,
				roleDir: dir,
				notesDir,
				reportCounts: settings.reportCounts,
			}),
			notesDir,
		};
		if (settings.enabled) enabled.push(definition);
		else disabled.push(definition);
	}
	return result();
}
