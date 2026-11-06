/**
 * The wording of the inputs the host submits: every run input — scheduled slots, watch
 * firings, owner chat, the reference-change input — ends with one plain line: a capture check, then `Last step of this run:
 * call report_run.` (small models skip a last step that lives only in the system prompt, and roles
 * were found skipping the capture step without it), and a watch firing submitted while the role
 * is busy is stamped with a queued-since prefix, because its picture may be stale by the time the
 * follow-up is delivered. The requestIds are unchanged. Tests run the real host, scheduler, watcher and admin socket
 * on temp dirs with the faux provider; no live state directory.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { UserEntry } from "@earendil-works/pi-durable";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, type FauxProviderHandle, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { messageTexts, openRoleHost, type RoleHost } from "../src/harness.ts";
import { startAdmin } from "../src/admin.ts";
import { startSchedulers, type Scheduler } from "../src/schedules.ts";
import { startWatches, watchFiredContent, type Watcher, type WatchRunner } from "../src/watches.ts";
import { loadRoles } from "../src/roles.ts";
import { readRunsFile } from "../src/run-report.ts";
import { makeStateDir, writeRolesTree } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;
const SUFFIX =
	"Before your last step, capture what this run should keep (preamble, Capture before you finish): an owner correction or decision, a changed state, a lesson, a link across time. Last step of this run: call report_run.";
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function freshHost(
	roles: Parameters<typeof writeRolesTree>[1],
	hostModels?: { hostModels: Parameters<typeof openRoleHost>[0]["hostModels"]; defaultModel: { provider: string; modelId: string } },
): Promise<{ host: RoleHost; stateDir: string; rolesRoot: string }> {
	const stateDir = await makeStateDir();
	const rolesRoot = join(mkdtempSync(join(tmpdir(), "sr-wording-")), "roles");
	roots.push(rolesRoot, stateDir);
	await writeRolesTree(rolesRoot, roles);
	const { enabled } = await loadRoles({ rolesRoot, stateDir });
	const models = hostModels ?? makeFaux();
	const host = await openRoleHost({
		dbPath: join(stateDir, "roles.db"),
		stateDir,
		roles: enabled,
		defaultModel: models.defaultModel,
		hostModels: models.hostModels,
	});
	return { host, stateDir, rolesRoot };
}

function makeFaux(): { hostModels: Parameters<typeof openRoleHost>[0]["hostModels"]; defaultModel: { provider: string; modelId: string } } {
	const credentials = new InMemoryCredentialStore();
	const models = createModels({ credentials });
	const faux = fauxProvider({ tokensPerSecond: 4_000, models: [{ id: "m-1", contextWindow: 1_000_000 }] });
	models.setProvider(faux.provider);
	faux.setResponses(Array.from({ length: 32 }, () => plainReply as FauxResponseStep));
	return { hostModels: { models, credentials, problems: [] }, defaultModel: { provider: "faux", modelId: "m-1" } };
}

function plainReply(): ReturnType<typeof fauxAssistantMessage> {
	return fauxAssistantMessage([fauxText("Done.")]);
}

/** A faux host whose first model call waits on a test-held gate; the marker file says when it is pending. */
function makeGatedFaux(): {
	hostModels: Parameters<typeof openRoleHost>[0]["hostModels"];
	defaultModel: { provider: string; modelId: string };
	release(): void;
	marker: string;
	markerDir: string;
} {
	const credentials = new InMemoryCredentialStore();
	const models = createModels({ credentials });
	const markerDir = mkdtempSync(join(tmpdir(), "sr-wording-gated-"));
	const marker = join(markerDir, "pending");
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const step: FauxResponseStep = () => {
		writeFileSync(marker, new Date().toISOString(), "utf8");
		return gate.then(() => fauxAssistantMessage([fauxText("Done.")]));
	};
	const faux: FauxProviderHandle = fauxProvider({ tokensPerSecond: 4_000, models: [{ id: "m-1", contextWindow: 1_000_000 }] });
	models.setProvider(faux.provider);
	faux.setResponses(Array.from({ length: 16 }, () => step));
	roots.push(markerDir);
	return { hostModels: { models, credentials, problems: [] }, defaultModel: { provider: "faux", modelId: "m-1" }, release: () => release(), marker, markerDir };
}

/** The text of every user input the conversation has received, oldest first. */
async function userTexts(host: RoleHost, roleName: string): Promise<string[]> {
	const conversation = await host.conversation(roleName);
	const entries = await conversation!.entries({ order: "ascending" }, 200, undefined, context);
	return entries.items.filter(UserEntry.is).map((entry) => messageTexts(entry)[0] ?? "");
}

async function until(probe: () => boolean, timeoutMs = 3_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (probe()) return true;
		if (Date.now() > deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe("the report_run suffix on every run input", () => {
	it("a submitted run input ends with the line exactly once, and the requestId is unchanged", async () => {
		const { host, stateDir } = await freshHost([{ name: "alpha" }]);
		try {
			await host.submit("alpha", { content: "Do the round.", requestId: "plain-1" });
			await (await host.conversation("alpha"))!.waitForIdle(context);
			const texts = await userTexts(host, "alpha");
			expect(texts).toHaveLength(1);
			expect(texts[0]).toBe(`Do the round.\n${SUFFIX}`);
			expect(texts[0].split(SUFFIX)).toHaveLength(2);
			// The requestId is unchanged: the run-end line's slot is still the plain requestId.
			expect(await until(() => readRunsFile(stateDir).some((line) => line.kind === "run-end" && line.slot === "plain-1"))).toBe(true);
		} finally {
			await host.close();
		}
	});

	it("a scheduled run carries the line", async () => {
		const { host } = await freshHost([{ name: "alpha", schedule: [{ at: "00:05", days: "daily" }] }]);
		try {
			// 01:00 in the zone on 28 Oct (GMT) is past the 00:05 slot.
			const clock = () => Date.UTC(2026, 9, 28, 1, 0);
			const scheduler: Scheduler = startSchedulers({ host, enabled: true, clock, intervalMs: 60_000 });
			try {
				const submitted = await scheduler.tick();
				expect(submitted).toEqual(["alpha:2026-10-28T00:05"]);
				await (await host.conversation("alpha"))!.waitForIdle(context);
				const texts = await userTexts(host, "alpha");
				expect(texts).toHaveLength(1);
				expect(texts[0].startsWith("Scheduled run 00:05.")).toBe(true);
				expect(texts[0].endsWith(`\n${SUFFIX}`)).toBe(true);
			} finally {
				scheduler.stop();
			}
		} finally {
			await host.close();
		}
	});

	it("a watch firing on an idle role carries the line and no queue prefix; the requestId is unchanged", async () => {
		const { host } = await freshHost([
			{ name: "alpha", watches: [{ name: "tmp-mode", command: "stat -c %a /tmp", expect: "1777", everySeconds: 30 }] },
		]);
		try {
			const runner: WatchRunner = async () => ({ code: 0, stdout: "700" });
			const clock = () => Date.UTC(2026, 9, 28, 12, 34);
			const watcher: Watcher = startWatches({ host, enabled: true, clock, intervalMs: 60_000, runner });
			try {
				const fired = await watcher.tick();
				expect(fired).toHaveLength(1);
				expect(fired[0]).toMatch(/^watch:alpha:tmp-mode:2026-10-28T12:34/);
				await (await host.conversation("alpha"))!.waitForIdle(context);
				const texts = await userTexts(host, "alpha");
				expect(texts).toHaveLength(1);
				expect(texts[0]).toBe(`${watchFiredContent({ name: "tmp-mode", command: "stat -c %a /tmp", expect: "1777", everySeconds: 30 }, "700")}\n${SUFFIX}`);
				expect(texts[0].startsWith("Queued since")).toBe(false);
			} finally {
				watcher.stop();
			}
		} finally {
			await host.close();
		}
	});

	it("a watch firing submitted while the role is busy is stamped Queued since HH:MM UTC", async () => {
		const gated = makeGatedFaux();
		const { host } = await freshHost(
			[{ name: "alpha", watches: [{ name: "tmp-mode", command: "stat -c %a /tmp", expect: "1777", everySeconds: 30 }] }],
			gated,
		);
		try {
			// A run is executing (parked on the gate); the watch fires while it is busy.
			await host.submit("alpha", { content: "the busy run", requestId: "run-a" });
			expect(await until(() => existsSync(gated.marker))).toBe(true);
			const runner: WatchRunner = async () => ({ code: 0, stdout: "700" });
			const clock = () => Date.UTC(2026, 9, 28, 12, 34);
			const watcher: Watcher = startWatches({ host, enabled: true, clock, intervalMs: 60_000, runner });
			try {
				const fired = await watcher.tick();
				expect(fired).toHaveLength(1);
				// The requestId is unchanged by the stamp.
				expect(fired[0]).toMatch(/^watch:alpha:tmp-mode:2026-10-28T12:34/);

				gated.release();
				await (await host.conversation("alpha"))!.waitForIdle(context);
				const texts = await userTexts(host, "alpha");
				expect(texts).toHaveLength(2);
				const firing = texts[1];
				expect(firing.startsWith("Queued since 12:34 UTC behind a running turn — what it describes may have moved on; recheck before acting.\nWatch fired:")).toBe(true);
				expect(firing.endsWith(`\n${SUFFIX}`)).toBe(true);
				// The busy run itself is unstamped.
				expect(texts[0].startsWith("Queued since")).toBe(false);
			} finally {
				watcher.stop();
			}
		} finally {
			gated.release();
			await host.close();
		}
	});

	it("a refchange input carries the line", async () => {
		const { host, stateDir, rolesRoot } = await freshHost([{ name: "alpha" }]);
		try {
			writeFileSync(join(rolesRoot, "alpha", "RUNBOOK.md"), "runbook one");
			const first = host; // first sight stores silently on open; change and reload
			void first;
			writeFileSync(join(rolesRoot, "alpha", "RUNBOOK.md"), "runbook two");
			const { enabled } = await loadRoles({ rolesRoot, stateDir });
			await host.applyRoles(enabled);
			await (await host.conversation("alpha"))!.waitForIdle(context);
			const texts = await userTexts(host, "alpha");
			expect(texts).toHaveLength(1);
			expect(texts[0].startsWith("Your reference files changed since you last read them: RUNBOOK.md.")).toBe(true);
			expect(texts[0].endsWith(`\n${SUFFIX}`)).toBe(true);
		} finally {
			await host.close();
		}
	});

	it("an owner chat message carries the line", async () => {
		const { host, stateDir, rolesRoot } = await freshHost([{ name: "alpha" }]);
		try {
			const admin = await startAdmin({ host, stateDir, rolesRoot, disabled: () => [], statuses: () => new Map(), onReload: async () => ({ enabled: [], disabled: [], problems: [] }) });
			try {
				const posted = await new Promise<{ status: number }>((resolve, reject) => {
					void import("node:http").then(({ request: httpRequest }) => {
						const data = JSON.stringify({ role: "alpha", text: "good morning" });
						const req = httpRequest(
							{ socketPath: admin.path, path: "/chat", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } },
							(res) => {
								void res.resume();
								res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
							},
						);
						req.on("error", reject);
						req.write(data);
						req.end();
					});
				});
				expect(posted.status).toBe(202);
				await (await host.conversation("alpha"))!.waitForIdle(context);
				const texts = await userTexts(host, "alpha");
				expect(texts).toHaveLength(1);
				expect(texts[0].startsWith("Message from the owner")).toBe(true);
				expect(texts[0].endsWith(`\n${SUFFIX}`)).toBe(true);
			} finally {
				admin.stop();
			}
		} finally {
			await host.close();
		}
	});
});
