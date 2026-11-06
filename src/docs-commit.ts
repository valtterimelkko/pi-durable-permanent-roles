/**
 * The docs-only-commits hard limit: a role carrying
 * `limits: ["docs-only-commits"]` commits documentation only through the `docs_commit` tool,
 * and its bash refuses the git write commands. The role's judgement decides what to fix; this
 * module decides how a change may land. Selected per conversation in src/harness.ts — roles
 * without the limit see neither the tool nor the wrap.
 *
 * The bash refusal sits beside the shared rules in src/limits.ts: it tokenises
 * like they do (quoted mentions are text; `bash -c`, `$(…)`, backticks are judged as command
 * lines) and refuses `git add/commit/push/reset/restore/stash` and `git checkout --` with a
 * reason naming docs_commit. Like the reboot limit it is a guard against a careless agent,
 * not a sandbox.
 *
 * Every git and guide-check call goes through the injectable `DocsCommitDeps` seam;
 * tests use a recording fake, except one temp-repository integration test.
 */
import { execFile } from "node:child_process";
import { basename, isAbsolute, resolve } from "node:path";
import { defineExtension, defineTool, wrapTool, type Extension } from "@earendil-works/pi-durable";
import { arr, obj, str } from "@earendil-works/pi-schema";
import { createBashTool } from "@earendil-works/pi-durable/tools";
const MAX_CAPTURED_OUTPUT = 32_768;
import { commandSegments, hiddenCommandLines } from "./limits.ts";
import type { RoleDefinition } from "./types.ts";

/** The limit this module serves (src/types.ts ROLE_LIMITS). */
export const DOCS_ONLY_LIMIT = "docs-only-commits";
/** Repo guides: AGENTS.md or CLAUDE.md at any depth. */
const GUIDE_BASENAMES = new Set(["AGENTS.md", "CLAUDE.md"]);
/** How long one git or guide-check call may take (a push can be slow). */
const RUN_TIMEOUT_MS = 120_000;

/** One external command's result: an exit code, never a throw. */
export type DocsCommandResult = { code: number; stdout: string; stderr: string };

/** Runs one command in a directory without a shell. Tests inject a recording fake. */
export type DocsCommandRunner = {
	run(cwd: string, argv: readonly string[], options?: { timeoutMs?: number }): Promise<DocsCommandResult>;
};

export type DocsCommitDeps = {
	/** The role whose conversation a tool call belongs to (HostApi.roleForConversation). */
	roleForConversation(conversationId: string): RoleDefinition | undefined;
	/** The command seam for git and the guide check, run inside the target repository. */
	runner: DocsCommandRunner;
	/**
	 * The repo-guide checker to run when a guide is among the paths (`<checker> repo .` inside the
	 * repository). Undefined (the default): the guide step is skipped.
	 */
	guideCheck?: string;
};

function capOutput(text: string): string {
	if (text.length <= MAX_CAPTURED_OUTPUT) return text;
	return `${text.slice(0, MAX_CAPTURED_OUTPUT)}\n…[output truncated]`;
}

/** The exit code of a failed execFile: a numeric code when the child exited, otherwise 1. */
function exitCode(error: { code?: unknown } | null): number {
	if (error === null) return 0;
	return typeof error.code === "number" ? error.code : 1;
}

/** The production seam: execFile, no shell, output capped, a result instead of a throw. */
export function createDocsCommandRunner(): DocsCommandRunner {
	return {
		run(cwd, argv, options = {}) {
			const timeoutMs = options.timeoutMs ?? RUN_TIMEOUT_MS;
			return new Promise((resolveRun) => {
				execFile(
					argv[0]!,
					argv.slice(1) as string[],
					{ cwd, timeout: timeoutMs, killSignal: "SIGKILL", encoding: "utf8", maxBuffer: 16 * 1024 * 1024, shell: false },
					(error, stdout, stderr) => {
						resolveRun({ code: exitCode(error), stdout: capOutput(String(stdout ?? "")), stderr: capOutput(String(stderr ?? "")) });
					},
				);
			});
		},
	};
}

/**
 * Documentation is `*.md`, `*.mdx`, or anything under a `docs/` directory (which covers
 * `*.txt` under docs). A trailing `docs/` directory path counts; a `*.txt` outside docs does not.
 */
export function isDocPath(path: string): boolean {
	if (path.split("/").includes("docs")) return true;
	return /\.mdx?$/.test(path);
}

/** A repo guide: AGENTS.md or CLAUDE.md at any depth. */
export function isGuidePath(path: string): boolean {
	return GUIDE_BASENAMES.has(basename(path));
}

/** One entry of `git status --porcelain -z --untracked-files=all`: status pair plus path(s). */
function changedPaths(porcelainZ: string): string[] {
	const paths: string[] = [];
	const chunks = porcelainZ.split("\0");
	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i]!;
		if (chunk.length < 4) continue; // "XY path" at the shortest; the trailing "" after the last NUL too
		const xy = chunk.slice(0, 2);
		paths.push(chunk.slice(3));
		if (xy.includes("R") || xy.includes("C")) {
			// A staged rename/copied entry carries the original path in a second NUL field.
			const original = chunks[i + 1];
			if (original !== undefined && original !== "") {
				paths.push(original);
				i++;
			}
		}
	}
	return paths;
}

/** Is a changed path covered by the allowed list? An allowed path ending in / is a directory. */
function isAllowed(changed: string, allowed: readonly string[]): boolean {
	return allowed.some((path) =>
		path.endsWith("/") ? changed.startsWith(path) : changed === path || changed.startsWith(`${path}/`),
	);
}

/** The changed paths the role did not name — a non-empty answer refuses the commit. */
export function changesOutsidePaths(porcelainZ: string, allowed: readonly string[]): string[] {
	return changedPaths(porcelainZ).filter((path) => !isAllowed(path, allowed));
}

function normaliseRepo(repo: string): string {
	return repo.replace(/\/+$/, "");
}

/* ------------------------------------------------------------------ */
/* The per-role bash refusal                                           */
/* ------------------------------------------------------------------ */

const DOCS_REFUSED_GIT = new Set(["add", "commit", "push", "reset", "restore", "stash"]);
/** `git` flags whose value is a separate next word (`-c` takes `key=val` then the command). */
const GIT_VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--exec-path"]);
const SHELL_NAMES = new Set(["bash", "sh", "dash", "zsh"]);

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

/** The words of one segment; a quoted chunk stays inside its word (so `"git add"` is one word). */
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

/** The git subcommand of one `git` occurrence: the first non-flag word after it. */
function gitSubcommand(words: readonly string[], gitAt: number): string {
	let j = gitAt + 1;
	while (j < words.length) {
		const word = unquote(words[j]!);
		if (word.startsWith("-")) {
			// A value-carrying flag consumes the next word only when the value is separate:
			// `git -C /dir add` and `git -c key=val push` skip their values, `--git-dir=/x add` does not.
			if (!word.includes("=") && GIT_VALUE_FLAGS.has(word)) j++;
			j++;
			continue;
		}
		return word;
	}
	return "";
}

function gitRefusalInSegment(words: readonly string[]): string | undefined {
	for (let i = 0; i < words.length; i++) {
		if (basenameOf(unquote(words[i]!)) !== "git") continue;
		const sub = gitSubcommand(words, i);
		if (sub === "") continue; // a bare `git` (e.g. `git --version` has none either way) — harmless
		if (sub === "checkout") {
			// Only the path-discarding form is refused; `git checkout main` may run.
			if (words.slice(i + 1).some((word) => unquote(word) === "--")) {
				return "refused: `git checkout --` discards working-tree changes; use docs_commit — a docs-only role commits documentation only through the docs_commit tool";
			}
			return undefined;
		}
		if (DOCS_REFUSED_GIT.has(sub)) {
			return `refused: \`git ${sub}\` writes a repository; use docs_commit — a docs-only role commits documentation only through the docs_commit tool`;
		}
		return undefined; // this segment's command is git with a read-only subcommand
	}
	return undefined;
}

/**
 * Why the command must not run for a docs-only role, or undefined when it may. Judged like
 * src/limits.ts: per shell segment, quoted mentions are text, and `bash -c`, `$(…)` and
 * backticks are command lines in their own right.
 */
export function docsOnlyBashRefusal(command: string, depth = 0): string | undefined {
	if (depth > 8) return undefined;
	for (const line of command.split("\n")) {
		// eval, `-c` strings, here-strings and text piped into a shell (the shared limit's forms, src/limits.ts).
		for (const inner of hiddenCommandLines(line)) {
			const reason = docsOnlyBashRefusal(inner, depth + 1);
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
			const reason = docsOnlyBashRefusal(line.slice(i + 2, j - 1), depth + 1);
			if (reason !== undefined) return reason;
			i = j;
		}
		for (let i = 0; i < line.length; i++) {
			if (line[i] !== "`") continue;
			const end = line.indexOf("`", i + 1);
			if (end < 0) break;
			const reason = docsOnlyBashRefusal(line.slice(i + 1, end), depth + 1);
			if (reason !== undefined) return reason;
			i = end;
		}
		for (const segment of commandSegments(line)) {
			const words = wordsOf(segment);
			const direct = gitRefusalInSegment(words);
			if (direct !== undefined) return direct;
			for (let j = 0; j < words.length - 1; j++) {
				const name = basenameOf(unquote(words[j]!));
				const flag = unquote(words[j + 1]!);
				if (!SHELL_NAMES.has(name) || !/^-[A-Za-z]*c[A-Za-z]*$/.test(flag)) continue;
				const script = words[j + 2];
				if (script === undefined) break;
				const reason = docsOnlyBashRefusal(unquote(script), depth + 1);
				if (reason !== undefined) return reason;
				break;
			}
		}
	}
	return undefined;
}

/** Wrap one bash tool so a docs-only role's git write commands return an error result. */
export function wrapBashForDocsCommits(bash: ReturnType<typeof createBashTool>): ReturnType<typeof createBashTool> {
	return {
		...bash,
		execute: async (args, api, context) => {
			const reason = docsOnlyBashRefusal(args.command);
			if (reason !== undefined) {
				return { output: [{ type: "text", text: reason }], isError: true };
			}
			return bash.execute(args, api, context);
		},
	};
}

/* ------------------------------------------------------------------ */
/* The docs_commit tool                                                */
/* ------------------------------------------------------------------ */

function reply(body: Record<string, unknown>, isError = false) {
	return {
		output: [{ type: "text" as const, text: JSON.stringify(body) }],
		...(isError ? { isError: true } : {}),
	};
}

function singleLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Validate the arguments; the refusal message explains, the caller replies with it. */
function validateArgs(
	args: { repo: unknown; paths: unknown; message: unknown },
	roleCwd: string,
): { repo: string; paths: string[]; message: string } | string {
	const repoRaw = typeof args.repo === "string" ? args.repo.trim() : "";
	if (repoRaw === "") return "repo must be the repository's absolute directory";
	const repo = isAbsolute(repoRaw) ? resolve(repoRaw) : resolve(roleCwd, repoRaw);
	if (!Array.isArray(args.paths) || args.paths.length === 0 || args.paths.some((path) => typeof path !== "string" || path.trim() === "")) {
		return "paths must be a non-empty list of repository-relative file paths";
	}
	const paths: string[] = [];
	for (const raw of args.paths as string[]) {
		const path = raw.trim();
		if (isAbsolute(path) || path.startsWith("~")) return `path must be relative to the repository: ${path}`;
		if (path.split("/").includes("..")) return `path must stay inside the repository: ${path}`;
		if (!isDocPath(path)) {
			return `not documentation: ${path}. Only *.md, *.mdx and files under a docs/ directory may be committed`;
		}
		paths.push(path);
	}
	const message = singleLine(typeof args.message === "string" ? args.message : "").slice(0, 1_000);
	if (message === "") return "message must be a non-empty commit message";
	return { repo, paths, message };
}

/**
 * The tool a docs-only role commits through: refuse non-documentation paths, refuse a
 * repository with changes outside the given paths, run the configured guide checker when a guide
 * is among the paths — then
 * `git add --`, `git commit` with a trailer naming the role, and `git push` on the current
 * branch. Returns the commit hash or the refusal reason.
 */
export function docsCommitExtension(deps: DocsCommitDeps): Extension {
	const docsCommit = defineTool({
		name: "docs_commit",
		description:
			"Commit and push documentation-only changes in one repository: stage exactly the given doc paths, commit with a message naming you, push the current branch, return the commit hash. " +
			"This is the only way a docs-only role may run git add/commit/push (its bash refuses them). " +
			"The tool refuses non-documentation paths, a repository with changes outside the given paths, and a failing guide check.",
		parameters: obj(
			{
				repo: str({ description: "The repository's absolute directory." }),
				paths: arr(str(), { description: "Repository-relative doc paths (*.md, *.mdx, docs/**), exactly what this commit may touch." }),
				message: str({ description: "The commit message (one line)." }),
			},
			// Open like TypeBox's Type.Object was: an extra argument from the model stays accepted.
			{ open: true },
		),
		execute: async (args, api) => {
			const role = deps.roleForConversation(String(api.conversationId));
			if (role === undefined) {
				return reply({ status: "refused", message: "This conversation is not a standing role." }, true);
			}
			if (!role.settings.limits?.includes(DOCS_ONLY_LIMIT)) {
				return reply({ status: "refused", message: `The role '${role.name}' does not carry the ${DOCS_ONLY_LIMIT} limit.` }, true);
			}
			const parsed = validateArgs(args, role.settings.cwd);
			if (typeof parsed === "string") return reply({ status: "refused", message: parsed }, true);
			const { repo, paths, message } = parsed;
			const run = (argv: readonly string[], timeoutMs?: number) => deps.runner.run(repo, argv, { timeoutMs });

			// 1. The repository must have changes only inside the given paths — the role stages
			//    nothing of anyone else's, and something must be committed at all.
			const status = await run(["git", "status", "--porcelain", "-z", "--untracked-files=all"]);
			if (status.code !== 0) {
				return reply({ status: "error", message: `git status failed: ${singleLine(status.stderr || status.stdout)}` }, true);
			}
			const outside = changesOutsidePaths(status.stdout, paths);
			if (outside.length > 0) {
				return reply(
					{ status: "refused", message: `${repo} has changes outside the given paths: ${outside.join(", ")}. Never stage or commit another change; commit only your own doc paths.` },
					true,
				);
			}
			if (changedPaths(status.stdout).length === 0) {
				return reply({ status: "refused", message: `nothing to commit: none of ${paths.join(", ")} has changes in ${repo}` }, true);
			}

			// 3. A guide among the paths must pass the configured guide checker first.
			if (paths.some(isGuidePath) && deps.guideCheck !== undefined) {
				const guide = await run([deps.guideCheck, "repo", "."]);
				if (guide.code !== 0) {
					return reply({ status: "refused", message: `the guide check failed; fix the guide or flag it to the owner: ${singleLine(guide.stderr || guide.stdout)}` }, true);
				}
			}

			// 4. Stage, commit with the role trailer, read the hash, push.
			const add = await run(["git", "add", "--", ...paths]);
			if (add.code !== 0) {
				return reply({ status: "error", message: `git add failed: ${singleLine(add.stderr || add.stdout)}` }, true);
			}
			const commit = await run(["git", "commit", "-m", `${message}\n\nRole: ${role.name} (pi-roles host)`]);
			if (commit.code !== 0) {
				return reply({ status: "error", message: `git commit failed: ${singleLine(commit.stderr || commit.stdout)}` }, true);
			}
			const head = await run(["git", "rev-parse", "HEAD"]);
			const hash = head.code === 0 ? head.stdout.trim() : undefined;
			const push = await run(["git", "push"]);
			if (push.code !== 0) {
				return reply(
					{ status: "error", message: `committed ${hash ?? "(hash unreadable)"} but the push failed — report this: ${singleLine(push.stderr || push.stdout)}` },
					true,
				);
			}
			return reply({ status: "committed", repo, commit: hash, pushed: true, paths });
		},
	});
	// An explicit Extension annotation: the extension carries typed tools and a bash wrap, which
	// defineExtension's single Tool generic cannot infer together (the same shape limits.ts uses).
	const extension: Extension = {
		name: "pi-roles-docs-commit",
		tools: [docsCommit],
		wraps: [wrapTool(createBashTool(), wrapBashForDocsCommits)],
	};
	return defineExtension(extension);
}
