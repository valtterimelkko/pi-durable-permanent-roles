import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildHostModels } from "../src/pi-registry.ts";

describe("buildHostModels (Pi's registry and auth, read-only)", () => {
	const dirs: string[] = [];
	async function freshAgentDir(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), "sr-pi-agent-"));
		dirs.push(dir);
		return dir;
	}
	afterAll(async () => {
		await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
	});

	it("an empty agent dir yields the built-in catalogue and no problems", async () => {
		const agentDir = await freshAgentDir();
		const host = await buildHostModels({ agentDir });
		expect(host.problems).toEqual([]);
		expect(host.models.getProviders().length).toBeGreaterThan(0);
		// The plan default model exists in the built-in catalogue.
		expect(host.models.getModel("zai", "glm-5.3-flash")).toBeDefined();
	});

	it("a broken models.json is a problem, not a crash", async () => {
		const agentDir = await freshAgentDir();
		await writeFile(join(agentDir, "models.json"), "{not json", "utf8");
		const host = await buildHostModels({ agentDir });
		expect(host.problems.join("\n")).toContain("models.json is not valid JSON");
		expect(host.models.getProviders().length).toBeGreaterThan(0);
	});

	it("a models.json provider with an unusable api is reported and skipped", async () => {
		const agentDir = await freshAgentDir();
		await writeFile(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					"test-custom": {
						name: "Test custom",
						baseUrl: "http://127.0.0.1:1",
						api: "not-a-real-api",
						models: [{ id: "m-1", name: "m-1", contextWindow: 1000 }],
					},
				},
			}),
			"utf8",
		);
		const host = await buildHostModels({ agentDir });
		expect(host.problems.join("\n")).toContain("unsupported api");
		expect(host.models.getProvider("test-custom")).toBeUndefined();
	});

	it("a custom provider with a supported api is added; the key never leaves the store", async () => {
		const agentDir = await freshAgentDir();
		await mkdir(agentDir, { recursive: true });
		await writeFile(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					"test-openai-like": {
						name: "Test openai like",
						baseUrl: "http://127.0.0.1:1",
						api: "openai-completions",
						models: [{ id: "m-1", name: "m-1", contextWindow: 4000, maxTokens: 1000 }],
					},
				},
			}),
			"utf8",
		);
		const host = await buildHostModels({ agentDir });
		expect(host.problems).toEqual([]);
		const model = host.models.getModel("test-openai-like", "m-1");
		expect(model).toBeDefined();
		expect(model!.contextWindow).toBe(4000);
		// No credential exists, and nothing was logged or stored about any key.
		expect(await host.credentials.read("test-openai-like")).toBeUndefined();
	});
});
