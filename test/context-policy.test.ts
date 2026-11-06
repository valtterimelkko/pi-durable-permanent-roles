import { describe, expect, it } from "vitest";
import { COMPACT_AT_DEFAULT, clampCompactAt, compactAtTokensFor, compactionPolicyFor } from "../src/context-policy.ts";

describe("compaction policy (S7: compact at half the window)", () => {
	it("default fraction is 0.5", () => {
		expect(COMPACT_AT_DEFAULT).toBe(0.5);
	});

	it("a 1,000,000-token window starts background compaction at 500,000 tokens", () => {
		const policy = compactionPolicyFor(1_000_000);
		expect(compactAtTokensFor(1_000_000, policy)).toBe(500_000);
		expect(policy.enabled).toBe(true);
	});

	it("the blocking point stays inside the window", () => {
		const policy = compactionPolicyFor(1_000_000);
		expect(1_000_000 - policy.reserveTokens).toBe(900_000);
		expect(policy.backgroundTokens).toBe(400_000);
	});

	it("keeps recent context and the answer reserve", () => {
		const policy = compactionPolicyFor(1_000_000);
		expect(policy.reserveTokens).toBe(100_000);
		expect(policy.keepRecentTokens).toBe(50_000);
	});

	it("clamps the fraction into 0.5–0.9 and falls back to 0.5", () => {
		expect(clampCompactAt(0.3)).toBe(0.5);
		expect(clampCompactAt(0.95)).toBe(0.9);
		expect(clampCompactAt(0.75)).toBe(0.75);
		expect(clampCompactAt(undefined)).toBe(0.5);
		expect(clampCompactAt("junk")).toBe(0.5);
	});

	it("an unknown window (0) disables background compaction instead of guessing", () => {
		const policy = compactionPolicyFor(0);
		expect(policy.backgroundTokens).toBe(0);
		expect(compactAtTokensFor(0, policy)).toBe(0);
	});
});
