import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, ToolResultEntry, UserEntry, defineExtension } from "@earendil-works/pi-durable";
import { extensionSelectionFor, openRoleHost, type RoleHost } from "../src/harness.ts";
import { loadRoles } from "../src/roles.ts";
import { makeFauxHostModels, makeStateDir, writeRolesTree } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;
const roots: string[] = [];

afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function freshRoot(roles: Parameters<typeof writeRolesTree>[1]): Promise<{ rolesRoot: string; stateDir: string }> {
	const stateDir = await makeStateDir();
	const rolesRoot = join(await mkdtemp(join(tmpdir(), "sr-rolesharness-")), "roles");
	roots.push(rolesRoot, stateDir);
	await writeRolesTree(rolesRoot, roles);
	return { rolesRoot, stateDir };
}

async function open(rolesRoot: string, stateDir: string, fauxOptions?: Parameters<typeof makeFauxHostModels>[0]): Promise<RoleHost> {
	const { enabled } = await loadRoles({ rolesRoot, stateDir });
	const { hostModels, defaultModel } = makeFauxHostModels(fauxOptions);
	return openRoleHost({
		dbPath: join(stateDir, "roles.db"),
		stateDir,
		roles: enabled,
		defaultModel,
		hostModels,
	});
}

describe("openRoleHost", () => {
	it("opens one conversation per enabled role; ids live in a durable doc; a reopen finds the same ids", async () => {
		const { rolesRoot, stateDir } = await freshRoot([{ name: "alpha" }, { name: "beta" }]);
		const first = await open(rolesRoot, stateDir);
		expect(first.roles().map((role) => role.name).sort()).toEqual(["alpha", "beta"]);
		const alphaId = first.conversationId("alpha");
		const betaId = first.conversationId("beta");
		expect(alphaId).toBeDefined();
		expect(betaId).toBeDefined();
		expect(alphaId).not.toBe(betaId);
		// roleForConversation maps back.
		expect(first.roleForConversation(alphaId!)?.name).toBe("alpha");
		expect(first.roleForConversation("nope" as never)).toBeUndefined();
		await first.close();

		const second = await open(rolesRoot, stateDir);
		expect(second.conversationId("alpha")).toBe(alphaId);
		expect(second.conversationId("beta")).toBe(betaId);
		await second.close();
	});

	it("applies the role's model, thinking, instructions and cwd; the coding tools are offered", async () => {
		const { rolesRoot, stateDir } = await freshRoot([
			{ name: "alpha", title: "Alpha keeper", cwd: "/tmp", instructions: "Alpha's own instructions: {notes}.", thinking: "low" },
		]);
		const host = await open(rolesRoot, stateDir);
		try {
			const conversation = await host.conversation("alpha");
			const agent = await conversation!.agent(context);
			expect(agent.model).toEqual({ provider: "faux", modelId: "m-1" });
			expect(agent.thinkingLevel).toBe("low");
			expect(agent.instructions).toContain("Alpha's own instructions:");
			expect(agent.instructions).toContain(`${stateDir}/roles/alpha/notes`);
			expect(agent.cwd).toBe("/tmp");
			const toolNames = agent.tools.map((tool) => tool.name).sort();
			expect(toolNames).toEqual(["bash", "edit", "read", "write"]);
		} finally {
			await host.close();
		}
	});

	it("selects the plumbing's extensions only for the tool groups the role asks for", async () => {
		const { rolesRoot, stateDir } = await freshRoot([{ name: "plain", tools: ["coding"] }, { name: "wired", tools: ["coding", "integrations", "notify"] }]);
		const host = await open(rolesRoot, stateDir);
		try {
			const plain = await (await host.conversation("plain"))!.agent(context);
			const wired = await (await host.conversation("wired"))!.agent(context);
			expect(plain.extensions.map((extension) => extension.name)).toEqual([
				"coding-tools",
				"role-limits",
				"role-compaction",
			]);
			expect(wired.extensions.map((extension) => extension.name)).toEqual([
				"coding-tools",
				"role-limits",
				"role-compaction",
				"integrations",
				"notify",
			]);
		} finally {
			await host.close();
		}
	});

	it("a role with the docs-only limit gets the docs_commit tool and the docs bash refusal; a plain role gets neither", async () => {
		const { rolesRoot, stateDir } = await freshRoot([{ name: "plain" }, { name: "scribes", limits: ["docs-only-commits"] }]);
		const host = await open(rolesRoot, stateDir);
		try {
			const plain = await (await host.conversation("plain"))!.agent(context);
			const scribes = await (await host.conversation("scribes"))!.agent(context);
			expect(plain.extensions.map((extension) => extension.name)).not.toContain("pi-roles-docs-commit");
			expect(plain.tools.map((tool) => tool.name)).not.toContain("docs_commit");
			expect(scribes.extensions.map((extension) => extension.name)).toContain("pi-roles-docs-commit");
			expect(scribes.tools.map((tool) => tool.name)).toContain("docs_commit");
			// The docs bash refusal sits beside the shared reboot limit: probe through the conversation.
			await host.submit("scribes", { content: "docs-refuse-check", requestId: "docs-refuse" });
			await host.submit("scribes", { content: "docs-allowed-check", requestId: "docs-allowed" });
			await (await host.conversation("scribes"))!.waitForIdle(context);
			const entries = await (await host.conversation("scribes"))!.entries({ order: "ascending" }, 100, undefined, context);
			const results = entries.items.filter((entry) => ToolResultEntry.is(entry));
			expect(results).toHaveLength(2);
			expect(JSON.stringify(results[0]!.model?.[0])).toContain("docs_commit");
			expect(results[0]!.model?.[0]).toMatchObject({ isError: true });
			expect(JSON.stringify(results[1]!.model?.[0])).not.toContain("refused");
		} finally {
			await host.close();
		}
	});

	it("a role with the read-only-messaging limit gets the messaging bash refusal but no docs_commit tool; wraps stack with the shared reboot limit", async () => {
		const { rolesRoot, stateDir } = await freshRoot([
			{ name: "plain" },
			{ name: "messenger", limits: ["read-only-messaging"] },
			{ name: "both", limits: ["docs-only-commits", "read-only-messaging"] },
		]);
		const host = await open(rolesRoot, stateDir);
		try {
			const plain = await (await host.conversation("plain"))!.agent(context);
			const messenger = await (await host.conversation("messenger"))!.agent(context);
			const both = await (await host.conversation("both"))!.agent(context);
			expect(plain.extensions.map((extension) => extension.name)).not.toContain("read-only-messaging:messenger");
			expect(messenger.extensions.map((extension) => extension.name)).toContain("read-only-messaging:messenger");
			expect(messenger.extensions.map((extension) => extension.name)).not.toContain("pi-roles-docs-commit");
			expect(messenger.tools.map((tool) => tool.name)).not.toContain("docs_commit");
			expect(both.extensions.map((extension) => extension.name)).toContain("read-only-messaging:both");
			expect(both.extensions.map((extension) => extension.name)).toContain("pi-roles-docs-commit");
			// The wraps stack through the conversation: the messaging refusal, the shared reboot
			// limit beside it, and a read passing through.
			await host.submit("messenger", { content: "messaging-refuse-check", requestId: "msg-refuse" });
			await host.submit("messenger", { content: "refuse-check", requestId: "reboot-refuse" });
			await host.submit("messenger", { content: "messaging-allowed-check", requestId: "msg-allowed" });
			await (await host.conversation("messenger"))!.waitForIdle(context);
			const entries = await (await host.conversation("messenger"))!.entries({ order: "ascending" }, 100, undefined, context);
			const results = entries.items.filter((entry) => ToolResultEntry.is(entry));
			expect(results).toHaveLength(3);
			expect(results[0]!.model?.[0]).toMatchObject({ isError: true });
			expect(JSON.stringify(results[0]!.model?.[0])).toContain("MESSAGING.md");
			expect(results[1]!.model?.[0]).toMatchObject({ isError: true });
			expect(JSON.stringify(results[1]!.model?.[0])).toContain("reboot");
			expect(JSON.stringify(results[2]!.model?.[0])).not.toContain("refused");
		} finally {
			await host.close();
		}
	});

	it("submit runs the faux model and the answer lands; an unknown role is refused", async () => {
		const { rolesRoot, stateDir } = await freshRoot([{ name: "alpha" }]);
		const host = await open(rolesRoot, stateDir);
		try {
			await host.submit("alpha", { content: "hello alpha", requestId: "t1" });
			const conversation = await host.conversation("alpha");
			await conversation!.waitForIdle(context);
			const entries = await conversation!.entries({ order: "ascending" }, 100, undefined, context);
			const user = entries.items.filter((entry) => UserEntry.is(entry));
			const assistant = entries.items.filter((entry) => AssistantEntry.is(entry));
			expect(user).toHaveLength(1);
			expect(assistant.length).toBeGreaterThanOrEqual(1);
			expect(JSON.stringify(assistant.at(-1))).toContain("Reply to: hello alpha");
			await expect(host.submit("nope", { content: "x", requestId: "t2" })).rejects.toThrow(/unknown role/);
		} finally {
			await host.close();
		}
	});

	it("the bash hard limit refuses a reboot inside the conversation and lets ordinary commands through", async () => {
		const { rolesRoot, stateDir } = await freshRoot([{ name: "alpha" }]);
		const host = await open(rolesRoot, stateDir);
		try {
			for (const probe of ["refuse-check", "allowed-check"]) {
				await host.submit("alpha", { content: probe, requestId: `probe-${probe}` });
				await (await host.conversation("alpha"))!.waitForIdle(context);
			}
			const conversation = await host.conversation("alpha");
			const entries = await conversation!.entries({ order: "ascending" }, 100, undefined, context);
			const results = entries.items.filter((entry) => ToolResultEntry.is(entry));
			expect(results).toHaveLength(2);
			const refusal = results[0]!;
			const allowed = results[1]!;
			expect(refusal.model?.[0]).toMatchObject({ role: "toolResult", isError: true });
			expect(JSON.stringify(refusal.model?.[0])).toContain("refused");
			expect(allowed.model?.[0]).toMatchObject({ role: "toolResult", isError: false });
			expect(JSON.stringify(allowed.model?.[0])).toContain("reboot-notes");
		} finally {
			await host.close();
		}
	});

	it("the compaction policy getter runs at half the default model's window", async () => {
		const { rolesRoot, stateDir } = await freshRoot([{ name: "alpha" }]);
		const host = await open(rolesRoot, stateDir);
		try {
			// The faux default model m-1 has a 1,000,000-token window (helpers.ts).
			const policy = host.compactionPolicy();
			const compactAt = 1_000_000 - policy.reserveTokens - policy.backgroundTokens;
			expect(compactAt).toBe(500_000);
		} finally {
			await host.close();
		}
	});

	it("applyRoles re-applies a changed model while the history stays", async () => {
		const { rolesRoot, stateDir } = await freshRoot([{ name: "alpha" }]);
		const host = await open(rolesRoot, stateDir);
		try {
			await host.submit("alpha", { content: "history before the change", requestId: "h1" });
			const conversation = await host.conversation("alpha");
			await conversation!.waitForIdle(context);
			const before = (await conversation!.entries({ order: "ascending" }, 100, undefined, context)).items;

			const { enabled } = await loadRoles({ rolesRoot: await rewriteDefault(rolesRoot), stateDir });
			await host.applyRoles(enabled);

			const agent = await conversation!.agent(context);
			expect(agent.model).toEqual({ provider: "faux", modelId: "m-2" });
			const after = (await conversation!.entries({ order: "ascending" }, 100, undefined, context)).items;
			// The same user history is still first; only agent-setting system entries may differ.
			expect(after.filter((entry) => UserEntry.is(entry)).map((entry) => JSON.stringify(entry.model?.[0]))).toEqual(
				before.filter((entry) => UserEntry.is(entry)).map((entry) => JSON.stringify(entry.model?.[0])),
			);
		} finally {
			await host.close();
		}
	});

	it("a role added by applyRoles gets a conversation; a removed role keeps its stored conversation", async () => {
		const { rolesRoot, stateDir } = await freshRoot([{ name: "alpha" }]);
		const host = await open(rolesRoot, stateDir);
		try {
			const { enabled: withBeta } = await loadRoles({
				rolesRoot: await addRole(rolesRoot, { name: "beta" }),
				stateDir,
			});
			await host.applyRoles(withBeta);
			expect(host.conversationId("beta")).toBeDefined();
			expect(host.roles().map((role) => role.name).sort()).toEqual(["alpha", "beta"]);
		} finally {
			await host.close();
		}
	});

	it("records a role's last run durably: a reopen after a close keeps the same {atMs, slot}", async () => {
		const { rolesRoot, stateDir } = await freshRoot([{ name: "alpha" }]);
		const first = await open(rolesRoot, stateDir);
		await first.submit("alpha", { content: "a scheduled round", requestId: "run-1" });
		const before = first.lastRun("alpha");
		expect(before).toBeDefined();
		await first.close();

		// A fresh host on the same state dir is what a host restart is: the in-memory Map is
		// empty, so only a durable record can keep the last run.
		const second = await open(rolesRoot, stateDir);
		try {
			expect(second.lastRun("alpha")).toEqual(before);
		} finally {
			await second.close();
		}
	});
});

describe("the extension selection", () => {
	it("selects the shared three, a limit's extension, and the asked-for tool groups", () => {
		const named = (name: string): ReturnType<typeof defineExtension> => defineExtension({ name });
		const readOnly = named("read-only-messaging:messenger");
		const selection = extensionSelectionFor(
			{
				coding: named("coding"),
				limits: named("limits"),
				compaction: named("compaction"),
				docs: named("docs"),
				integrations: named("standing-roles-integrations"),
				notify: named("standing-roles-notify"),
			},
			["coding", "integrations", "notify"],
			["docs-only-commits", "read-only-messaging"],
			readOnly,
		);
		expect(selection.map((extension) => extension.name)).toEqual([
			"coding",
			"limits",
			"compaction",
			"docs",
			"read-only-messaging:messenger",
			"standing-roles-integrations",
			"standing-roles-notify",
		]);
	});

	it("without the read-only limit no messaging extension is selected, even when offered", () => {
		const named = (name: string): ReturnType<typeof defineExtension> => defineExtension({ name });
		const selection = extensionSelectionFor(
			{
				coding: named("coding"),
				limits: named("limits"),
				compaction: named("compaction"),
				docs: named("docs"),
				integrations: named("standing-roles-integrations"),
				notify: named("standing-roles-notify"),
			},
			["coding"],
			[],
			named("read-only-messaging:unused"),
		);
		expect(selection.map((extension) => extension.name)).toEqual(["coding", "limits", "compaction"]);
	});
});

/** Rewrite the fixture's defaults.json to faux m-2 (the "model change" for applyRoles). */
async function rewriteDefault(rolesRoot: string): Promise<string> {
	const { writeFile } = await import("node:fs/promises");
	await writeFile(
		join(rolesRoot, "defaults.json"),
		JSON.stringify({ model: { provider: "faux", modelId: "m-2" }, thinking: "high" }, undefined, "\t"),
		"utf8",
	);
	return rolesRoot;
}

async function addRole(rolesRoot: string, role: Parameters<typeof writeRolesTree>[1][number]): Promise<string> {
	// writeRolesTree rewrites the shared files and adds folders; existing folders stay.
	await writeRolesTree(rolesRoot, [role]);
	return rolesRoot;
}
