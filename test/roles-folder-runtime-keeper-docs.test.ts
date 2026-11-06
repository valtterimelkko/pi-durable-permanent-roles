/** The runtime-keeper folder: the reference docs it points at, and the discipline they pin. */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const roleDir = new URL("../roles/runtime-keeper/", import.meta.url).pathname;

describe("the runtime-keeper folder", () => {
	it("instructions point at RUNTIMES.md and UPDATING.md, which exist", async () => {
		const instructions = await readFile(`${roleDir}instructions.md`, "utf8");
		for (const name of ["RUNTIMES.md", "UPDATING.md"]) {
			expect(instructions).toContain(name);
			await readFile(`${roleDir}${name}`, "utf8"); // throws when missing
		}
	});

	it("RUNTIMES.md keeps the shape: installed version, latest, changelog, upgrade, check after, restart", async () => {
		const runtimes = await readFile(`${roleDir}RUNTIMES.md`, "utf8");
		for (const field of ["Installed version", "Latest version", "Changelog", "Upgrade", "Check after", "Restart"]) {
			expect(runtimes).toContain(field);
		}
	});

	it("restarts go through bin/flush-restart only, and the own-host rule is stated", async () => {
		const instructions = await readFile(`${roleDir}instructions.md`, "utf8");
		expect(instructions).toContain("bin/flush-restart");
		expect(instructions).toContain("a role never restarts its own host");
		const runtimes = await readFile(`${roleDir}RUNTIMES.md`, "utf8");
		expect(runtimes).toContain("bin/flush-restart");
	});

	it("UPDATING.md demands the changelog every time and the proof before a production restart", async () => {
		const updating = await readFile(`${roleDir}UPDATING.md`, "utf8");
		expect(updating).toContain("Read the changelog every time");
		expect(updating).toContain("The proof before a production restart");
	});
});
