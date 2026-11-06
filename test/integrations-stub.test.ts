/** The stub integration: works with no external system, off by default. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { appendCaptureRecord, createStubIntegrations, hasCaptureRecords } from "../src/integrations/stub.ts";
import { STUB_NOTICE } from "../src/integrations/types.ts";

const dir = await mkdtemp(join(tmpdir(), "stub-"));

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("the stub integrations", () => {
	it("reports disabled", () => {
		expect(createStubIntegrations(dir).enabled).toBe(false);
	});

	it("answers a recall with the not-configured notice, never an empty answer", async () => {
		const integrations = createStubIntegrations(dir);
		await expect(integrations.memory.recall("anything")).resolves.toBe(STUB_NOTICE);
	});

	it("appends each capture as one JSON line under <stateDir>/integrations/", async () => {
		const integrations = createStubIntegrations(dir);
		await integrations.memory.capture({ note: "kept the decision", idempotencyKey: "fake-key-not-real" });
		await integrations.memory.capture({ note: "kept another", idempotencyKey: "fake-key-not-real-2" });
		expect(hasCaptureRecords(dir)).toBe(true);
		const text = await readFile(join(dir, "integrations", "memory-captures.jsonl"), "utf8");
		const lines = text.trim().split("\n");
		expect(lines).toHaveLength(2);
		const first = JSON.parse(lines[0]!) as { at: string; note: string; idempotencyKey: string };
		expect(first.note).toBe("kept the decision");
		expect(first.idempotencyKey).toBe("fake-key-not-real");
		expect(first.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(await appendCaptureRecord(dir, { note: "n", idempotencyKey: "fake-key-not-real" })).toContain("memory-captures.jsonl");
	});

	it("claims no messages and accepts marks silently", async () => {
		const integrations = createStubIntegrations(dir);
		await expect(integrations.inbox.claim("role-docs")).resolves.toEqual([]);
		await expect(integrations.inbox.listClaimed("role-docs")).resolves.toEqual([]);
		await expect(integrations.inbox.mark("role-docs", { id: "m-1", event: "delivered" })).resolves.toBeUndefined();
		expect(integrations.inbox.hasPending?.("role-docs")).toBe(false);
	});

	it("registers presence nowhere and refuses channel calls with the notice", async () => {
		const integrations = createStubIntegrations(dir);
		await expect(integrations.presence.register({ name: "r", title: "t", status: "working", step: "s" })).resolves.toBeUndefined();
		await expect(integrations.channel.reply({ thread: "ch-1", from: "r", text: "x" })).rejects.toThrow(STUB_NOTICE);
		await expect(integrations.channel.askOwner({ thread: "ch-1", from: "r", text: "x" })).rejects.toThrow(STUB_NOTICE);
		await expect(integrations.channel.close({ thread: "ch-1", from: "r", text: "x" })).rejects.toThrow(STUB_NOTICE);
	});
});
