/**
 * The mirror after reloads: every reload must replace the running mirror, not add one. The bug: the
 * reload stopped the mirror the host started with, never the one the previous reload made, so after N reloads N
 * mirrors appended every entry — the reader showed each owner message two or three times.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { startHost } from "../src/main.ts";
import { makeFauxHostModels, makeStateDir, recordingPlumbing, writeRolesTree } from "./helpers.ts";
import type { HostConfig } from "../src/config.ts";

const roots: string[] = [];

afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("mirror after reloads", () => {
	it("writes each entry once however many times the roles were reloaded", async () => {
		const stateDir = await makeStateDir();
		const rolesRoot = join(await mkdtemp(join(tmpdir(), "sr-mirror-reload-")), "roles");
		roots.push(rolesRoot, stateDir);
		await writeRolesTree(rolesRoot, [{ name: "alpha", schedule: [{ at: "09:00", days: "daily" }] }]);
		const config: HostConfig = { stateDir, rolesRoot, schedules: false, integrations: false, timezone: "UTC", guardedServices: [], serviceName: "pi-roles", piAgentDir: "/nonexistent" };
		const { hostModels } = makeFauxHostModels();
		const { plumbing } = recordingPlumbing();
		const service = await startHost({ config, plumbing, hostModels, intervalMs: 3_600_000 });
		try {
			await service.reload();
			await service.reload();
			await service.chat("alpha", "only once please");
			await service.host.harness.waitForIdle(BACKGROUND_CONTEXT);
			// Let every watcher deliver what it saw.
			await new Promise((resolve) => setTimeout(resolve, 200));
			const lines = (await readFile(join(stateDir, "roles", "alpha", "transcript.jsonl"), "utf8"))
				.split("\n")
				.filter((line) => line.includes('"kind":"user"') && line.includes("only once please"));
			expect(lines).toHaveLength(1);
		} finally {
			await service.stop();
		}
	});
});
