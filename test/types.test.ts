import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("role defaults", () => {
	it("the shipped default model is a real, well-known example (set your own in roles/defaults.json)", () => {
		const d = JSON.parse(readFileSync(new URL("../roles/defaults.json", import.meta.url), "utf8"));
		expect(d.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
	});
});
