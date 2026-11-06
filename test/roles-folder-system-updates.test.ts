/** The system-updates role folder: settings, the /tmp watch, and the reference docs it points at. */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { loadRoles } from "../src/roles.ts";

const roleDir = new URL("../roles/system-updates/", import.meta.url).pathname;
const repoRoles = new URL("../roles/", import.meta.url).pathname;

describe("the system-updates role folder", () => {
	it("loads valid (shipped disabled), with its weekday schedule and counts", async () => {
		const { disabled, problems } = await loadRoles({ rolesRoot: repoRoles, stateDir: "/tmp/sr-state" });
		expect(problems).toEqual([]);
		const role = disabled.find((candidate) => candidate.name === "system-updates");
		expect(role).toBeDefined();
		expect(role!.settings.enabled).toBe(false);
		expect(role!.settings.schedule).toEqual([{ at: "04:00", days: "weekdays" }]);
		expect(role!.settings.reportCounts).toEqual(["upgradable", "applied", "left", "restarts", "raised"]);
	});

	it("carries the /tmp watch: mode 1777, checked at least every minute", async () => {
		const { disabled } = await loadRoles({ rolesRoot: repoRoles, stateDir: "/tmp/sr-state" });
		const role = disabled.find((candidate) => candidate.name === "system-updates");
		const watch = role!.settings.watches?.find((candidate) => candidate.name === "tmp-mode");
		expect(watch).toBeDefined();
		expect(watch!.command).toBe("stat -c %a /tmp");
		expect(watch!.expect).toBe("1777");
		expect(watch!.everySeconds).toBeGreaterThanOrEqual(60);
	});

	it("its instructions point at the three reference docs, and those docs exist", async () => {
		const instructions = await readFile(`${roleDir}instructions.md`, "utf8");
		for (const name of ["UPDATES.md", "DISK.md", "SERVICES.md"]) {
			expect(instructions).toContain(name);
			await readFile(`${roleDir}${name}`, "utf8"); // throws when missing
		}
	});

	it("the references keep the safety rails: never reboot, restarts through the tool only, never delete", async () => {
		const instructionsRef = () => readFile(`${roleDir}instructions.md`, "utf8");
		const updates = await readFile(`${roleDir}UPDATES.md`, "utf8");
		expect(updates).toContain("never — hold, and remind");
		expect((await instructionsRef())).toContain("Never reboot");
		expect(updates).toContain("bin/flush-restart");
		const disk = await readFile(`${roleDir}DISK.md`, "utf8");
		expect(disk).toContain("Never delete anything yourself");
		const services = await readFile(`${roleDir}SERVICES.md`, "utf8");
		expect(services).toContain("Never critical infrastructure");
	});
});
