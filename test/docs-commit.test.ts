/**
 * The docs-only-commits limit: the `docs_commit` tool — its refusals and
 * its success path — and the per-role bash refusal of the git write commands. Every git, board
 * and guide-check call goes through the injectable seam; the one integration test at the bottom
 * uses a temp git repository this test created.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ConversationId } from "@earendil-works/pi-durable";
import { afterAll, describe, expect, it } from "vitest";
import {
	changesOutsidePaths,
	createDocsCommandRunner,
	docsCommitExtension,
	docsOnlyBashRefusal,
	isDocPath,
	isGuidePath,
} from "../src/docs-commit.ts";
import type { RoleDefinition, RoleSettings } from "../src/types.ts";

const run = promisify(execFile);
const conversation = 31 as ConversationId;

function role(overrides: Partial<RoleSettings> = {}): RoleDefinition {
	return {
		name: "docs-currency",
		dir: "/srv/roles/docs-currency",
		settings: {
			enabled: true,
			title: "Docs currency",
			boardName: "role-docs-currency",
			schedule: [],
			cwd: "/root",
			tools: ["coding", "integrations", "notify"],
			limits: ["docs-only-commits"],
			...overrides,
		},
		model: { provider: "faux", modelId: "m-1" },
		thinking: "high",
		instructions: "",
		notesDir: "/var/lib/roles/roles/docs-currency/notes",
	};
}

type Recorded = { cwd: string; argv: string[] };

/** A seam that records every call and answers from a per-command table ("git status" → result). */
function recordingRunner(results: Record<string, { code?: number; stdout?: string; stderr?: string }> = {}) {
	const calls: Recorded[] = [];
	return {
		calls,
		runner: {
			async run(cwd: string, argv: readonly string[]) {
				calls.push({ cwd, argv: [...argv] });
				const answer = results[argv.slice(0, 2).join(" ")] ?? {};
				return { code: 0, stdout: "", stderr: "", ...answer };
			},
		},
	};
}

function setup(
	options: {
		role?: RoleDefinition | undefined;
		results?: Record<string, { code?: number; stdout?: string; stderr?: string }>;
		guideCheck?: string;
	} = {},
) {
	const recorder = recordingRunner(options.results);
	const extension = docsCommitExtension({
		roleForConversation: () => ("role" in options ? options.role : role()),
		runner: recorder.runner,
		...(options.guideCheck === undefined ? {} : { guideCheck: options.guideCheck }),
	});
	const found = extension.tools?.find((candidate) => candidate.name === "docs_commit");
	if (found === undefined) throw new Error("docs_commit is not registered");
	const api = { conversationId: conversation };
	const call = (args: Record<string, unknown>) => found.execute(args as never, api as never, undefined as never);
	return { call, calls: recorder.calls, extension };
}

function body(result: { output?: unknown; isError?: boolean }): Record<string, unknown> {
	const content = result.output as Array<{ type: string; text: string }>;
	return JSON.parse(content[0].text) as Record<string, unknown>;
}

describe("path classification", () => {
	it("documentation is *.md, *.mdx, or anything under a docs/ directory (incl. *.txt under docs)", () => {
		for (const path of ["README.md", "docs/notes.txt", "a/docs/b.md", "guide.mdx", "AGENTS.md", "docs/"]) {
			expect(isDocPath(path), path).toBe(true);
		}
		for (const path of ["src/index.ts", "notes.txt", "package.json", "docs.txt", "bin/x.txt"]) {
			expect(isDocPath(path), path).toBe(false);
		}
	});

	it("a guide is AGENTS.md or CLAUDE.md at any depth", () => {
		expect(isGuidePath("AGENTS.md")).toBe(true);
		expect(isGuidePath("sub/CLAUDE.md")).toBe(true);
		expect(isGuidePath("README.md")).toBe(false);
	});
});

describe("the per-role bash refusal", () => {
	it("refuses the git write commands with a reason naming docs_commit", () => {
		const refused = [
			"git add -A",
			"git add file.md",
			"git commit -m x",
			"git push",
			"git push --force origin main",
			"git reset --hard HEAD~1",
			"git checkout -- README.md",
			"git restore .",
			"git stash",
			"git stash list",
			"git -C /tmp/repo add x",
			"git -c core.hooksPath=/dev/null push",
			"git --git-dir=/x add file.md",
			"/usr/bin/git commit -m x",
			"echo hi && git add x",
			"sudo git push",
			"bash -c 'git push'",
			'sh -c "git add file.md"',
			"$(git push origin)",
			"`git reset --hard`",
		];
		for (const command of refused) {
			expect(docsOnlyBashRefusal(command), command).toMatch(/docs_commit/);
		}
	});

	it("lets reads, quoted mentions and a plain branch checkout through", () => {
		for (const command of [
			"git status --porcelain",
			"git log --since=1.day --name-only",
			"git diff HEAD",
			'echo "git add is refused"',
			"git log --grep=stash",
			"git checkout main",
			"git show HEAD",
			"ls docs",
			"cat AGENTS.md",
		]) {
			expect(docsOnlyBashRefusal(command), command).toBeUndefined();
		}
	});
});

describe("git status parsing", () => {
	it("lists changed paths outside the allowed set (untracked included)", () => {
		const status = " M src/a.ts\u0000?? README.md\u0000 M docs/guide.md\u0000";
		expect(changesOutsidePaths(status, ["README.md", "docs/guide.md"])).toEqual(["src/a.ts"]);
	});

	it("checks both sides of a staged rename; a directory path covers its files", () => {
		const status = "R  docs/b.md\u0000docs/a.md\u0000";
		expect(changesOutsidePaths(status, ["docs/b.md"])).toEqual(["docs/a.md"]);
		expect(changesOutsidePaths(status, ["docs/"])).toEqual([]);
	});
});

describe("the docs_commit tool", () => {
	const args = { repo: "/repos/demo", paths: ["README.md", "docs/guide.md"], message: "docs: fix the readme" };
	const cleanStatus = "?? README.md\u0000 M docs/guide.md\u0000";

	it("refuses a conversation that is not a standing role, or a role without the limit, without running anything", async () => {
		for (const missing of [{ role: undefined }, { role: role({ limits: undefined }) }]) {
			const { call, calls } = setup(missing);
			const result = await call(args);
			expect(result.isError).toBe(true);
			expect(body(result).status).toBe("refused");
			expect(calls).toEqual([]);
		}
	});

	it("refuses non-documentation paths and paths that escape the repository", async () => {
		for (const paths of [["src/index.ts"], ["notes.txt"], ["../outside.md"], ["/etc/hosts"], ["~/.bashrc"], []]) {
			const { call, calls } = setup({ results: { "git status": { stdout: cleanStatus } } });
			const result = await call({ ...args, paths });
			expect(result.isError).toBe(true);
			expect(body(result).status).toBe("refused");
			expect(calls).toEqual([]);
		}
	});

	it("refuses when the repository has changes outside the given paths, and stages nothing", async () => {
		const { call, calls } = setup({ results: { "git status": { stdout: " M src/a.ts\u0000?? README.md\u0000" } } });
		const result = await call({ ...args, paths: ["README.md"] });
		expect(result.isError).toBe(true);
		expect(body(result).message).toContain("src/a.ts");
		expect(calls.map((c) => c.argv.join(" "))).toEqual(["git status --porcelain -z --untracked-files=all"]);
	});

	it("refuses when none of the paths has anything to commit", async () => {
		const { call, calls } = setup({ results: { "git status": { stdout: "" } } });
		const result = await call(args);
		expect(result.isError).toBe(true);
		expect(body(result).message).toMatch(/nothing to commit/);
		expect(calls).toHaveLength(1);
	});

	it("refuses when a guide is among the paths and the guide check fails, before staging", async () => {
		const { call, calls } = setup({
			guideCheck: "/usr/local/bin/guide-check",
			results: {
				"git status": { stdout: " M AGENTS.md\u0000" },
				["/usr/local/bin/guide-check repo"]: { code: 1, stderr: "guide-check: 2 findings" },
			},
		});
		const result = await call({ repo: "/repos/demo", paths: ["AGENTS.md"], message: "docs: guide fix" });
		expect(result.isError).toBe(true);
		expect(body(result).message).toContain("guide-check");
		expect(calls.map((c) => c.argv.join(" "))).toEqual([
			"git status --porcelain -z --untracked-files=all",
			"/usr/local/bin/guide-check repo .",
		]);
		expect(calls[1]!.cwd).toBe("/repos/demo");
	});

	it("commits with the role trailer, reports the hash, and pushes; paths with spaces stay one argument", async () => {
		const { call, calls } = setup({
			results: { "git status": { stdout: "?? docs/my notes.md\u0000" }, "git rev-parse": { stdout: "e1e1e1e2e3e4\n" } },
		});
		const result = await call({ repo: "/repos/demo", paths: ["docs/my notes.md"], message: "docs: fix the guide" });
		expect(result.isError).toBeFalsy();
		expect(body(result)).toMatchObject({ status: "committed", commit: "e1e1e1e2e3e4", pushed: true });
		const [status, add, commit, head, push] = calls.map((c) => ({ cwd: c.cwd, argv: c.argv }));
		expect(status!.argv).toEqual(["git", "status", "--porcelain", "-z", "--untracked-files=all"]);
		expect(add!.argv).toEqual(["git", "add", "--", "docs/my notes.md"]);
		expect(commit!.argv[0]).toBe("git");
		expect(commit!.argv[1]).toBe("commit");
		const message = commit!.argv[3]!;
		expect(message).toContain("docs: fix the guide");
		expect(message).toContain("Role: docs-currency");
		expect(head!.argv).toEqual(["git", "rev-parse", "HEAD"]);
		expect(push!.argv).toEqual(["git", "push"]);
		for (const recorded of calls) expect(recorded.cwd).toBe("/repos/demo");
	});

	it("runs the configured guide checker when a guide is among the paths and proceeds when it passes", async () => {
		const { call, calls } = setup({
			guideCheck: "/usr/local/bin/guide-check",
			results: {
				"git status": { stdout: " M CLAUDE.md\u0000" },
				"guide-check repo": { code: 0, stdout: "guide-check: ok" },
				"git rev-parse": { stdout: "abc123\n" },
			},
		});
		const result = await call({ repo: "/repos/demo", paths: ["CLAUDE.md"], message: "docs: guide" });
		expect(result.isError).toBeFalsy();
		expect(calls.map((c) => c.argv.slice(0, 2).join(" "))).toEqual([
			"git status",
			"/usr/local/bin/guide-check repo",
			"git add",
			"git commit",
			"git rev-parse",
			"git push",
		]);
	});

	it("skips the guide step when no checker is configured", async () => {
		const { call, calls } = setup({
			results: {
				"git status": { stdout: " M CLAUDE.md\u0000" },
				"git rev-parse": { stdout: "abc123\n" },
			},
		});
		const result = await call({ repo: "/repos/demo", paths: ["CLAUDE.md"], message: "docs: guide" });
		expect(result.isError).toBeFalsy();
		expect(calls.some((c) => c.argv[0]?.includes("guide-check"))).toBe(false);
	});

	it("reports a push failure as an error that still names the commit", async () => {
		const { call } = setup({
			results: {
				"git status": { stdout: cleanStatus },
				"git rev-parse": { stdout: "e1e1e1e2e3e4\n" },
				"git push": { code: 128, stderr: "fatal: no upstream" },
			},
		});
		const result = await call(args);
		expect(result.isError).toBe(true);
		expect(body(result).message).toContain("e1e1e1e2e3e4");
		expect(body(result).message).toContain("no upstream");
	});

	it("reports a git failure as an error, not a refusal", async () => {
		const { call } = setup({ results: { "git status": { code: 128, stderr: "fatal: not a git repository" } } });
		const result = await call(args);
		expect(result.isError).toBe(true);
		expect(body(result).status).toBe("error");
		expect(body(result).message).toContain("not a git repository");
	});
});

describe("integration: a temp git repository through the real runner", () => {
	let parent = "";
	let repo = "";
	let bare = "";

	afterAll(async () => {
		if (parent !== "") await rm(parent, { recursive: true, force: true });
	});

	let integrationGuideCheck: string | undefined;
	async function callTool(args: Record<string, unknown>) {
		const extension = docsCommitExtension({
			roleForConversation: () => role(),
			runner: createDocsCommandRunner(),
			...(integrationGuideCheck === undefined ? {} : { guideCheck: integrationGuideCheck }),
		});
		const found = extension.tools?.find((candidate) => candidate.name === "docs_commit");
		if (found === undefined) throw new Error("docs_commit is not registered");
		return found.execute(args as never, { conversationId: conversation } as never, undefined as never);
	}

	it("sets up a temp repository with a bare remote", async () => {
		parent = await mkdtemp(join(tmpdir(), "sr-docsint-"));
		repo = join(parent, "demo");
		bare = join(parent, "demo.git");
		await run("git", ["init", "--bare", "-b", "main", bare]);
		await run("git", ["init", "-b", "main", repo]);
		await run("git", ["-C", repo, "config", "user.email", "role@example.invalid"]);
		await run("git", ["-C", repo, "config", "user.name", "Docs currency"]);
		await writeFile(join(repo, "src.ts"), "export const x = 1;\n");
		await run("git", ["-C", repo, "add", "src.ts"]);
		await run("git", ["-C", repo, "commit", "-m", "seed"]);
		await run("git", ["-C", repo, "remote", "add", "origin", bare]);
		await run("git", ["-C", repo, "push", "-u", "origin", "main"]);
	});

	it("commits and pushes a new doc through real git, with the role trailer", async () => {
		await writeFile(join(repo, "README.md"), "# demo\n");
		const result = await callTool({ repo, paths: ["README.md"], message: "docs: seed the readme" });
		expect(result.isError).toBeFalsy();
		const parsed = body(result);
		expect(parsed.status).toBe("committed");
		expect(String(parsed.commit)).toMatch(/^[0-9a-f]{40}$/);
		const log = await run("git", ["-C", repo, "log", "-1", "--format=%B"]);
		expect(log.stdout).toContain("docs: seed the readme");
		expect(log.stdout).toContain("Role: docs-currency");
		const status = await run("git", ["-C", repo, "status", "--porcelain"]);
		expect(status.stdout).toBe("");
		const pushed = await run("git", ["-C", bare, "log", "-1", "--format=%s"]);
		expect(pushed.stdout).toContain("docs: seed the readme");
	});

	it("refuses to commit while a source file is dirty, and leaves it untouched", async () => {
		await writeFile(join(repo, "src.ts"), "export const x = 2;\n");
		await writeFile(join(repo, "README.md"), "# demo\n\nmore\n");
		const result = await callTool({ repo, paths: ["README.md"], message: "docs: extend" });
		expect(result.isError).toBe(true);
		expect(body(result).message).toContain("src.ts");
		const status = await run("git", ["-C", repo, "status", "--porcelain"]);
		expect(status.stdout).toContain("src.ts");
		// Nothing was staged, even though README.md itself was allowed.
		expect(status.stdout).not.toContain("M  ");
		// Leave the fixture clean for the next test.
		await run("git", ["-C", repo, "checkout", "--", "src.ts", "README.md"]);
	});

	it("refuses a guide commit when the configured guide check fails on the temp repository", async () => {
		// A throwaway checker that always fails, so the integration exercise is self-contained.
		const checker = join(parent, "failing-checker.sh");
		await writeFile(checker, "#!/bin/sh\necho '2 findings' >&2\nexit 1\n", { mode: 0o755 });
		integrationGuideCheck = checker;
		await writeFile(join(repo, "AGENTS.md"), "# not a real guide\n");
		const result = await callTool({ repo, paths: ["AGENTS.md"], message: "docs: guide" });
		expect(result.isError).toBe(true);
		expect(body(result).message).toMatch(/guide check/i);
		const status = await run("git", ["-C", repo, "status", "--porcelain"]);
		expect(status.stdout).toContain("?? AGENTS.md");
	});
});
