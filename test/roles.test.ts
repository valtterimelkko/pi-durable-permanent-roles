import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FALLBACK_DEFAULTS, loadRoles } from "../src/roles.ts";

async function makeRolesRoot(withShared: boolean): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "sr-roles-"));
	if (withShared) {
		await writeFile(
			join(root, "defaults.json"),
			JSON.stringify({ model: { provider: "anthropic", modelId: "claude-sonnet-4-5" }, thinking: "high" }),
			"utf8",
		);
		await writeFile(join(root, "PREAMBLE.md"), "You are a permanent agent of the owner's host.\n\nWrite everything down.", "utf8");
	}
	return root;
}

async function writeRole(
	root: string,
	name: string,
	settings: Record<string, unknown>,
	instructions = "Do the {role} work for {title}. References: {roleDir}. Notes: {notes}.",
): Promise<void> {
	await mkdir(join(root, name), { recursive: true });
	await writeFile(join(root, name, "settings.json"), JSON.stringify(settings, undefined, "\t"), "utf8");
	await writeFile(join(root, name, "instructions.md"), instructions, "utf8");
}

const VALID = {
	enabled: true,
	title: "Runtime keeper",
	boardName: "role-runtime-keeper",
	schedule: [{ at: "07:30", days: "weekdays" }],
	cwd: "/root",
	tools: ["coding"],
};

describe("loadRoles", () => {
	const roots: string[] = [];
	/** A root with defaults.json and PREAMBLE.md, like the repository's roles/ tree. */
	async function fresh(): Promise<string> {
		const root = await makeRolesRoot(true);
		roots.push(root);
		return root;
	}
	/** A bare root without the shared files. */
	async function bare(): Promise<string> {
		const root = await makeRolesRoot(false);
		roots.push(root);
		return root;
	}
	afterAll(async () => {
		await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
	});

	it("loads a valid role: settings, effective model from defaults, composed instructions, notes dir", async () => {
		const root = await fresh();
		await writeRole(root, "runtime-keeper", VALID);
		const { enabled, disabled, problems } = await loadRoles({ rolesRoot: root, stateDir: "/tmp/sr-state" });
		expect(problems).toEqual([]);
		expect(disabled).toEqual([]);
		expect(enabled).toHaveLength(1);
		const role = enabled[0]!;
		expect(role.name).toBe("runtime-keeper");
		expect(role.dir).toBe(join(root, "runtime-keeper"));
		expect(role.settings).toEqual(VALID);
		expect(role.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
		expect(role.thinking).toBe("high");
		expect(role.notesDir).toBe("/tmp/sr-state/roles/runtime-keeper/notes");
		// {roleDir} is filled with the role's folder in the repository.
		expect(role.instructions).toContain(join(root, "runtime-keeper"));
		expect(role.instructions).not.toContain("{roleDir}");
		expect(role.instructions).toContain("Do the runtime-keeper work for Runtime keeper.");
		expect(role.instructions).toContain("/tmp/sr-state/roles/runtime-keeper/notes");
		expect(role.instructions).toMatch(/permanent agent/); // the preamble is part of the prompt
	});

	it("a settings model override wins over defaults.json", async () => {
		const root = await fresh();
		await writeRole(root, "a", { ...VALID, model: { provider: "faux", modelId: "m-2" }, thinking: "low" });
		const { enabled } = await loadRoles({ rolesRoot: root, stateDir: "/tmp/sr-state" });
		expect(enabled[0]!.model).toEqual({ provider: "faux", modelId: "m-2" });
		expect(enabled[0]!.thinking).toBe("low");
	});

	it("splits enabled and disabled roles", async () => {
		const root = await fresh();
		await writeRole(root, "on", VALID);
		await writeRole(root, "off", { ...VALID, enabled: false, boardName: "role-off" });
		const { enabled, disabled } = await loadRoles({ rolesRoot: root, stateDir: "/tmp/sr-state" });
		expect(enabled.map((role) => role.name)).toEqual(["on"]);
		expect(disabled.map((role) => role.name)).toEqual(["off"]);
	});

	it("reports and skips a bad role folder; a duplicate boardName is refused; the rest load", async () => {
		const root = await fresh();
		await writeRole(root, "good", VALID);
		await writeRole(root, "bad-time", { ...VALID, boardName: "role-bad-time", schedule: [{ at: "7:30", days: "weekdays" }] });
		await writeRole(root, "bad-days", { ...VALID, boardName: "role-bad-days", schedule: [{ at: "07:30", days: "sometimes" }] });
		await writeRole(root, "bad-dupe", { ...VALID, boardName: "role-good-none", title: "" });
		await mkdir(join(root, "no-instructions"));
		await writeFile(join(root, "no-instructions", "settings.json"), JSON.stringify(VALID), "utf8");
		const { enabled, problems } = await loadRoles({ rolesRoot: root, stateDir: "/tmp/sr-state" });
		expect(enabled.map((role) => role.name)).toEqual(["good"]);
		expect(problems).toHaveLength(4);
		expect(problems.join("\n")).toContain("bad-time");
		expect(problems.join("\n")).toContain("bad-days");
		expect(problems.join("\n")).toContain("bad-dupe");
		expect(problems.join("\n")).toContain("no-instructions");
	});

	it("limits must be a list drawn from the known limits; docs-only-commits and read-only-messaging are kept", async () => {
		const root = await fresh();
		await writeRole(root, "limited", { ...VALID, limits: ["docs-only-commits"] });
		await writeRole(root, "messenger", { ...VALID, boardName: "role-messenger", limits: ["read-only-messaging"], readOnlyRules: "never-run.json" });
		await writeRole(root, "bad-limit", { ...VALID, boardName: "role-bad-limit", limits: ["do-anything"] });
		await writeRole(root, "bad-shape", { ...VALID, boardName: "role-bad-shape", limits: "docs-only-commits" });
		const { enabled, problems } = await loadRoles({ rolesRoot: root, stateDir: "/tmp/sr-state" });
		expect(enabled.map((role) => role.name)).toEqual(["limited", "messenger"]);
		expect(enabled[0]!.settings.limits).toEqual(["docs-only-commits"]);
		expect(enabled[1]!.settings.limits).toEqual(["read-only-messaging"]);
		expect(problems.join("\n")).toContain("bad-limit");
		expect(problems.join("\n")).toContain("bad-shape");
	});

	it("duplicate boardNames across roles are reported", async () => {
		const root = await fresh();
		await writeRole(root, "one", VALID);
		await writeRole(root, "two", VALID);
		const { enabled, problems } = await loadRoles({ rolesRoot: root, stateDir: "/tmp/sr-state" });
		expect(enabled.map((role) => role.name)).toEqual(["one"]);
		expect(problems.join("\n")).toContain("boardName");
	});

	it("an unknown tool group or thinking level is a problem, not a crash", async () => {
		const root = await fresh();
		await writeRole(root, "bad-tools", { ...VALID, tools: ["coding", "shell"] });
		await writeRole(root, "bad-thinking", { ...VALID, boardName: "role-bt", thinking: "extreme" });
		const { problems } = await loadRoles({ rolesRoot: root, stateDir: "/tmp/sr-state" });
		expect(problems).toHaveLength(2);
	});

	it("watches must be well-formed: a list of {name, command, expect, everySeconds ≥ 30}", async () => {
		const root = await fresh();
		const watch = { name: "tmp-mode", command: "stat -c %a /tmp", expect: "1777", everySeconds: 60 };
		await writeRole(root, "watched", { ...VALID, boardName: "role-watched", watches: [watch] });
		await writeRole(root, "bad-watches-shape", { ...VALID, boardName: "role-bws", watches: "stat -c %a /tmp" });
		await writeRole(root, "bad-watch-seconds", { ...VALID, boardName: "role-bwsec", watches: [{ ...watch, everySeconds: 10 }] });
		await writeRole(root, "bad-watch-missing", { ...VALID, boardName: "role-bwmiss", watches: [{ name: "t", command: "x" }] });
		await writeRole(root, "bad-watch-name", { ...VALID, boardName: "role-bwname", watches: [{ ...watch, name: "" }] });
		const { enabled, problems } = await loadRoles({ rolesRoot: root, stateDir: "/tmp/sr-state" });
		expect(enabled.map((role) => role.name)).toEqual(["watched"]);
		expect(enabled[0]!.settings.watches).toEqual([watch]);
		expect(problems.join("\n")).toContain("bad-watches-shape");
		expect(problems.join("\n")).toContain("bad-watch-seconds");
		expect(problems.join("\n")).toContain("bad-watch-missing");
		expect(problems.join("\n")).toContain("bad-watch-name");
	});

	it("a missing defaults.json falls back to the plan default and is reported", async () => {
		const root = await bare();
		await writeRole(root, "solo", VALID);
		const { enabled, problems } = await loadRoles({ rolesRoot: root, stateDir: "/tmp/sr-state" });
		expect(problems.join("\n")).toContain("defaults.json");
		expect(enabled[0]!.model).toEqual(FALLBACK_DEFAULTS.model);
	});

	it("appends a generated Your files section: every file as an absolute path, one per line, no settings.json", async () => {
		const root = await fresh();
		await writeRole(root, "keeper", VALID);
		await writeFile(join(root, "keeper", "RUNTIMES.md"), "The runtimes.\n", "utf8");
		await mkdir(join(root, "keeper", "archive"));
		await writeFile(join(root, "keeper", "archive", "old.md"), "old\n", "utf8");
		const { enabled, problems } = await loadRoles({ rolesRoot: root, stateDir: "/tmp/sr-state" });
		expect(problems).toEqual([]);
		const prompt = enabled[0]!.instructions;
		// The section is appended after the role's own instructions.
		expect(prompt.indexOf("## Your files")).toBeGreaterThan(prompt.indexOf("Do the keeper work"));
		expect(prompt).toContain("Open these by these paths; never search the disk for them.");
		// One absolute path per line: the folder's files, settings.json and folders excepted, then the notes folder.
		const section = prompt.slice(prompt.indexOf("## Your files"));
		const listed = section.split("\n").filter((line) => line.startsWith("/"));
		expect(listed).toEqual([
			join(root, "keeper", "RUNTIMES.md"),
			join(root, "keeper", "instructions.md"),
			"/tmp/sr-state/roles/keeper/notes — your notes folder",
		]);
		expect(prompt).not.toContain(join(root, "keeper", "settings.json"));
		expect(prompt).not.toContain(join(root, "keeper", "archive"));
	});

	it("the real runtime-keeper prompt lists its own reference files the same way", async () => {
		const repoRoles = new URL("../roles/", import.meta.url).pathname;
		const { disabled, problems } = await loadRoles({ rolesRoot: repoRoles, stateDir: "/tmp/sr-state" });
		expect(problems).toEqual([]);
		const keeper = disabled.find((role) => role.name === "runtime-keeper");
		expect(keeper, "runtime-keeper is among the loaded roles").toBeDefined();
		expect(keeper!.instructions).toContain("## Your files");
		expect(keeper!.instructions).toContain(join(repoRoles, "runtime-keeper", "RUNTIMES.md"));
		expect(keeper!.instructions).toContain("/tmp/sr-state/roles/runtime-keeper/notes");
		expect(keeper!.instructions).toContain("never search the disk for them");
	});

	it("reportCounts fills {counts} in the prompt; without it the role names its own", async () => {
		const root = await fresh();
		await writeRole(root, "counted", { ...VALID, boardName: "role-counted", reportCounts: ["judged", "alerted"] }, "Counts: {counts}.");
		await writeRole(root, "uncounted", { ...VALID, boardName: "role-uncounted" }, "Counts: {counts}.");
		const { enabled, problems } = await loadRoles({ rolesRoot: root, stateDir: "/tmp/sr-state" });
		expect(problems).toEqual([]);
		expect(enabled.find((role) => role.name === "counted")!.instructions).toContain("Counts: `judged`, `alerted`.");
		expect(enabled.find((role) => role.name === "uncounted")!.instructions).toContain(
			"Counts: names of your own choosing, the same every run.",
		);
	});

	it("reportCounts must be a list of short snake_case names", async () => {
		const root = await fresh();
		await writeRole(root, "bad-counts", { ...VALID, boardName: "role-bad-counts", reportCounts: ["ok", "Not OK"] });
		await writeRole(root, "not-a-list", { ...VALID, boardName: "role-not-a-list", reportCounts: "judged" });
		const { enabled, problems } = await loadRoles({ rolesRoot: root, stateDir: "/tmp/sr-state" });
		expect(enabled).toEqual([]);
		expect(problems.join("\n")).toMatch(/bad-counts.*reportCounts/);
		expect(problems.join("\n")).toMatch(/not-a-list.*reportCounts/);
	});

	it("everyRunCounts must name counts that reportCounts declares", async () => {
		const root = await fresh();
		await writeRole(root, "good-every", { ...VALID, boardName: "role-good-every", reportCounts: ["channels_read"], everyRunCounts: ["channels_read"] });
		await writeRole(root, "bad-every", { ...VALID, boardName: "role-bad-every", reportCounts: ["judged"], everyRunCounts: ["channels_read"] });
		const { enabled, problems } = await loadRoles({ rolesRoot: root, stateDir: "/tmp/sr-state" });
		expect(enabled.map((role) => role.name)).toEqual(["good-every"]);
		expect(problems.join("\n")).toMatch(/bad-every.*everyRunCounts/);
	});

	it("every real enabled role names its report counts, and its prompt asks for report_run with them", async () => {
		const repoRoles = new URL("../roles/", import.meta.url).pathname;
		const { enabled } = await loadRoles({ rolesRoot: repoRoles, stateDir: "/tmp/sr-state" });
		for (const role of enabled) {
			expect(role.settings.reportCounts?.length, role.name).toBeGreaterThan(0);
			expect(role.instructions, role.name).toContain("report_run");
			expect(role.instructions, role.name).toContain(`\`${role.settings.reportCounts![0]}\``);
			expect(role.instructions, role.name).toContain("RULE-PROPOSALS.md");
			expect(role.instructions, role.name).not.toContain("{counts}");
		}
	});

	it("the repository's own roles tree loads: every role shipped disabled, no problems", async () => {
		const repoRoles = new URL("../roles/", import.meta.url).pathname;
		const { enabled, disabled, problems } = await loadRoles({ rolesRoot: repoRoles, stateDir: "/tmp/sr-state" });
		expect(problems).toEqual([]);
		expect(enabled).toEqual([]);
		expect(disabled.map((role) => role.name).sort()).toEqual([
			"docs-currency",
			"example",
			"personal-messages",
			"runtime-keeper",
			"system-updates",
			"work-messages",
		]);
		expect(disabled.find((role) => role.name === "example")!.settings.title).toBe("Example role");
	});
});
