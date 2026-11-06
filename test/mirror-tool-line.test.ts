/**
 * Tool lines in the mirror: most stay a short summary, but what a role sends the owner — notify_owner and
 * raise_item — keeps its whole arguments, so the transcript shows the exact message without another log.
 */
import { describe, expect, it } from "vitest";
import { toolLine } from "../src/mirror.ts";

describe("toolLine", () => {
	it("keeps notify_owner and raise_item arguments whole", () => {
		const body = "b".repeat(3_000);
		for (const name of ["notify_owner", "raise_item"]) {
			const line = toolLine(name, { title: "Monday draft", body }, "sent");
			expect(line).toContain(body);
			expect(line.endsWith("→ sent")).toBe(true);
		}
	});

	it("caps any other tool's line as before", () => {
		const line = toolLine("bash", { command: "x".repeat(3_000) }, "r".repeat(3_000));
		expect(line.length).toBeLessThanOrEqual(400);
		expect(line.startsWith('bash: {"command":"xxx')).toBe(true);
	});
});
