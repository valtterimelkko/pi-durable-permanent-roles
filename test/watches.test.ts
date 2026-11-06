import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { UserEntry } from "@earendil-works/pi-durable";
import { noOpPlumbing, openRoleHost, type RoleHost } from "../src/harness.ts";
import { shellWatchRunner, startWatches, watchFiredContent, watchTickDelayMs, WATCH_OUTPUT_MAX, WATCH_TICK_PHASE_MS, type Watcher, type WatchRunner } from "../src/watches.ts";
import { loadRoles } from "../src/roles.ts";
import { makeFauxHostModels, makeStateDir, writeRolesTree, type FixtureRole } from "./helpers.ts";
import type { RoleDefinition, RoleWatch } from "../src/types.ts";
import { WatchLedgerDoc } from "../src/watches.ts";

/**
 * The roles' watches: a host-side trigger, nothing more. A role's settings list
 * `{name, command, expect, everySeconds}` entries the host runs on an interval — only while schedules
 * are on — and on a mismatch (or a failed command) submits ONE input per firing episode, with a durable
 * requestId per episode, until a check matches again. Tests use the faux provider, a temp state dir and
 * a scripted runner; no shell command here touches the host beyond this process.
 */
const context = BACKGROUND_CONTEXT;
const roots: string[] = [];

afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const TMP_MODE = { name: "tmp-mode", command: "stat -c %a /tmp", expect: "1777", everySeconds: 30 };

/** A runner whose answers come off a script; the last answer repeats. Every command is recorded. */
function scriptedRunner(script: Array<{ code: number; stdout: string }>): { runner: WatchRunner; calls: string[] } {
	const calls: string[] = [];
	let at = 0;
	return {
		calls,
		runner: async (command) => {
			calls.push(command);
			const answer = script[Math.min(at, script.length - 1)]!;
			at++;
			return answer;
		},
	};
}

async function setup(roles: FixtureRole[]): Promise<{ host: RoleHost; stateDir: string }> {
	const stateDir = await makeStateDir();
	const rolesRoot = join(await mkdtemp(join(tmpdir(), "sr-watch-")), "roles");
	roots.push(rolesRoot, stateDir);
	await writeRolesTree(rolesRoot, roles);
	const { enabled } = await loadRoles({ rolesRoot, stateDir });
	const { hostModels, defaultModel } = makeFauxHostModels();
	const host = await openRoleHost({
		dbPath: join(stateDir, "roles.db"),
		stateDir,
		roles: enabled,
		defaultModel,
		hostModels,
		plumbing: noOpPlumbing(),
	});
	return { host, stateDir };
}

/** A role definition built by hand, for hosts that include a disabled role on purpose. */
function def(name: string, enabled: boolean, watches: RoleWatch[] | undefined): RoleDefinition {
	return {
		name,
		dir: `/tmp/sr-watch-def/${name}`,
		settings: {
			enabled,
			title: name,
			boardName: `role-${name}`,
			schedule: [],
			cwd: "/tmp",
			tools: ["coding"],
			...(watches === undefined ? {} : { watches }),
		},
		model: { provider: "faux", modelId: "m-1" },
		thinking: "high",
		instructions: `Do the ${name} work.`,
		notesDir: `/tmp/sr-watch-def/${name}/notes`,
	};
}

/** The text of a persisted entry's first message (role, content, timestamp). */
function textOf(message: unknown): string {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (typeof content === "string") return content;
	return Array.isArray(content)
		? content
			.flatMap((part) =>
				typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text"
					? [String((part as { text?: unknown }).text ?? "")]
					: [],
			)
			.join("")
		: "";
}

async function userTexts(host: RoleHost, roleName: string): Promise<string[]> {
	const conversation = await host.conversation(roleName);
	if (conversation === undefined) return [];
	const entries = await conversation.entries({ order: "ascending" }, 100, undefined, context);
	return entries.items.filter((entry) => UserEntry.is(entry)).map((entry) => textOf((entry as { model?: unknown[] }).model?.[0]));
}

async function withWatcher(host: RoleHost, runner: WatchRunner, run: (watcher: Watcher) => Promise<void>): Promise<void> {
	const watcher = startWatches({ host, enabled: true, runner });
	try {
		await run(watcher);
	} finally {
		watcher.stop();
		await host.close();
	}
}

describe("startWatches", () => {
	it("a mismatch fires exactly once per episode — a second tick does not resubmit", async () => {
		const { host } = await setup([{ name: "alpha", watches: [TMP_MODE] }]);
		const { runner } = scriptedRunner([{ code: 0, stdout: "700\n" }]);
		await withWatcher(host, runner, async (watcher) => {
			const first = await watcher.tick();
			expect(first).toHaveLength(1);
			expect(first[0]).toMatch(/^watch:alpha:tmp-mode:\d{4}-\d{2}-\d{2}T/);
			await (await host.conversation("alpha"))!.waitForIdle(context);
			expect(await userTexts(host, "alpha")).toHaveLength(1);
			const second = await watcher.tick();
			expect(second).toEqual([]);
			expect(await userTexts(host, "alpha")).toHaveLength(1);
			// The submitted input is the exact firing message.
			const texts = await userTexts(host, "alpha");
			expect(texts[0]).toContain(watchFiredContent(TMP_MODE, "700"));
		});
	});

	it("the firing message is exactly: Watch fired: <name>. `<command>` gave \"<output>\", expected \"<expect>\".", async () => {
		expect(watchFiredContent(TMP_MODE, "700")).toBe(
			'Watch fired: tmp-mode. `stat -c %a /tmp` gave "700", expected "1777". Act per your instructions.',
		);
	});

	it("a match closes the episode and the watch re-arms", async () => {
		const { host } = await setup([{ name: "alpha", watches: [TMP_MODE] }]);
		const { runner } = scriptedRunner([
			{ code: 0, stdout: "700" }, // fires
			{ code: 0, stdout: "1777" }, // episode closed
			{ code: 0, stdout: "1777" }, // nothing open
			{ code: 0, stdout: "700" }, // fires again, new requestId
		]);
		let now = 1_000_000;
		const watcher = startWatches({ host, enabled: true, runner, clock: () => now });
		try {
			const first = await watcher.tick();
			expect(first).toHaveLength(1);
			now += 30_000;
			await watcher.tick(); // match: closes
			now += 30_000;
			await watcher.tick(); // match, nothing open
			now += 30_000;
			const again = await watcher.tick();
			expect(again).toHaveLength(1);
			expect(again[0]).not.toEqual(first[0]); // a new episode, a new requestId
			await (await host.conversation("alpha"))!.waitForIdle(context);
			expect(await userTexts(host, "alpha")).toHaveLength(2);
		} finally {
			watcher.stop();
			await host.close();
		}
	});

	it("a restart cannot double-submit: a new watcher over the same storage honours the open episode", async () => {
		const { host } = await setup([{ name: "alpha", watches: [TMP_MODE] }]);
		const { runner } = scriptedRunner([{ code: 0, stdout: "700" }]);
		const first = startWatches({ host, enabled: true, runner });
		let firstIds: string[] = [];
		try {
			firstIds = await first.tick();
			expect(firstIds).toHaveLength(1);
		} finally {
			first.stop();
		}
		// The host "restarts" (a new watcher, in-memory due-ness lost); the mismatch persists.
		const second = startWatches({ host, enabled: true, runner });
		try {
			const ids = await second.tick();
			expect(ids).toEqual([]);
			await (await host.conversation("alpha"))!.waitForIdle(context);
			expect(await userTexts(host, "alpha")).toHaveLength(1);
			// The durable ledger still holds the first episode, so no new requestId can be minted.
			const conversation = await host.conversation("alpha");
			const ledger = await host.harness.snapshot(WatchLedgerDoc, conversation!.id, context);
			expect(ledger?.open["tmp-mode"]).toEqual(firstIds[0]);
		} finally {
			second.stop();
			await host.close();
		}
	});

	it("a non-zero exit is a mismatch even when the stdout matches", async () => {
		const { host } = await setup([{ name: "alpha", watches: [TMP_MODE] }]);
		const { runner } = scriptedRunner([{ code: 1, stdout: "1777" }]);
		await withWatcher(host, runner, async (watcher) => {
			const fired = await watcher.tick();
			expect(fired).toHaveLength(1);
		});
	});

	it("a disabled role is never watched, even when the host knows it", async () => {
		const stateDir = await makeStateDir();
		roots.push(stateDir);
		const { hostModels, defaultModel } = makeFauxHostModels();
		const host = await openRoleHost({
			dbPath: join(stateDir, "roles.db"),
			stateDir,
			roles: [def("alpha", true, [TMP_MODE]), def("beta", false, [{ ...TMP_MODE, name: "beta-mode" }])],
			defaultModel,
			hostModels,
			plumbing: noOpPlumbing(),
		});
		const { runner, calls } = scriptedRunner([{ code: 0, stdout: "700" }]);
		await withWatcher(host, runner, async (watcher) => {
			const fired = await watcher.tick();
			expect(fired).toHaveLength(1);
			expect(fired[0]).toMatch(/^watch:alpha:tmp-mode:/);
			expect(calls).toEqual(["stat -c %a /tmp"]); // only alpha's command ran
			await (await host.conversation("beta"))!.waitForIdle(context);
			expect(await userTexts(host, "beta")).toEqual([]); // and beta was never fired at
		});
	});

	it("everySeconds gates the checks: not due again until the interval has passed", async () => {
		const { host } = await setup([{ name: "alpha", watches: [{ ...TMP_MODE, expect: "1777" }] }]);
		let now = 1_000_000;
		const { runner, calls } = scriptedRunner([{ code: 0, stdout: "1777" }]);
		const watcher = startWatches({ host, enabled: true, runner, clock: () => now });
		try {
			await watcher.tick();
			expect(calls).toHaveLength(1); // the first check is due at once
			await watcher.tick();
			expect(calls).toHaveLength(1); // 30 s have not passed
			now += 30_000;
			await watcher.tick();
			expect(calls).toHaveLength(2);
		} finally {
			watcher.stop();
			await host.close();
		}
	});

	it("does nothing when watches are switched off (the schedules switch)", async () => {
		const { host } = await setup([{ name: "alpha", watches: [TMP_MODE] }]);
		const { runner } = scriptedRunner([{ code: 0, stdout: "700" }]);
		await withWatcher(host, runner, async (watcher) => {
			const watcherOff = startWatches({ host, enabled: false, runner });
			try {
				expect(await watcherOff.tick()).toEqual([]);
			} finally {
				watcherOff.stop();
			}
			// The enabled one still fires, proving the switch — not something else — decides.
			expect(await watcher.tick()).toHaveLength(1);
		});
	});

	it("the tick runs at :30 past the minute whatever the start time: X's API is slow on the five-minute marks (29 Oct)", () => {
		const minute = 60_000;
		const at = (s: number) => Date.UTC(2026, 9, 29, 13, 58, 0) + s * 1000;
		expect(WATCH_TICK_PHASE_MS).toBe(30_000);
		expect(watchTickDelayMs(at(58), minute)).toBe(32_000); // a start at 13:58:58 first ticks at 13:59:30
		expect(watchTickDelayMs(at(0), minute)).toBe(30_000);
		expect(watchTickDelayMs(at(30), minute)).toBe(0);
		expect(watchTickDelayMs(at(31), minute)).toBe(59_000);
		expect(watchTickDelayMs(at(58) + 1, 1_000)).toBe(999); // a short test interval keeps its own phase
	});

	it("a role without watches is simply never checked", async () => {
		const { host } = await setup([{ name: "alpha", schedule: [{ at: "04:15", days: "daily" }] }]);
		const { runner, calls } = scriptedRunner([{ code: 0, stdout: "700" }]);
		await withWatcher(host, runner, async (watcher) => {
			expect(await watcher.tick()).toEqual([]);
			expect(calls).toEqual([]);
		});
	});
});

describe("shellWatchRunner (the real seam)", () => {
	it("runs the command through the shell and keeps at most 2 KB of stdout", async () => {
		const runner = shellWatchRunner(5_000);
		const ok = await runner("echo 1777");
		expect(ok).toEqual({ code: 0, stdout: "1777\n" }); // raw stdout; the comparison trims
		const big = await runner(`printf '%*s' ${WATCH_OUTPUT_MAX * 4} x`);
		expect(big.code).toBe(0);
		expect(big.stdout.length).toBe(WATCH_OUTPUT_MAX);
	});

	it("a failing or timed-out command answers non-zero, never throws", async () => {
		const runner = shellWatchRunner(300);
		const failed = await runner("exit 3");
		expect(failed.code).toBe(3);
		const slow = await runner("sleep 5");
		expect(slow.code).toBe(124);
	});
});
