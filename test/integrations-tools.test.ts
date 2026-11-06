/**
 * The `integrations` extension's tools: the memory read and capture, and the peer channel answers.
 *
 * Every call is one fixed verb reached through the pure argv builders, so model text can only land in a value slot; a
 * leading dash is refused. Memory output comes back labelled as UNTRUSTED data: it can quote other people and the
 * web, and it may contain text that looks like instructions. Captures never run inline — the deps decide the mode
 * (durable outbox in CLI mode, JSONL file in stub mode).
 */
import { describe, expect, it } from "vitest";
import type { ExternalCli } from "../src/integrations/types.ts";
import { INTEGRATIONS_READ_NOTICE, integrationsExtension, MAX_READ_CHARS } from "../src/integrations/tools.ts";

const conversationId = "11";

function role(boardName = "role-docs") {
	return { name: "docs", settings: { boardName } };
}

function recordingCli(stdout = "some integration output", code = 0, stderr = ""): { cli: ExternalCli; calls: string[][] } {
	const calls: string[][] = [];
	return {
		calls,
		cli: {
			async run(argv) {
				calls.push([...argv]);
				return { code, stdout, stderr };
			},
		},
	};
}

function setup(options: {
	stdout?: string;
	code?: number;
	stderr?: string;
	role?: { name: string; settings: { boardName: string } } | undefined;
	withCli?: boolean;
} = {}) {
	const recorder = recordingCli(options.stdout, options.code, options.stderr);
	const captures: Array<{ note: string; idempotencyKey: string; source: string }> = [];
	const channelCalls: Array<{ verb: string; thread: string; from: string; text: string }> = [];
	const extension = integrationsExtension({
		...(options.withCli === false ? {} : { cli: recorder.cli }),
		capture: async (input) => {
			captures.push(input);
		},
		channel: {
			reply: async (input) => {
				channelCalls.push({ verb: "reply", ...input });
				return "replied";
			},
			askOwner: async (input) => {
				channelCalls.push({ verb: "ask", ...input });
				return "asked";
			},
			close: async (input) => {
				channelCalls.push({ verb: "close", ...input });
				return "closed";
			},
		},
		roleForConversation: (id: string) => ("role" in options ? options.role : id === conversationId ? role() : undefined),
	});
	const tools = new Map((extension.tools ?? []).map((tool) => [tool.name, tool]));
	const call = async (name: string, args: Record<string, unknown>) =>
		(tools.get(name) as unknown as {
			execute(args: Record<string, unknown>, api: { conversationId: string }): Promise<{ output: Array<{ text: string }>; isError?: boolean }>;
		}).execute(args, { conversationId });
	const replyOf = async (name: string, args: Record<string, unknown>) =>
		JSON.parse((await call(name, args)).output[0]!.text) as Record<string, unknown>;
	return { recorder, captures, channelCalls, call, replyOf };
}

describe("memory_recall", () => {
	it("runs the exact argv and fences the answer as untrusted data", async () => {
		const { replyOf, recorder } = await setup({ stdout: "the remembered decision" });
		const answer = await replyOf("memory_recall", { query: "which colour did we pick" });
		expect(recorder.calls).toEqual([["memory", "recall", "--query", "which colour did we pick"]]);
		expect(answer.status).toBe("ok");
		expect(answer.notice).toBe(INTEGRATIONS_READ_NOTICE);
		expect(String(answer.content)).toContain("<untrusted_integration_output");
		expect(String(answer.content)).toContain("the remembered decision");
	});

	it("refuses a flag-like query before any command runs", async () => {
		const { replyOf, recorder } = await setup();
		const answer = await replyOf("memory_recall", { query: "--help" });
		expect(answer.status).toBe("refused");
		expect(recorder.calls).toHaveLength(0);
	});

	it("reports a failing command as an error with its stderr", async () => {
		const { replyOf } = await setup({ code: 2, stderr: "the memory is down" });
		const answer = await replyOf("memory_recall", { query: "q" });
		expect(answer.status).toBe("error");
		expect(answer.message).toBe("the memory is down");
	});

	it("cuts long answers and says so", async () => {
		const { replyOf } = await setup({ stdout: "x".repeat(MAX_READ_CHARS + 500) });
		const answer = await replyOf("memory_recall", { query: "q" });
		expect(answer.truncated).toBe(true);
	});

	it("answers unavailable when the stub mode is in force", async () => {
		const { replyOf } = await setup({ withCli: false });
		const answer = await replyOf("memory_recall", { query: "q" });
		expect(answer.status).toBe("unavailable");
	});
});

describe("memory_capture", () => {
	it("hands the capture to the mode's own path with a stable idempotency key", async () => {
		const { replyOf, captures } = await setup();
		const answer = await replyOf("memory_capture", { note: "kept the decision and why" });
		expect(answer.status).toBe("queued");
		expect(captures).toHaveLength(1);
		expect(captures[0]).toMatchObject({ note: "kept the decision and why", source: "role-docs" });
		expect(captures[0]!.idempotencyKey).toMatch(/^[0-9a-f]{16}$/);
	});

	it("keys the same note the same way (a replay is a duplicate, not a second capture)", async () => {
		const first = await setup();
		await first.replyOf("memory_capture", { note: "same note" });
		const second = await setup();
		await second.replyOf("memory_capture", { note: "same note" });
		expect(first.captures[0]!.idempotencyKey).toBe(second.captures[0]!.idempotencyKey);
	});

	it("refuses an empty note", async () => {
		const { replyOf, captures } = await setup();
		const answer = await replyOf("memory_capture", { note: "   " });
		expect(answer.status).toBe("refused");
		expect(captures).toHaveLength(0);
	});

	it("refuses a conversation that is not a role", async () => {
		const { replyOf, captures } = await setup({ role: undefined });
		const answer = await replyOf("memory_capture", { note: "kept" });
		expect(answer.status).toBe("refused");
		expect(captures).toHaveLength(0);
	});
});

describe("the peer channel tools", () => {
	it("peer_reply calls the channel as the role's presence name", async () => {
		const { replyOf, channelCalls } = await setup();
		const answer = await replyOf("peer_reply", { thread: "ch-9", text: "done and noted" });
		expect(answer.status).toBe("ok");
		expect(answer.output).toBe("replied");
		expect(channelCalls).toEqual([{ verb: "reply", thread: "ch-9", from: "role-docs", text: "done and noted" }]);
	});

	it("peer_ask_owner and peer_thread_close reach the same channel with their own verbs", async () => {
		const { replyOf, channelCalls } = await setup();
		await replyOf("peer_ask_owner", { thread: "ch-9", text: "which colour?" });
		await replyOf("peer_thread_close", { thread: "ch-9", text: "settled on blue" });
		expect(channelCalls.map((call) => call.verb)).toEqual(["ask", "close"]);
	});

	it("surfaces the stub's not-configured refusal as an error", async () => {
		const { replyOf } = await setup();
		// A channel call that throws (the stub's notice) reaches the role as an error reply.
		const failing = integrationsExtension({
			capture: async () => undefined,
			channel: {
				reply: async () => {
					throw new Error("No memory integration is configured.");
				},
				askOwner: async () => {
					throw new Error("No memory integration is configured.");
				},
				close: async () => {
					throw new Error("No memory integration is configured.");
				},
			},
			roleForConversation: (id: string) => (id === conversationId ? role() : undefined),
		});
		const tools = new Map((failing.tools ?? []).map((tool) => [tool.name, tool]));
		const result = await (tools.get("peer_reply") as unknown as {
			execute(args: Record<string, unknown>, api: { conversationId: string }): Promise<{ output: Array<{ text: string }>; isError?: boolean }>;
		}).execute({ thread: "ch-1", text: "x" }, { conversationId });
		expect(result.isError).toBe(true);
		expect(JSON.parse(result.output[0]!.text).message).toContain("No memory integration is configured.");
	});

	it("refuses a conversation that is not a role", async () => {
		const { replyOf, channelCalls } = await setup({ role: undefined });
		const answer = await replyOf("peer_reply", { thread: "ch-9", text: "x" });
		expect(answer.status).toBe("refused");
		expect(channelCalls).toHaveLength(0);
	});
});
