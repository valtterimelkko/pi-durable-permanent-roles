/**
 * Golden argv for every integration CLI call. A change here is a change to the protocol a real integration
 * implements and must be deliberate (docs/ADOPTING.md documents the protocol these lines freeze).
 */
import { describe, expect, it } from "vitest";
import {
	buildChannelAskArgv,
	buildChannelCloseArgv,
	buildChannelReplyArgv,
	buildInboxClaimArgv,
	buildInboxListArgv,
	buildInboxMarkArgv,
	buildMemoryCaptureArgv,
	buildMemoryRecallArgv,
	buildPresenceRegisterArgv,
} from "../src/integrations/argv.ts";

describe("presence register", () => {
	it("carries the exact register argv", () => {
		expect(
			buildPresenceRegisterArgv({ name: "role-docs", title: "Docs keeper", status: "working", step: "reading the notes" }),
		).toEqual([
			"presence",
			"register",
			"--name",
			"role-docs",
			"--title",
			"Docs keeper",
			"--status",
			"working",
			"--step",
			"reading the notes",
		]);
	});

	it("refuses a flag-like name", () => {
		expect(() => buildPresenceRegisterArgv({ name: "--evil", title: "x", status: "working", step: "s" })).toThrow();
	});

	it("refuses an unknown status", () => {
		expect(() =>
			buildPresenceRegisterArgv({ name: "role-docs", title: "x", status: "idle" as never, step: "s" }),
		).toThrow(/status must be one of/);
	});
});

describe("memory", () => {
	it("recall builds the exact argv and refuses flag-like queries", () => {
		expect(buildMemoryRecallArgv("who approved the rollout")).toEqual(["memory", "recall", "--query", "who approved the rollout"]);
		expect(() => buildMemoryRecallArgv("--help")).toThrow(/cannot start with a dash/);
		expect(() => buildMemoryRecallArgv("")).toThrow(/is required/);
	});

	it("capture builds the exact argv with the idempotency key", () => {
		expect(buildMemoryCaptureArgv({ note: "kept the note", idempotencyKey: "fake-key-not-real" })).toEqual([
			"memory",
			"capture",
			"--note",
			"kept the note",
			"--idempotency-key",
			"fake-key-not-real",
		]);
	});
});

describe("inbox", () => {
	it("claim and list build the exact argv", () => {
		expect(buildInboxClaimArgv("role-docs")).toEqual(["inbox", "claim", "--name", "role-docs", "--json"]);
		expect(buildInboxListArgv("role-docs", "claimed")).toEqual(["inbox", "list", "--name", "role-docs", "--state", "claimed", "--json"]);
	});

	it("mark carries the event and the optional detail", () => {
		expect(buildInboxMarkArgv({ id: "m-1", event: "delivered" })).toEqual(["inbox", "mark", "--id", "m-1", "--event", "delivered"]);
		expect(buildInboxMarkArgv({ id: "m-1", event: "failed", detail: "submit failed: no conversation" })).toEqual([
			"inbox",
			"mark",
			"--id",
			"m-1",
			"--event",
			"failed",
			"--detail",
			"submit failed: no conversation",
		]);
		expect(() => buildInboxMarkArgv({ id: "m-1", event: "read" as never })).toThrow(/delivered\|failed/);
	});
});

describe("channel", () => {
	it("reply, ask and close build the exact argv", () => {
		expect(buildChannelReplyArgv({ thread: "ch-1", from: "role-docs", text: "done" })).toEqual([
			"channel",
			"reply",
			"--thread",
			"ch-1",
			"--from",
			"role-docs",
			"--text",
			"done",
		]);
		expect(buildChannelAskArgv({ thread: "ch-1", from: "role-docs", text: "which colour?" })).toEqual([
			"channel",
			"ask",
			"--thread",
			"ch-1",
			"--from",
			"role-docs",
			"--text",
			"which colour?",
		]);
		expect(buildChannelCloseArgv({ thread: "ch-1", from: "role-docs", text: "settled: blue" })).toEqual([
			"channel",
			"close",
			"--thread",
			"ch-1",
			"--from",
			"role-docs",
			"--text",
			"settled: blue",
		]);
	});

	it("refuses a thread id with whitespace or a leading dash", () => {
		expect(() => buildChannelReplyArgv({ thread: "two words", from: "r", text: "x" })).toThrow();
		expect(() => buildChannelReplyArgv({ thread: "-x", from: "r", text: "x" })).toThrow();
	});
});
