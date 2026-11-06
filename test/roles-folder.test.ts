/** The repository's real roles/ folder loads, generalised: five roles and the disabled example. */
import { describe, expect, it } from "vitest";
import { loadRoles } from "../src/roles.ts";

const repoRoles = new URL("../roles/", import.meta.url).pathname;

describe("the real roles/ folder", () => {
	it("loads with no problems", async () => {
		const { problems } = await loadRoles({ rolesRoot: repoRoles, stateDir: "/tmp/sr-state" });
		expect(problems).toEqual([]);
	});

	// Safe defaults: every shipped role is disabled, so a fresh install runs nothing.
	it("ships every role disabled", async () => {
		const { enabled, disabled } = await loadRoles({ rolesRoot: repoRoles, stateDir: "/tmp/sr-state" });
		expect(enabled).toEqual([]);
		expect(disabled.map((role) => role.name).sort()).toEqual([
			"docs-currency",
			"example",
			"personal-messages",
			"runtime-keeper",
			"system-updates",
			"work-messages",
		]);
	});

	it("loads runtime-keeper valid (shipped disabled)", async () => {
		const { disabled } = await loadRoles({ rolesRoot: repoRoles, stateDir: "/tmp/sr-state" });
		const keeper = disabled.find((role) => role.name === "runtime-keeper");
		expect(keeper, "runtime-keeper is among the loaded roles").toBeDefined();
		expect(keeper!.settings.enabled).toBe(false);
		expect(keeper!.settings.title).toBe("Runtime keeper");
		expect(keeper!.settings.boardName).toBe("role-runtime-keeper");
		expect(keeper!.settings.schedule).toEqual([{ at: "03:00", days: "daily" }]);
		expect(keeper!.settings.tools).toEqual(["coding", "integrations", "notify"]);
		expect(keeper!.settings.cwd).toBe("/root");
		// The effective model comes from roles/defaults.json (no override in the role's settings).
		expect(keeper!.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
		expect(keeper!.thinking).toBe("high");
		// The prompt is the preamble and the role's own instructions, with the placeholders filled.
		expect(keeper!.instructions).toContain("You are **Runtime keeper**");
		expect(keeper!.instructions).toContain("## Your job");
		expect(keeper!.instructions).not.toContain("{role}");
		// The preamble names where the reference files and the notes live.
		expect(keeper!.instructions).toContain("Your reference files are in");
		expect(keeper!.instructions).toContain("/roles/runtime-keeper");
	});

	it("loads docs-currency with the docs-only limit, and its targets file exists", async () => {
		const { disabled } = await loadRoles({ rolesRoot: repoRoles, stateDir: "/tmp/sr-state" });
		const docs = disabled.find((role) => role.name === "docs-currency");
		expect(docs).toBeDefined();
		expect(docs!.settings.limits).toEqual(["docs-only-commits"]);
		expect(docs!.settings.schedule).toEqual([{ at: "22:00", days: "daily" }]);
	});

	it("the example role stays disabled, and carries no private wiring", async () => {
		const { enabled, disabled } = await loadRoles({ rolesRoot: repoRoles, stateDir: "/tmp/sr-state" });
		expect(enabled.find((role) => role.name === "example")).toBeUndefined();
		const example = disabled.find((role) => role.name === "example");
		expect(example).toBeDefined();
		expect(example!.settings.enabled).toBe(false);
	});

	it("no role carries private settings or the old tool-group name", async () => {
		const { enabled, disabled } = await loadRoles({ rolesRoot: repoRoles, stateDir: "/tmp/sr-state" });
		for (const role of [...enabled, ...disabled]) {
			const raw = JSON.stringify(role.settings);
			expect(raw.includes("captureProject"), `${role.name} has no captureProject`).toBe(false);
			for (const tool of role.settings.tools) {
				expect(["coding", "integrations", "notify"], `${role.name} uses only the known tool groups`).toContain(tool);
			}
		}
	});
});
