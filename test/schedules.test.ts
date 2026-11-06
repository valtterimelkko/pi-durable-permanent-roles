import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { UserEntry } from "@earendil-works/pi-durable";
import { noOpPlumbing, openRoleHost, type RoleHost } from "../src/harness.ts";
import { ScheduleLedgerDoc, startSchedulers, type Scheduler } from "../src/schedules.ts";
import { zoneParts } from "../src/host-time.ts";

// This suite pins the schedule arithmetic against a DST zone; the host default is UTC.
process.env.STANDING_ROLES_TIMEZONE = "Europe/London";
import { loadRoles } from "../src/roles.ts";
import { makeFauxHostModels, makeStateDir, writeRolesTree, type FixtureRole } from "./helpers.ts";
import type { Plumbing } from "../src/types.ts";

const context = BACKGROUND_CONTEXT;
const roots: string[] = [];

afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** Recording plumbing built on the no-op one: "started <role> <step>" and "ended <role>" lines. */
function recordingPlumbing(): { plumbing: Plumbing; events: string[] } {
	const events: string[] = [];
	return {
		events,
		plumbing: {
			...noOpPlumbing(),
			runStarted: (role, step) => void events.push(`started ${role.name} ${step}`),
			runEnded: (role) => void events.push(`ended ${role.name}`),
		},
	};
}

/** 2026-10-20 is a Tuesday (within BST); London time = UTC+1. */
function utcMs(zoneYyyyMmDd: string, hhMm: string): number {
	const [y, m, d] = zoneYyyyMmDd.split("-").map(Number);
	const [hh, mm] = hhMm.split(":").map(Number);
	// The London instant for a wall time: guess UTC, correct twice by what London then says.
	let guess = Date.UTC(y, m - 1, d, hh, mm);
	for (let i = 0; i < 2; i++) {
		const said = zoneParts(guess);
		const want = `${zoneYyyyMmDd} ${hhMm}`;
		const got = `${said.date} ${said.time}`;
		if (want === got) break;
		const [wy, wm, wd] = want.split(/[ -]/).map(Number);
		const [wh, wn] = hhMm.split(":").map(Number);
		const [gy, gm, gd] = got.split(/[ -]/).map(Number);
		const [gh, gn] = said.time.split(":").map(Number);
		guess += Date.UTC(wy, wm - 1, wd, wh, wn) - Date.UTC(gy, gm - 1, gd, gh, gn);
	}
	return guess;
}

async function setup(roles: FixtureRole[]): Promise<{ host: RoleHost; plumbing: Plumbing; events: string[]; stateDir: string }> {
	const stateDir = await makeStateDir();
	const rolesRoot = join(await mkdtemp(join(tmpdir(), "sr-sched-")), "roles");
	roots.push(rolesRoot, stateDir);
	await writeRolesTree(rolesRoot, roles);
	const { enabled } = await loadRoles({ rolesRoot, stateDir });
	const { hostModels, defaultModel } = makeFauxHostModels();
	const { plumbing, events } = recordingPlumbing();
	const host = await openRoleHost({
		dbPath: join(stateDir, "roles.db"),
		stateDir,
		roles: enabled,
		defaultModel,
		hostModels,
		plumbing,
	});
	return { host, plumbing, events, stateDir };
}

async function userCount(host: RoleHost, roleName: string): Promise<number> {
	const conversation = await host.conversation(roleName);
	const entries = await conversation!.entries({ order: "ascending" }, 100, undefined, context);
	return entries.items.filter((entry) => UserEntry.is(entry)).length;
}

describe("startSchedulers", () => {
	it("a due slot submits exactly once — a second tick does not resubmit", async () => {
		const { host } = await setup([{ name: "alpha", schedule: [{ at: "09:00", days: "daily" }] }]);
		const clock = () => utcMs("2026-10-20", "10:00");
		const scheduler = startSchedulers({ host, enabled: true, clock, intervalMs: 3_600_000 });
		try {
			const first = await scheduler.tick();
			expect(first).toEqual(["alpha:2026-10-20T09:00"]);
			await (await host.conversation("alpha"))!.waitForIdle(context);
			expect(await userCount(host, "alpha")).toBe(1);
			const second = await scheduler.tick();
			expect(second).toEqual([]);
			expect(await userCount(host, "alpha")).toBe(1);
			// The submitted input is the scheduled-run prompt.
			const conversation = await host.conversation("alpha");
			const entries = await conversation!.entries({ order: "ascending" }, 100, undefined, context);
			const user = entries.items.find((entry) => UserEntry.is(entry));
			expect(JSON.stringify(user?.model?.[0])).toContain("Scheduled run 09:00.");
		} finally {
			scheduler.stop();
			await host.close();
		}
	});

	it("the ledger drops run ids older than a week, so it stops growing", async () => {
		const { host } = await setup([{ name: "alpha", schedule: [{ at: "09:00", days: "daily" }] }]);
		let now = utcMs("2026-10-01", "10:00");
		const scheduler = startSchedulers({ host, enabled: true, clock: () => now });
		try {
			for (let day = 1; day <= 10; day++) {
				now = utcMs(`2026-10-${String(day).padStart(2, "0")}`, "10:00");
				expect(await scheduler.tick()).toEqual([`alpha:2026-10-${String(day).padStart(2, "0")}T09:00`]);
			}
			const conversation = await host.conversation("alpha");
			const ledger = await host.harness.snapshot(ScheduleLedgerDoc, conversation!.id, context);
			const kept = Object.keys(ledger!.createdRuns).sort();
			expect(kept[0]).toBe("alpha:2026-10-03T09:00");
			expect(kept).toHaveLength(8);
			// Still once per slot: today's slot is in the ledger, so a second tick does nothing.
			expect(await scheduler.tick()).toEqual([]);
		} finally {
			scheduler.stop();
			await host.close();
		}
	});

	it("a slot that is not due yet does not submit", async () => {
		const { host } = await setup([{ name: "alpha", schedule: [{ at: "09:00", days: "daily" }] }]);
		const clock = () => utcMs("2026-10-20", "08:30");
		const scheduler = startSchedulers({ host, enabled: true, clock });
		try {
			expect(await scheduler.tick()).toEqual([]);
			expect(await userCount(host, "alpha")).toBe(0);
		} finally {
			scheduler.stop();
			await host.close();
		}
	});

	it("a slot missed while running is caught up late, once, the same London day", async () => {
		const { host } = await setup([{ name: "alpha", schedule: [{ at: "09:00", days: "daily" }] }]);
		let now = utcMs("2026-10-20", "08:30");
		const scheduler = startSchedulers({ host, enabled: true, clock: () => now });
		try {
			expect(await scheduler.tick()).toEqual([]);
			now = utcMs("2026-10-20", "11:00");
			expect(await scheduler.tick()).toEqual(["alpha:2026-10-20T09:00"]);
			await (await host.conversation("alpha"))!.waitForIdle(context);
			expect(await scheduler.tick()).toEqual([]);
			expect(await userCount(host, "alpha")).toBe(1);
		} finally {
			scheduler.stop();
			await host.close();
		}
	});

	it("yesterday's slots are not re-run; the new day's slot runs when due", async () => {
		const { host } = await setup([{ name: "alpha", schedule: [{ at: "09:00", days: "daily" }] }]);
		let now = utcMs("2026-10-20", "10:00");
		const scheduler = startSchedulers({ host, enabled: true, clock: () => now });
		try {
			expect(await scheduler.tick()).toEqual(["alpha:2026-10-20T09:00"]);
			await (await host.conversation("alpha"))!.waitForIdle(context);
			// The next morning before the slot: nothing runs.
			now = utcMs("2026-10-21", "08:00");
			expect(await scheduler.tick()).toEqual([]);
			expect(await userCount(host, "alpha")).toBe(1);
			// After the slot: exactly the new day's run.
			now = utcMs("2026-10-21", "09:30");
			expect(await scheduler.tick()).toEqual(["alpha:2026-10-21T09:00"]);
			await (await host.conversation("alpha"))!.waitForIdle(context);
			expect(await userCount(host, "alpha")).toBe(2);
		} finally {
			scheduler.stop();
			await host.close();
		}
	});

	it("the weekdays gate skips the zone Saturday and Sunday", async () => {
		const { host } = await setup([{ name: "alpha", schedule: [{ at: "09:00", days: "weekdays" }] }]);
		// 2026-10-24 is a Saturday; 2026-10-25 a Sunday; 2026-10-26 a Monday.
		const saturday = startSchedulers({ host, enabled: true, clock: () => utcMs("2026-10-24", "10:00") });
		try {
			expect(await saturday.tick()).toEqual([]);
			expect(zoneParts(utcMs("2026-10-24", "10:00")).weekday).toBe("Sat");
		} finally {
			saturday.stop();
		}
		const sunday = startSchedulers({ host, enabled: true, clock: () => utcMs("2026-10-25", "10:00") });
		try {
			expect(await sunday.tick()).toEqual([]);
		} finally {
			sunday.stop();
		}
		const monday = startSchedulers({ host, enabled: true, clock: () => utcMs("2026-10-26", "10:00") });
		try {
			expect(await monday.tick()).toEqual(["alpha:2026-10-26T09:00"]);
			await (await host.conversation("alpha"))!.waitForIdle(context);
			expect(await userCount(host, "alpha")).toBe(1);
		} finally {
			monday.stop();
			await host.close();
		}
	});

	it("runStarted fires when the run is submitted and runEnded once the conversation is idle", async () => {
		const { host, events } = await setup([{ name: "alpha", schedule: [{ at: "09:00", days: "daily" }] }]);
		const scheduler = startSchedulers({ host, enabled: true, clock: () => utcMs("2026-10-20", "10:00") });
		try {
			await scheduler.tick();
			await (await host.conversation("alpha"))!.waitForIdle(context);
			// Let the fire-and-forget runEnded land.
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(events).toContain("started alpha alpha:2026-10-20T09:00");
			expect(events).toContain("ended alpha");
		} finally {
			scheduler.stop();
			await host.close();
		}
	});

	it("schedules off: nothing runs even when a slot is due", async () => {
		const { host } = await setup([{ name: "alpha", schedule: [{ at: "09:00", days: "daily" }] }]);
		const scheduler = startSchedulers({ host, enabled: false, clock: () => utcMs("2026-10-20", "10:00") });
		try {
			expect(await scheduler.tick()).toEqual([]);
			expect(await userCount(host, "alpha")).toBe(0);
		} finally {
			scheduler.stop();
			await host.close();
		}
	});
});
