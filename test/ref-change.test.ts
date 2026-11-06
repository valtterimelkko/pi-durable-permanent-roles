/**
 * Changed reference files reach the role: on start and reload the host hashes
 * each role's reference files — every file in the role's folder except `settings.json` and `instructions.md`, plus
 * the role's outside `referenceFiles` (a missing file hashes as "missing") — and submits one input naming what
 * changed, requestId keyed by the hashes so the same change is delivered once, also across a crash. On the very
 * first sight (no stored hashes) the host stores silently; a role named in STANDING_ROLES_REFCHANGE_INITIAL gets
 * the input on first sight. Tests run the real host on temp dirs with the faux provider; no real model, no live
 * state directory.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { UserEntry } from "@earendil-works/pi-durable";
import { openRoleHost, type RoleHost } from "../src/harness.ts";
import { loadRoles } from "../src/roles.ts";
import { readRunsFile } from "../src/run-report.ts";
import { parseSettings } from "../src/roles.ts";
import type { RoleDefinition } from "../src/types.ts";
import {
	REFCHANGE_ENV,
	changedPaths,
	initialRefChangeRoles,
	refChangeMessage,
	refChangeRequestId,
	referenceEntriesFor,
} from "../src/ref-files.ts";
import { makeFauxHostModels, makeStateDir, writeRolesTree } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

function makeRole(dir: string, referenceFiles?: string[]): RoleDefinition {
	return {
		name: "alpha",
		dir,
		settings: {
			enabled: true,
			title: "Alpha",
			boardName: "role-alpha",
			schedule: [],
			cwd: dir,
			tools: ["coding"],
			...(referenceFiles !== undefined ? { referenceFiles } : {}),
		},
		model: { provider: "faux", modelId: "m-1" },
		thinking: "high",
		instructions: "",
		notesDir: "/tmp/notes",
	};
}

describe("referenceEntriesFor (the hash set)", () => {
	it("hashes every role-folder file except settings.json and instructions.md, plus the outside referenceFiles; a missing file hashes as missing", async () => {
		const roleDir = tempDir("refc-role-");
		const outside = tempDir("refc-out-");
		mkdirSync(join(roleDir, "refs"), { recursive: true });
		writeFileSync(join(roleDir, "RUNBOOK.md"), "runbook one");
		writeFileSync(join(roleDir, "instructions.md"), "instructions");
		writeFileSync(join(roleDir, "settings.json"), "{}");
		writeFileSync(join(roleDir, "refs", "GUIDE.md"), "guide");
		const intent = join(outside, "INTENT.md");
		writeFileSync(intent, "intent");
		const gone = join(outside, "GONE.md");

		const entries = await referenceEntriesFor(makeRole(roleDir, [intent, gone]));
		const byPath = new Map(entries.map((entry) => [entry.path, entry.hash]));
		expect([...byPath.keys()].sort()).toEqual(["RUNBOOK.md", "refs/GUIDE.md", gone, intent].sort());
		expect(byPath.get("RUNBOOK.md")).toBe(sha256("runbook one"));
		expect(byPath.get("refs/GUIDE.md")).toBe(sha256("guide"));
		expect(byPath.get(intent)).toBe(sha256("intent"));
		expect(byPath.get(gone)).toBe("missing");
	});

	it("a role without referenceFiles hashes only its folder", async () => {
		const roleDir = tempDir("refc-role-");
		writeFileSync(join(roleDir, "RUNBOOK.md"), "runbook");
		writeFileSync(join(roleDir, "instructions.md"), "instructions");
		writeFileSync(join(roleDir, "settings.json"), "{}");
		const entries = await referenceEntriesFor(makeRole(roleDir));
		expect(entries.map((entry) => entry.path)).toEqual(["RUNBOOK.md"]);
	});
});

describe("the change diff, requestId and message", () => {
	it("changedPaths reports changed, added and removed paths, sorted", () => {
		const stored = { "RUNBOOK.md": "a", "OLD.md": "b", "SAME.md": "c" };
		const current = [
			{ path: "SAME.md", hash: "c" },
			{ path: "RUNBOOK.md", hash: "a2" },
			{ path: "NEW.md", hash: "d" },
		];
		expect(changedPaths(stored, current)).toEqual(["NEW.md", "OLD.md", "RUNBOOK.md"]);
		expect(changedPaths({ "RUNBOOK.md": "a" }, [{ path: "RUNBOOK.md", hash: "a" }])).toEqual([]);
	});

	it("the requestId is stable for the same hashes, carries the role and 16 hex, and moves with any change", () => {
		const one = [{ path: "RUNBOOK.md", hash: "a" }, { path: "/x/INTENT.md", hash: "b" }];
		const again = [{ path: "RUNBOOK.md", hash: "a" }, { path: "/x/INTENT.md", hash: "b" }];
		const changed = [{ path: "RUNBOOK.md", hash: "a2" }, { path: "/x/INTENT.md", hash: "b" }];
		expect(refChangeRequestId("alpha", one)).toBe(refChangeRequestId("alpha", again));
		expect(refChangeRequestId("alpha", one)).toMatch(/^refchange:alpha:[0-9a-f]{16}$/);
		expect(refChangeRequestId("alpha", one)).not.toBe(refChangeRequestId("alpha", changed));
		expect(refChangeRequestId("alpha", one)).not.toBe(refChangeRequestId("beta", one));
	});

	it("the message is the plan's exact wording", () => {
		expect(refChangeMessage(["RUNBOOK.md", "/srv/demo/INTENT.md"])).toBe(
			"Your reference files changed since you last read them: RUNBOOK.md, /srv/demo/INTENT.md. Reread them before your next step.",
		);
	});

	it("the initial roles come from the env list, empty by default", () => {
		const previous = process.env[REFCHANGE_ENV];
		try {
			delete process.env[REFCHANGE_ENV];
			expect(initialRefChangeRoles()).toEqual([]);
			process.env[REFCHANGE_ENV] = " alpha , docs-currency ,";
			expect(initialRefChangeRoles()).toEqual(["alpha", "docs-currency"]);
		} finally {
			if (previous === undefined) delete process.env[REFCHANGE_ENV];
			else process.env[REFCHANGE_ENV] = previous;
		}
	});
});

describe("referenceFiles validation (roles.ts)", () => {
	it("accepts absolute paths and refuses non-arrays, relative or non-string entries", () => {
		const problems: string[] = [];
		expect(parseSettings("alpha", { enabled: true, title: "t", boardName: "b", cwd: "/x", schedule: [], tools: ["coding"], referenceFiles: ["/a/b.md"] }, problems)).toBeDefined();
		expect(problems).toEqual([]);
		for (const bad of ["/a/b.md", "a/b.md", "", 7, ["/ok.md", "relative.md"], ["/ok.md", 7]]) {
			const local: string[] = [];
			const parsed = parseSettings("alpha", { enabled: true, title: "t", boardName: "b", cwd: "/x", schedule: [], tools: ["coding"], referenceFiles: bad }, local);
			expect(parsed, String(bad)).toBeUndefined();
			expect(local.join(" "), String(bad)).toMatch(/referenceFiles/);
		}
	});
});

describe("the reference-change input (the real host)", () => {
	const roots: string[] = [];

	afterEach(async () => {
		roots.splice(0);
	});

	async function freshRoot(roles: Parameters<typeof writeRolesTree>[1]): Promise<{ rolesRoot: string; stateDir: string }> {
		const stateDir = await makeStateDir();
		const rolesRoot = join(tempDir("refc-roles-"), "roles");
		roots.push(rolesRoot, stateDir);
		await writeRolesTree(rolesRoot, roles);
		return { rolesRoot, stateDir };
	}

	async function open(rolesRoot: string, stateDir: string): Promise<RoleHost> {
		const { enabled } = await loadRoles({ rolesRoot, stateDir });
		const { hostModels, defaultModel } = makeFauxHostModels();
		return openRoleHost({
			dbPath: join(stateDir, "roles.db"),
			stateDir,
			roles: enabled,
			defaultModel,
			hostModels,
		});
	}

	async function refChangeInputs(host: RoleHost, roleName: string): Promise<string[]> {
		const conversation = await host.conversation(roleName);
		const entries = await conversation!.entries({ order: "ascending" }, 200, undefined, context);
		return entries.items
			.filter(UserEntry.is)
			.map((entry) => JSON.stringify(entry.model?.[0]))
			.filter((text) => text.includes("Your reference files changed since you last read them"));
	}

	/** Wait (bounded) until the role has at least `atLeast` refchange inputs. */
	async function waitForRefChange(host: RoleHost, roleName: string, atLeast: number): Promise<string[]> {
		const deadline = Date.now() + 3_000;
		for (;;) {
			const inputs = await refChangeInputs(host, roleName);
			if (inputs.length >= atLeast) return inputs;
			if (Date.now() > deadline) return inputs;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}

	beforeEach(() => {
		delete process.env[REFCHANGE_ENV];
	});

	it("first sight stores silently: no input on the first open, and none on a reopen with no change", async () => {
		const { rolesRoot, stateDir } = await freshRoot([{ name: "alpha" }]);
		writeFileSync(join(rolesRoot, "alpha", "RUNBOOK.md"), "runbook one");
		const first = await open(rolesRoot, stateDir);
		await (await first.conversation("alpha"))!.waitForIdle(context);
		expect(await waitForRefChange(first, "alpha", 0)).toEqual([]);
		await first.close();

		const second = await open(rolesRoot, stateDir);
		try {
			await (await second.conversation("alpha"))!.waitForIdle(context);
			// If first sight had not stored, this reopen would flood the role with inputs.
			expect(await waitForRefChange(second, "alpha", 0)).toEqual([]);
		} finally {
			await second.close();
		}
	});

	it("a changed role file gets one input naming it; a reload with no change adds none", async () => {
		const { rolesRoot, stateDir } = await freshRoot([{ name: "alpha" }]);
		writeFileSync(join(rolesRoot, "alpha", "RUNBOOK.md"), "runbook one");
		const first = await open(rolesRoot, stateDir);
		await first.close();

		writeFileSync(join(rolesRoot, "alpha", "RUNBOOK.md"), "runbook two");
		const host = await open(rolesRoot, stateDir);
		try {
			const { enabled } = await loadRoles({ rolesRoot, stateDir });
			await host.applyRoles(enabled);
			const inputs = await waitForRefChange(host, "alpha", 1);
			expect(inputs).toHaveLength(1);
			expect(inputs[0]).toContain("RUNBOOK.md");
			// The same state reloaded again: delivered once.
			await host.applyRoles(enabled);
			await (await host.conversation("alpha"))!.waitForIdle(context);
			expect(await waitForRefChange(host, "alpha", 1)).toHaveLength(1);
		} finally {
			await host.close();
		}
	});

	it("a changed outside referenceFiles file gets one input naming its absolute path", async () => {
		const outsideDir = tempDir("refc-out-");
		const intent = join(outsideDir, "INTENT.md");
		const { rolesRoot, stateDir } = await freshRoot([{ name: "alpha", referenceFiles: [intent] }]);
		writeFileSync(intent, "intent one");
		const first = await open(rolesRoot, stateDir);
		await first.close();

		writeFileSync(intent, "intent two");
		const host = await open(rolesRoot, stateDir);
		try {
			const { enabled } = await loadRoles({ rolesRoot, stateDir });
			await host.applyRoles(enabled);
			const inputs = await waitForRefChange(host, "alpha", 1);
			expect(inputs).toHaveLength(1);
			expect(inputs[0]).toContain(intent);
		} finally {
			await host.close();
		}
	});

	it("a settings.json or instructions.md change alone gets no input", async () => {
		const { rolesRoot, stateDir } = await freshRoot([{ name: "alpha" }]);
		const first = await open(rolesRoot, stateDir);
		await first.close();

		writeFileSync(join(rolesRoot, "alpha", "instructions.md"), "new instructions {notes}");
		const host = await open(rolesRoot, stateDir);
		try {
			const { enabled } = await loadRoles({ rolesRoot, stateDir });
			await host.applyRoles(enabled);
			await (await host.conversation("alpha"))!.waitForIdle(context);
			expect(await waitForRefChange(host, "alpha", 0)).toEqual([]);
		} finally {
			await host.close();
		}
	});

	it("first sight with the role in STANDING_ROLES_REFCHANGE_INITIAL gets one input; an unlisted role stays silent", async () => {
		const previous = process.env[REFCHANGE_ENV];
		process.env[REFCHANGE_ENV] = "alpha";
		try {
			const { rolesRoot, stateDir } = await freshRoot([{ name: "alpha" }, { name: "beta" }]);
			writeFileSync(join(rolesRoot, "alpha", "RUNBOOK.md"), "runbook one");
			const host = await open(rolesRoot, stateDir);
			try {
				const alpha = await waitForRefChange(host, "alpha", 1);
				expect(alpha).toHaveLength(1);
				expect(alpha[0]).toContain("RUNBOOK.md");
				expect(await waitForRefChange(host, "beta", 0)).toEqual([]);
			} finally {
				await host.close();
			}
		} finally {
			if (previous === undefined) delete process.env[REFCHANGE_ENV];
			else process.env[REFCHANGE_ENV] = previous;
		}
	});

	it("the same requestId is delivered once (the property the hash key relies on)", async () => {
		const { rolesRoot, stateDir } = await freshRoot([{ name: "alpha" }]);
		const host = await open(rolesRoot, stateDir);
		try {
			const content = refChangeMessage(["RUNBOOK.md"]);
			await host.submit("alpha", { content, requestId: "refchange:alpha:0000000000000000" });
			await host.submit("alpha", { content, requestId: "refchange:alpha:0000000000000000" });
			await (await host.conversation("alpha"))!.waitForIdle(context);
			const inputs = await waitForRefChange(host, "alpha", 1);
			expect(inputs).toHaveLength(1);
		} finally {
			await host.close();
		}
	});

	it("the refchange run is a run like any other: it leaves a run-end line with its refchange slot", async () => {
		const { rolesRoot, stateDir } = await freshRoot([{ name: "alpha" }]);
		writeFileSync(join(rolesRoot, "alpha", "RUNBOOK.md"), "runbook one");
		const first = await open(rolesRoot, stateDir);
		await first.close();

		writeFileSync(join(rolesRoot, "alpha", "RUNBOOK.md"), "runbook two");
		const host = await open(rolesRoot, stateDir);
		try {
			await waitForRefChange(host, "alpha", 1);
			await (await host.conversation("alpha"))!.waitForIdle(context);
			const deadline = Date.now() + 3_000;
			for (;;) {
				const ends = readRunsFile(stateDir).filter((line) => line.kind === "run-end" && String(line.slot).startsWith("refchange:alpha:"));
				if (ends.length > 0 || Date.now() > deadline) {
					expect(ends).toHaveLength(1);
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
		} finally {
			await host.close();
		}
	});
});
