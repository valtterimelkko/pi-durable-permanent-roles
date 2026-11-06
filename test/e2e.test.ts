/**
 * The end-to-end test (faux provider, temp state dirs): two roles load;
 * each gets its own conversation; a due slot submits exactly once; a manual chat reaches
 * the right role; transcript.jsonl and status.json appear; a model change in settings is
 * applied after reload while the history stays.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { UserEntry } from "@earendil-works/pi-durable";
import { startHost } from "../src/main.ts";
import { makeFauxHostModels, makeStateDir, recordingPlumbing, writeRolesTree } from "./helpers.ts";
import type { HostConfig } from "../src/config.ts";

const context = BACKGROUND_CONTEXT;
const roots: string[] = [];

afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** 2026-10-20 is a Tuesday; in Europe/London it is 10:00 (= 09:00 UTC, BST). */
const CLOCK = () => Date.UTC(2026, 9, 20, 9, 0, 0);

// The e2e pins its schedule arithmetic against a DST zone; the host default is UTC.
process.env.STANDING_ROLES_TIMEZONE = "Europe/London";

describe("startHost end to end (faux)", () => {
	it("two roles, own conversations, one scheduled run each, chat to the right role, mirror files, reload model change", async () => {
		const stateDir = await makeStateDir();
		const rolesRoot = join(await mkdtemp(join(tmpdir(), "sr-e2e-")), "roles");
		roots.push(rolesRoot, stateDir);
		await writeRolesTree(rolesRoot, [
			{ name: "alpha", schedule: [{ at: "09:00", days: "daily" }] },
			{ name: "beta", schedule: [{ at: "09:30", days: "weekdays" }] },
		]);
		const config: HostConfig = {
			stateDir,
			rolesRoot,
			schedules: true,
			integrations: false,
			timezone: "UTC",
			guardedServices: [],
			serviceName: "pi-roles",
			piAgentDir: "/nonexistent",
		};
		const { hostModels } = makeFauxHostModels();
		const { plumbing, events } = recordingPlumbing();
		const service = await startHost({ config, plumbing, hostModels, clock: CLOCK, intervalMs: 3_600_000 });
		try {
			// Two roles, each its own conversation.
			const alphaId = service.host.conversationId("alpha");
			const betaId = service.host.conversationId("beta");
			expect(alphaId).toBeDefined();
			expect(betaId).toBeDefined();
			expect(alphaId).not.toBe(betaId);

			// A due slot submits exactly once; a second tick adds nothing.
			expect(await service.scheduler!.tick()).toEqual(["alpha:2026-10-20T09:00", "beta:2026-10-20T09:30"]);
			await service.host.harness.waitForIdle(context);
			expect(await service.scheduler!.tick()).toEqual([]);
			const userEntries = async (role: string): Promise<string[]> => {
				const conversation = await service.host.conversation(role);
				const entries = await conversation!.entries({ order: "ascending" }, 100, undefined, context);
				return entries.items.filter((entry) => UserEntry.is(entry)).map((entry) => JSON.stringify(entry.model?.[0]));
			};
			expect((await userEntries("alpha")).length).toBe(1);
			expect((await userEntries("beta")).length).toBe(1);
			expect(events).toContain("started alpha alpha:2026-10-20T09:00");
			expect(events).toContain("started beta beta:2026-10-20T09:30");

			// A manual chat reaches the right role only.
			await service.chat("beta", "hello beta");
			await service.host.harness.waitForIdle(context);
			expect((await userEntries("alpha")).length).toBe(1);
			const betaMessages = await userEntries("beta");
			expect(betaMessages.length).toBe(2);
			expect(betaMessages[1]).toContain("Message from the owner (via cli): hello beta");

			// The mirror's files exist for both roles.
			for (const role of ["alpha", "beta"]) {
				const transcript = await readFile(join(stateDir, "roles", role, "transcript.jsonl"), "utf8");
				expect(transcript).toContain('"kind":"user"');
				const status = JSON.parse(await readFile(join(stateDir, "roles", role, "status.json"), "utf8")) as Record<string, unknown>;
				expect(status).toMatchObject({ role, enabled: true, boardName: `role-${role}` });
			}

			// A model change in settings takes effect after reload, history stays.
			await writeFile(join(rolesRoot, "defaults.json"), JSON.stringify({ model: { provider: "faux", modelId: "m-2" }, thinking: "high" }), "utf8");
			await service.reload();
			const agent = await (await service.host.conversation("alpha"))!.agent(context);
			expect(agent.model).toEqual({ provider: "faux", modelId: "m-2" });
			expect((await userEntries("alpha")).length).toBe(1); // history untouched by the reload

			// The admin socket answers bin/roles-shaped GETs.
			const status = await service.status();
			expect(status.roles?.map((role) => role.role)).toEqual(["alpha", "beta"]);
		} finally {
			await service.stop();
		}
	});
});
