/**
 * The read-only-messaging hard limit: a role carrying `limits: ["read-only-messaging"]` must not write the
 * accounts it watches. Its bash refuses every configured CLI invocation whose verb or flags are on that CLI's
 * never-run list — a table the role folder itself supplies (`readOnlyRules` in settings.json, default
 * `never-run.json`; roles/work-messages and roles/personal-messages ship examples). Read verbs stay allowed; the
 * role's instructions carry the read-only discipline. Selected per conversation in src/harness.ts; roles without
 * the limit see no wrap.
 *
 * The rules file (JSON, validated at load):
 *   { "reference": "roles/work-messages/MESSAGING.md",
 *     "role": "work-messages",
 *     "rules": [ { "cli": "YOUR_MAIL_CLI", "surface": "the work mailbox",
 *                  "verbs": [ { "path": ["send"], "except": [["send", "drafts"]] } ],
 *                  "flags": ["--send-now"] } ] }
 *
 * Judged like src/limits.ts and src/docs-commit.ts, whose tokeniser and recursion shape this
 * module copies: per shell segment (`commandSegments`, shared), quoted mentions are text,
 * `bash -c`/`sh -c`/`$(…)`/backticks are command lines in their own right, and the CLI is
 * recognised by basename wherever it stands — through `sudo`/`env`/assignment prefixes,
 * `xargs`, `timeout`, full `/usr/local/bin/` paths, a source checkout path and a
 * `python3 …/your-cli`-style entry point. Like the other limits it is a guard against a
 * careless agent, not a sandbox: a word-for-word mention of a never-run form right after the
 * CLI's name (even inside `grep …`) is refused too — fail closed, the direction a write to
 * someone's mailbox fails in. A global flag that takes a separate value before the verb
 * would also defeat the verb match; a table must not rely on one.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { defineExtension, wrapTool, type Extension } from "@earendil-works/pi-durable";
import { createBashTool } from "@earendil-works/pi-durable/tools";
import { commandSegments, hiddenCommandLines } from "./limits.ts";

/** The limit this module serves (src/types.ts ROLE_LIMITS, src/roles.ts validation, src/harness.ts selection). */
export const READ_ONLY_MESSAGING_LIMIT = "read-only-messaging";

/** One refused verb: the words after the CLI, matched as a prefix of its non-flag words. */
export type RefusedVerb = {
	path: readonly string[];
	/** Paths that begin like this but are allowed reads, e.g. `["send", "drafts"]` for `["send"]`. */
	except?: readonly (readonly string[])[];
};

/** One CLI's never-run list. */
export type MessagingRule = {
	/** The CLI's basename, however the invocation spells the path. */
	cli: string;
	/** What a write here touches — named in the refusal reason. */
	surface: string;
	verbs: readonly RefusedVerb[];
	/** Flags refused anywhere in the invocation. */
	flags: readonly string[];
};

/**
 * One limit's table: its never-run rules, the reference they come from and the role the refusal names. Built from a
 * role folder's rules file by `loadNeverRunTable`, or directly in tests.
 */
export type NeverRunTable = {
	rules: readonly MessagingRule[];
	reference: string;
	role: string;
	byCli: ReadonlyMap<string, MessagingRule>;
};

export function neverRunTable(rules: readonly MessagingRule[], reference: string, role: string): NeverRunTable {
	return { rules, reference, role, byCli: new Map(rules.map((rule) => [rule.cli, rule])) };
}

/** Shells whose `-c` string is really the command line. */
const SHELLS = new Set(["bash", "sh", "dash", "zsh"]);

function basenameOf(word: string): string {
	return basename(word.replace(/\/+$/, ""));
}

/** Strip one layer of matching quotes. */
function unquote(word: string): string {
	let out = word.trim();
	while (out.length >= 2 && ((out.startsWith("'") && out.endsWith("'")) || (out.startsWith('"') && out.endsWith('"')))) {
		out = out.slice(1, -1).trim();
	}
	return out;
}

/** The words of one segment; a quoted chunk stays inside its word. */
function wordsOf(segment: string): string[] {
	const words: string[] = [];
	let current = "";
	let quote: string | undefined;
	for (const char of segment) {
		if (quote !== undefined) {
			current += char;
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			current += char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current !== "") words.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (current !== "") words.push(current);
	return words;
}

function verbRefusal(table: NeverRunTable, cli: string, path: string, surface: string): string {
	const what = path === "" ? cli : `${cli} ${path}`;
	return `refused: \`${what}\` writes ${surface}, which the ${table.role} role never does — its never-run list is ${table.reference}`;
}

function flagRefusal(table: NeverRunTable, cli: string, flag: string, surface: string): string {
	return `refused: \`${cli} ${flag}\` is a write-side flag on ${cli}'s never-run list (${surface}) — the ${table.role} role is read only; see ${table.reference}`;
}

/** Judge one CLI occurrence: `rest` is everything after the CLI's word. */
function refusalForRest(table: NeverRunTable, rule: MessagingRule, rest: readonly string[]): string | undefined {
	for (const flag of rule.flags) {
		if (rest.includes(flag)) return flagRefusal(table, rule.cli, flag, rule.surface);
	}
	const args = rest.filter((word) => !word.startsWith("-"));
	for (const verb of rule.verbs) {
		if (verb.path.length > args.length) continue;
		if (!verb.path.every((word, index) => args[index] === word)) continue;
		if (verb.except?.some((allow) => allow.every((word, index) => args[index] === word))) continue;
		return verbRefusal(table, rule.cli, verb.path.join(" "), rule.surface);
	}
	return undefined;
}

/** Scan every word of one segment for a CLI occurrence; judge the words after it. */
function cliRefusalInWords(table: NeverRunTable, words: readonly string[]): string | undefined {
	for (let index = 0; index < words.length; index++) {
		const rule = table.byCli.get(basenameOf(unquote(words[index]!)).replace(/\.(py|js|mjs|cjs|sh)$/, ""));
		if (rule === undefined) continue;
		const reason = refusalForRest(table, rule, words.slice(index + 1).map(unquote));
		if (reason !== undefined) return reason;
	}
	return undefined;
}

/** The same judgement for any never-run table. */
export function tableBashRefusal(table: NeverRunTable, command: string, depth = 0): string | undefined {
	if (depth > 8) return undefined;
	for (const line of command.split("\n")) {
		// eval, `-c` strings, here-strings and text piped into a shell (the shared limit's forms, src/limits.ts).
		for (const inner of hiddenCommandLines(line)) {
			const reason = tableBashRefusal(table, inner, depth + 1);
			if (reason !== undefined) return reason;
		}
		// $(…) with nesting, then backtick spans.
		for (let i = 0; i < line.length - 1; i++) {
			if (line[i] !== "$" || line[i + 1] !== "(") continue;
			let nesting = 1;
			let j = i + 2;
			while (j < line.length && nesting > 0) {
				if (line[j] === "(") nesting++;
				if (line[j] === ")") nesting--;
				j++;
			}
			const reason = tableBashRefusal(table, line.slice(i + 2, j - 1), depth + 1);
			if (reason !== undefined) return reason;
			i = j;
		}
		for (let i = 0; i < line.length; i++) {
			if (line[i] !== "`") continue;
			const end = line.indexOf("`", i + 1);
			if (end < 0) break;
			const reason = tableBashRefusal(table, line.slice(i + 1, end), depth + 1);
			if (reason !== undefined) return reason;
			i = end;
		}
		for (const segment of commandSegments(line)) {
			const words = wordsOf(segment);
			const direct = cliRefusalInWords(table, words);
			if (direct !== undefined) return direct;
			for (let j = 0; j < words.length - 1; j++) {
				const name = basenameOf(unquote(words[j]!));
				const flag = unquote(words[j + 1]!);
				if (!SHELLS.has(name) || !/^-[A-Za-z]*c[A-Za-z]*$/.test(flag)) continue;
				const script = words[j + 2];
				if (script === undefined) break;
				const reason = tableBashRefusal(table, unquote(script), depth + 1);
				if (reason !== undefined) return reason;
				break;
			}
		}
	}
	return undefined;
}

/** Wrap one bash tool so a table's never-run commands return an error result. */
export function wrapBashForTable(table: NeverRunTable): (bash: ReturnType<typeof createBashTool>) => ReturnType<typeof createBashTool> {
	return (bash) => ({
		...bash,
		execute: async (args, api, context) => {
			const reason = tableBashRefusal(table, args.command);
			if (reason !== undefined) {
				return { output: [{ type: "text", text: reason }], isError: true };
			}
			return bash.execute(args, api, context);
		},
	});
}

/** The per-role extension (src/harness.ts): named after the role, so every role's registry entry is unique. */
export function readOnlyMessagingExtensionFor(roleName: string, table: NeverRunTable): Extension {
	return defineExtension({
		name: `read-only-messaging:${roleName}`,
		wraps: [wrapTool(createBashTool(), wrapBashForTable(table))],
	});
}

// ---------------------------------------------------------------- the rules file

/** The default rules file name inside a role folder. */
export const RULES_FILENAME_DEFAULT = "never-run.json";

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function parseRule(raw: unknown, where: string): MessagingRule {
	if (raw === null || typeof raw !== "object") throw new Error(`${where}: every rule must be an object`);
	const rule = raw as Record<string, unknown>;
	if (typeof rule.cli !== "string" || rule.cli.trim() === "") throw new Error(`${where}: every rule needs a non-empty cli`);
	if (typeof rule.surface !== "string" || rule.surface.trim() === "") throw new Error(`${where}: ${rule.cli} needs a non-empty surface`);
	if (!isStringArray(rule.flags)) throw new Error(`${where}: ${rule.cli} flags must be a list of strings`);
	if (!Array.isArray(rule.verbs)) throw new Error(`${where}: ${rule.cli} verbs must be a list`);
	const verbs = rule.verbs.map((verb, index) => {
		const label = `${where}: ${rule.cli} verb ${String(index)}`;
		if (verb === null || typeof verb !== "object") throw new Error(`${label} must be an object`);
		const entry = verb as Record<string, unknown>;
		if (!isStringArray(entry.path)) throw new Error(`${label} needs a path (a list of words; empty refuses the CLI outright)`);
		if (entry.except !== undefined && !Array.isArray(entry.except) && !isStringArray(entry.except)) {
			throw new Error(`${label} except must be a list of word lists`);
		}
		const except =
			entry.except === undefined
				? undefined
				: (entry.except as unknown[]).map((allow) => {
						if (!isStringArray(allow)) throw new Error(`${label} except must be a list of word lists`);
						return allow;
					});
		return { path: entry.path, ...(except === undefined ? {} : { except }) };
	});
	return { cli: rule.cli, surface: rule.surface, verbs, flags: rule.flags };
}

/**
 * Read and validate a role folder's rules file. Throws with a plain-words reason (the harness reports it and the
 * role simply gets no wrap — a wrap that refuses nothing would be a lie).
 */
export async function loadNeverRunTable(path: string): Promise<NeverRunTable> {
	const raw: unknown = JSON.parse(await readFile(path, "utf8"));
	if (raw === null || typeof raw !== "object") throw new Error("the rules file must be an object");
	const parsed = raw as Record<string, unknown>;
	if (!Array.isArray(parsed.rules)) throw new Error("the rules file needs a rules list");
	if (typeof parsed.reference !== "string" || parsed.reference.trim() === "") throw new Error("the rules file needs a non-empty reference");
	if (typeof parsed.role !== "string" || parsed.role.trim() === "") throw new Error("the rules file needs a non-empty role");
	const rules = parsed.rules.map((rule) => parseRule(rule, String(parsed.reference)));
	return neverRunTable(rules, parsed.reference, parsed.role);
}
