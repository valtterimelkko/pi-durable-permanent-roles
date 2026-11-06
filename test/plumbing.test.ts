/** The plumbing: the tool groups it installs, the presence heartbeat, the carrier, the outbox, and stub mode. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { describe, expect, it } from "vitest";
import type { HostApi, RoleDefinition, RoleSettings } from "../src/types.ts";
import { createCliIntegrations, createCliRunner } from "../src/integrations/cli.ts";
import { createStubIntegrations } from "../src/integrations/stub.ts";
import { createPlumbing } from "../src/plumbing.ts";
import type { CliResult } from "../src/integrations/types.ts";

const context: Context = BACKGROUND_CONTEXT;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.reverse()) await cleanup();
	cleanups.length = 0;
});

function role(name: string, overrides: Partial<RoleSettings> = {}): RoleDefinition {
	return {
		name,
		dir: `/srv/roles/${name}`,
		settings: {
			enabled: true,
			title: `${name} title`,
			boardName: `role-${name}`,
			schedule: [],
			cwd: `/srv/roles/${name}`,
			tools: ["integrations", "notify"],
			...overrides,
		},
		model: { provider: "faux", modelId: "m-1" },
		thinking: "high",
		instructions: "",
		notesDir: `/var/lib/roles/roles/${name}/notes`,
	};
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition never became true");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

interface Rig {
	plumbing: ReturnType<typeof createPlumbing>;
	harness: Harness;
	host: HostApi;
	calls: string[][];
	submitted: Array<{ roleName: string; content: string; requestId: string }>;
	conversationId: string;
	claims: string[];
}

async function rig(options: {
	roles: RoleDefinition[];
	claimOnce?: Array<{ id: string; content: string }>;
	carrierIntervalMs?: number;
	heartbeatIntervalMs?: number;
}): Promise<Rig> {
	const harness = await Harness.open(
		new MemoryStorage(),
		{ models: createModels(), registry: createRegistry() },
		context,
	);
	const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
	const calls: string[][] = [];
	const claims: string[] = [];
	let claimCount = 0;
	const cli = {
		async run(argv: readonly string[]): Promise<CliResult> {
			calls.push([...argv]);
			if (argv[1] === "claim") {
				claimCount += 1;
				const messages = claimCount === 1 ? (options.claimOnce ?? []) : [];
				claims.push(...messages.map((message) => message.id));
				return { code: 0, stdout: JSON.stringify({ messages }), stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		},
	};
	const submitted: Array<{ roleName: string; content: string; requestId: string }> = [];
	const host = {
		harness,
		roles: () => options.roles,
		roleForConversation: (id: string) => (id === String(conversation.id) ? options.roles[0] : undefined),
		currentSlot: () => undefined,
		async submit(roleName: string, input: { content: string; requestId: string }): Promise<void> {
			submitted.push({ roleName, ...input });
		},
	} as unknown as HostApi;
	const plumbing = createPlumbing({
		integrations: createCliIntegrations(cli),
		integrationsCli: cli,
		notify: async () => undefined,
		carrierIntervalMs: options.carrierIntervalMs ?? 60_000,
		heartbeatIntervalMs: options.heartbeatIntervalMs ?? 60_000,
	});
	await plumbing.start(host);
	cleanups.push(async () => {
		await plumbing.stop();
		await harness.close(context);
	});
	return { plumbing, harness, host, calls, submitted, conversationId: String(conversation.id), claims };
}

function presenceCalls(calls: string[][]): string[][] {
	return calls.filter((argv) => argv[0] === "presence" && argv[1] === "register");
}

function flag(argv: readonly string[], name: string): string | undefined {
	const index = argv.indexOf(name);
	return index === -1 ? undefined : argv[index + 1];
}

describe("the extensions the host installs", () => {
	it("offers the integrations group, the notify group and the task definitions", () => {
		const plumbing = createPlumbing({
			integrations: createStubIntegrations(),
			notify: async () => undefined,
		});
		const extensions = plumbing.extensions();
		expect(extensions.integrations.name).toBe("pi-roles-integrations");
		expect(extensions.integrations.tools?.map((tool) => tool.name).sort()).toEqual(
			[
				"memory_capture",
				"memory_recall",
				"peer_ask_owner",
				"peer_reply",
				"peer_thread_close",
			].sort(),
		);
		expect(extensions.notify.tools?.map((tool) => tool.name)).toEqual([
			"notify_owner",
			"raise_item",
			"resolve_item",
			"report_run",
		]);
		expect(extensions.tasks.map((extension) => extension.name)).toEqual(["pi-roles-notify-tasks"]);
	});
});

describe("starting (CLI mode)", () => {
	it("registers every enabled role's presence as waiting/idle and leaves disabled roles off", async () => {
		const rigged = await rig({
			roles: [role("docs"), role("system-updates", { enabled: false })],
		});
		await waitFor(() => presenceCalls(rigged.calls).length >= 1);
		const cards = presenceCalls(rigged.calls);
		const names = cards.map((argv) => flag(argv, "--name"));
		expect(names).toEqual(["role-docs"]);
		expect(flag(cards[0]!, "--status")).toBe("waiting");
		expect(flag(cards[0]!, "--step")).toBe("idle");
		expect(flag(cards[0]!, "--title")).toBe("docs title");
		expect(cards[0]!.join(" ")).not.toContain("role-system-updates");
	});

	it("refreshPresenceCards queues the card for every enabled role at once, as start does", async () => {
		const docs = role("docs");
		const keeper = role("runtime-keeper");
		const off = role("system-updates", { enabled: false });
		const rigged = await rig({ roles: [docs, keeper, off], heartbeatIntervalMs: 3_600_000 });
		await waitFor(() => presenceCalls(rigged.calls).length >= 2);
		const afterStart = presenceCalls(rigged.calls).length;
		rigged.plumbing.refreshPresenceCards();
		await waitFor(() => presenceCalls(rigged.calls).length >= afterStart + 2);
		const recent = presenceCalls(rigged.calls).slice(-2).map((argv) => flag(argv, "--name"));
		expect(new Set(recent)).toEqual(new Set(["role-docs", "role-runtime-keeper"]));
		// A disabled role still gets no card, at reload just as at start.
		expect(presenceCalls(rigged.calls).some((argv) => flag(argv, "--name") === "role-system-updates")).toBe(false);
	});

	it("starts the carrier and delivers a claimed message into the role's conversation, then marks it", async () => {
		const docs = role("docs");
		const rigged = await rig({
			roles: [docs],
			carrierIntervalMs: 20,
			claimOnce: [{ id: "ib-1", content: "check the carrier" }],
		});
		await waitFor(() => rigged.submitted.length === 1);
		expect(rigged.submitted[0]).toEqual({
			roleName: "docs",
			content: "check the carrier",
			requestId: "inbox:ib-1",
		});
		await waitFor(() =>
			rigged.calls.some(
				(argv) => argv[1] === "mark" && flag(argv, "--id") === "ib-1" && flag(argv, "--event") === "delivered",
			),
		);
		const claim = rigged.calls.find((argv) => argv[1] === "claim")!;
		expect(claim).toEqual(["inbox", "claim", "--name", "role-docs", "--json"]);
	});

	it("re-registers the card as working when a run starts and waiting when it ends", async () => {
		const docs = role("docs");
		const rigged = await rig({ roles: [docs] });
		await waitFor(() => presenceCalls(rigged.calls).length >= 1);
		rigged.plumbing.runStarted(docs, "reading the plans");
		await waitFor(() => presenceCalls(rigged.calls).some((argv) => flag(argv, "--status") === "working"));
		const working = presenceCalls(rigged.calls).find((argv) => flag(argv, "--status") === "working")!;
		expect(flag(working, "--step")).toBe("reading the plans");
		rigged.plumbing.runEnded(docs);
		await waitFor(() => presenceCalls(rigged.calls).filter((argv) => flag(argv, "--step") === "idle").length >= 2);
	});
});

describe("the heartbeat", () => {
	it("re-registers every enabled role with its current status", async () => {
		const docs = role("docs");
		const keeper = role("runtime-keeper");
		const rigged = await rig({ roles: [docs, keeper], heartbeatIntervalMs: 20 });
		rigged.plumbing.runStarted(keeper, "checking the rollout");
		await waitFor(() => presenceCalls(rigged.calls).length >= 4);
		const recent = presenceCalls(rigged.calls).slice(-2).map((argv) => flag(argv, "--name"));
		expect(new Set(recent)).toEqual(new Set(["role-docs", "role-runtime-keeper"]));
		const keeperCards = presenceCalls(rigged.calls).filter((argv) => flag(argv, "--name") === "role-runtime-keeper");
		expect(keeperCards.some((argv) => flag(argv, "--status") === "working")).toBe(true);
		expect(keeperCards.some((argv) => flag(argv, "--status") === "waiting")).toBe(true);
	});
});

describe("the outbox carries a tool's capture", () => {
	it("queues memory_capture through the durable outbox and delivers it once", async () => {
		const docs = role("docs");
		const rigged = await rig({ roles: [docs] });
		const tool = rigged.plumbing.extensions().integrations.tools?.find((candidate) => candidate.name === "memory_capture");
		expect(tool).toBeDefined();
		const api = {
			conversationId: rigged.conversationId,
			commit: (change: (tx: never) => unknown, ctx: Context) => rigged.harness.commit(change as never, ctx),
		};
		const result = await tool!.execute(
			{ note: "Decision: the carrier claims under the role's own name." } as never,
			api as never,
			context,
		);
		const content = (result.output as Array<{ text: string }>)[0]!.text;
		expect(JSON.parse(content)).toMatchObject({ status: "queued" });
		await waitFor(() => rigged.calls.some((argv) => argv[0] === "memory"));
		const capture = rigged.calls.find((argv) => argv[0] === "memory")!;
		expect(capture[1]).toBe("capture");
		expect(flag(capture, "--note")).toBe("Decision: the carrier claims under the role's own name.");
		const key = flag(capture, "--idempotency-key")!;
		expect(key).toMatch(/^[0-9a-f]{16}$/);
		// A second call with the same note dedupes at the outbox: exactly one delivery, one idempotency key.
		await tool!.execute({ note: "Decision: the carrier claims under the role's own name." } as never, api as never, context);
		await new Promise((resolve) => setTimeout(resolve, 300));
		const memoryCalls = rigged.calls.filter((argv) => argv[0] === "memory");
		expect(memoryCalls).toHaveLength(1);
		expect(new Set(memoryCalls.map((argv) => flag(argv, "--idempotency-key")))).toEqual(new Set([key]));
	});
});

describe("stub mode", () => {
	it("starts no loops, queues nothing, and the capture lands in the state directory's JSONL file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "plumbing-stub-"));
		cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
		process.env.STANDING_ROLES_STATE_DIR = dir;
		cleanups.push(async (): Promise<void> => { delete process.env.STANDING_ROLES_STATE_DIR; });
		const docs = role("docs");
		const plumbing = createPlumbing({
			integrations: createStubIntegrations(dir),
			notify: async () => undefined,
		});
		const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, context);
		const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		await plumbing.start({
			harness,
			roles: () => [docs],
			roleForConversation: (id: string) => (id === String(conversation.id) ? docs : undefined),
			currentSlot: () => undefined,
			submit: async () => undefined,
		} as unknown as HostApi);
		const tool = plumbing.extensions().integrations.tools?.find((candidate) => candidate.name === "memory_capture");
		const result = await tool!.execute(
			{ note: "captured locally" } as never,
			{
				conversationId: conversation.id,
				commit: (change: (tx: never) => unknown, ctx: Context) => harness.commit(change as never, ctx),
			} as never,
			context,
		);
		const content = JSON.parse((result.output as Array<{ text: string }>)[0]!.text) as { status: string };
		expect(content.status).toBe("queued");
		const file = join(dir, "integrations", "memory-captures.jsonl");
		const record = JSON.parse(readFileSync(file, "utf8")) as { note: string };
		expect(record.note).toBe("captured locally");
		await plumbing.stop();
		await harness.close(context);
	});

	it("the real CLI runner shells nothing: a command runs with argv and reports its exit code", async () => {
		const runner = createCliRunner("true");
		const result = await runner.run(["any", "argv"]);
		expect(result.code).toBe(0);
		const failing = createCliRunner("false");
		const failed = await failing.run(["any"]);
		expect(failed.code).not.toBe(0);
	});
});
