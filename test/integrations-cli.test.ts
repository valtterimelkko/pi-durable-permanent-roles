/** The CLI adapter over the protocol, and the defensive parsers for claim and list output. */
import { describe, expect, it } from "vitest";
import { createCliIntegrations, createCliRunner, parseClaimOutput, parseListedMessages } from "../src/integrations/cli.ts";
import type { CliResult, ExternalCli } from "../src/integrations/types.ts";

function fakeCli(script: Array<{ argv: string[]; answer: CliResult }>): { cli: ExternalCli; calls: string[][] } {
	const calls: string[][] = [];
	return {
		calls,
		cli: {
			run: async (argv) => {
				calls.push([...argv]);
				const hit = script.find((entry) => entry.argv.join(" ") === argv.join(" "));
				return hit?.answer ?? { code: 0, stdout: "", stderr: "" };
			},
		},
	};
}

describe("parseClaimOutput", () => {
	it("reads the documented shape and drops unusable rows", () => {
		expect(parseClaimOutput(`{"messages":[{"id":"m-1","content":"hello"},{"id":"","content":"x"},{"id":"m-3"},{"nonsense":1}]}`)).toEqual([
			{ id: "m-1", content: "hello" },
		]);
	});

	it("answers no messages for malformed output rather than crashing", () => {
		expect(parseClaimOutput("not json at all")).toEqual([]);
		expect(parseClaimOutput('{"messages":"many"}')).toEqual([]);
		expect(parseClaimOutput("null")).toEqual([]);
	});
});

describe("parseListedMessages", () => {
	it("reads id/via/origin and drops unusable rows", () => {
		expect(parseListedMessages(`{"messages":[{"id":"m-9","via":"web-ui","origin":"chat"},{"id":"m-2"}]}`)).toEqual([
			{ id: "m-9", via: "web-ui", origin: "chat" },
			{ id: "m-2" },
		]);
		expect(parseListedOutputGarbage()).toEqual([]);
	});
});

function parseListedOutputGarbage(): unknown[] {
	return parseListedMessages("]broken[") as unknown as [];
}

describe("createCliIntegrations", () => {
	it("presence register runs the exact argv", async () => {
		const { cli, calls } = fakeCli([]);
		const integrations = createCliIntegrations(cli);
		expect(integrations.enabled).toBe(true);
		await integrations.presence.register({ name: "role-docs", title: "Docs", status: "working", step: "reading" });
		expect(calls[0]).toEqual(["presence", "register", "--name", "role-docs", "--title", "Docs", "--status", "working", "--step", "reading"]);
	});

	it("memory recall returns stdout and fails loudly on a non-zero exit", async () => {
		const { cli } = fakeCli([{ argv: ["memory", "recall", "--query", "q"], answer: { code: 0, stdout: "the answer\n", stderr: "" } }]);
		const integrations = createCliIntegrations(cli);
		await expect(integrations.memory.recall("q")).resolves.toBe("the answer\n");
		const failing = fakeCli([{ argv: ["memory", "recall", "--query", "q"], answer: { code: 3, stdout: "", stderr: "down" } }]);
		await expect(createCliIntegrations(failing.cli).memory.recall("q")).rejects.toThrow(/down/);
	});

	it("inbox claim parses the JSON answer, mark passes the exact argv", async () => {
		const { cli, calls } = fakeCli([
			{ argv: ["inbox", "claim", "--name", "role-docs", "--json"], answer: { code: 0, stdout: `{"messages":[{"id":"m-1","content":"hi"}]}`, stderr: "" } },
			{ argv: ["inbox", "mark", "--id", "m-1", "--event", "delivered"], answer: { code: 0, stdout: "", stderr: "" } },
		]);
		const integrations = createCliIntegrations(cli);
		await expect(integrations.inbox.claim("role-docs")).resolves.toEqual([{ id: "m-1", content: "hi" }]);
		await integrations.inbox.mark("role-docs", { id: "m-1", event: "delivered" });
		expect(calls[1]).toEqual(["inbox", "mark", "--id", "m-1", "--event", "delivered"]);
	});

	it("channel verbs run the exact argv and return stdout", async () => {
		const { cli, calls } = fakeCli([
			{ argv: ["channel", "reply", "--thread", "ch-1", "--from", "role-docs", "--text", "hi"], answer: { code: 0, stdout: "sent", stderr: "" } },
		]);
		const integrations = createCliIntegrations(cli);
		await expect(integrations.channel.reply({ thread: "ch-1", from: "role-docs", text: "hi" })).resolves.toBe("sent");
		expect(calls[0]).toEqual(["channel", "reply", "--thread", "ch-1", "--from", "role-docs", "--text", "hi"]);
	});
});

describe("createCliRunner", () => {
	it("runs a real command with argv, no shell, and reports its exit code", async () => {
		const runner = createCliRunner("echo");
		const result = await runner.run(["integration", "probe"]);
		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toBe("integration probe");
	});

	it("caps enormous output instead of holding it all", async () => {
		const runner = createCliRunner("head");
		const result = await runner.run(["-c", "40000", "/dev/zero"]);
		expect(result.stdout.length).toBeLessThanOrEqual(32_768 + 40);
	});
});
