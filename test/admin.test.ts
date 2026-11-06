import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { UserEntry } from "@earendil-works/pi-durable";
import { noOpPlumbing, openRoleHost, type RoleHost } from "../src/harness.ts";
import { startAdmin, type AdminResponse } from "../src/admin.ts";
import { loadRoles } from "../src/roles.ts";
import { makeFauxHostModels, makeStateDir, writeRolesTree } from "./helpers.ts";

const context = BACKGROUND_CONTEXT;
const roots: string[] = [];

afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

function request(socketPath: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: AdminResponse }> {
	return new Promise((resolve, reject) => {
		void import("node:http").then(({ request: httpRequest }) => {
			const data = body === undefined ? undefined : JSON.stringify(body);
			const req = httpRequest(
				{ socketPath, path, method, headers: data === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(data) } },
				(res) => {
					let text = "";
					res.on("data", (chunk: Buffer) => (text += chunk.toString()));
					res.on("end", () => {
						try {
							resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) as AdminResponse });
						} catch (error) {
							reject(error);
						}
					});
				},
			);
			req.on("error", reject);
			if (data !== undefined) req.write(data);
			req.end();
		});
	});
}

async function setup() {
	const stateDir = await makeStateDir();
	const rolesRoot = join(await mkdtemp(join(tmpdir(), "sr-admin-")), "roles");
	roots.push(rolesRoot, stateDir);
	await writeRolesTree(rolesRoot, [{ name: "alpha", schedule: [{ at: "09:00", days: "daily" }] }, { name: "sleepy", enabled: false }]);
	const { enabled, disabled } = await loadRoles({ rolesRoot, stateDir });
	const { hostModels, defaultModel } = makeFauxHostModels();
	const host = await openRoleHost({
		dbPath: join(stateDir, "roles.db"),
		stateDir,
		roles: enabled,
		defaultModel,
		hostModels,
		plumbing: noOpPlumbing(),
	});
	const statuses = new Map<string, Record<string, unknown>>();
	const admin = await startAdmin({
		host,
		stateDir,
		rolesRoot,
		disabled: () => disabled,
		statuses: () => statuses,
		onReload: async () => {
			const reloaded = await loadRoles({ rolesRoot, stateDir });
			await host.applyRoles(reloaded.enabled);
			return reloaded;
		},
	});
	return { host, stateDir, rolesRoot, admin, statuses };
}

describe("startAdmin + bin/roles", () => {
	it("listens on <stateDir>/admin.sock with mode 0600 and answers GET /status for all roles", async () => {
		const { host, stateDir, admin } = await setup();
		try {
			const info = await stat(join(stateDir, "admin.sock"));
			expect(info.mode & 0o777).toBe(0o600);
			const { status, json } = await request(admin.path, "GET", "/status");
			expect(status).toBe(200);
			const roles = json.roles as Array<Record<string, unknown>>;
			expect(roles.map((role) => role.role)).toEqual(["alpha", "sleepy"]);
			expect(roles[0]).toMatchObject({ enabled: true, boardName: "role-alpha" });
			expect(roles[1]).toMatchObject({ role: "sleepy", enabled: false });
		} finally {
			await admin.stop();
			await host.close();
		}
	});

	it("POST /run submits a manual run to the right role with id <role>:manual:<iso>", async () => {
		const { host, admin } = await setup();
		try {
			const { status, json } = await request(admin.path, "POST", "/run", { role: "alpha" });
			expect(status).toBe(202);
			expect(String(json.runId)).toMatch(/^alpha:manual:\d{4}-\d{2}-\d{2}T/);
			await (await host.conversation("alpha"))!.waitForIdle(context);
			const conversation = await host.conversation("alpha");
			const entries = await conversation!.entries({ order: "ascending" }, 100, undefined, context);
			const user = entries.items.find((entry) => UserEntry.is(entry));
			expect(JSON.stringify(user?.model?.[0])).toContain("Scheduled run manual.");
		} finally {
			await admin.stop();
			await host.close();
		}
	});

	it("POST /chat delivers a framed owner message to the right role; an unknown role is 404", async () => {
		const { host, admin } = await setup();
		try {
			const ok = await request(admin.path, "POST", "/chat", { role: "alpha", text: "good morning" });
			expect(ok.status).toBe(202);
			await (await host.conversation("alpha"))!.waitForIdle(context);
			const conversation = await host.conversation("alpha");
			const entries = await conversation!.entries({ order: "ascending" }, 100, undefined, context);
			const user = entries.items.find((entry) => UserEntry.is(entry));
			expect(JSON.stringify(user?.model?.[0])).toContain("Message from the owner (via cli): good morning");

			const bad = await request(admin.path, "POST", "/chat", { role: "nope", text: "x" });
			expect(bad.status).toBe(404);
			const badRun = await request(admin.path, "POST", "/run", { role: "nope" });
			expect(badRun.status).toBe(404);
		} finally {
			await admin.stop();
			await host.close();
		}
	});

	it("POST /reload re-reads roles/ and re-applies settings (a model change takes effect)", async () => {
		const { host, stateDir, rolesRoot, admin } = await setup();
		try {
			await writeFile(
				join(rolesRoot, "defaults.json"),
				JSON.stringify({ model: { provider: "faux", modelId: "m-2" }, thinking: "high" }),
				"utf8",
			);
			const { status } = await request(admin.path, "POST", "/reload");
			expect(status).toBe(200);
			const conversation = await host.conversation("alpha");
			const agent = await conversation!.agent(context);
			expect(agent.model).toEqual({ provider: "faux", modelId: "m-2" });
			void stateDir;
		} finally {
			await admin.stop();
			await host.close();
		}
	});

	// The tasks/retry routes are retired: Pi Durable 1.5 no longer parks tasks,
	// so there is nothing to list and nothing to un-park. Both answer the plain no-route 404.
	it("the retired tasks/retry routes are gone: both answer 404 no route", async () => {
		const { host, stateDir, rolesRoot, admin: baseAdmin } = await setup();
		await baseAdmin.stop();
		const admin = await startAdmin({ host, stateDir, rolesRoot });
		try {
			const listed = await request(admin.path, "GET", "/tasks");
			expect(listed.status).toBe(404);
			expect(listed.json.error).toContain("no route: GET /tasks");

			const retried = await request(admin.path, "POST", "/retry", { taskId: "task-parked" });
			expect(retried.status).toBe(404);
			expect(retried.json.error).toContain("no route: POST /retry");
		} finally {
			await admin.stop();
			await host.close();
		}
	});

	it("bin/roles speaks to the socket: status, run, chat, reload", async () => {
		const { host, stateDir, admin } = await setup();
		try {
			const env = { ...process.env, STANDING_ROLES_STATE_DIR: stateDir };
			const bin = join(new URL("..", import.meta.url).pathname, "bin", "roles");
			// Async exec: the worker's event loop must stay free to answer the CLI.
			const out = async (args: string[]): Promise<unknown> => {
				const stdout = await new Promise<string>((resolve, reject) =>
					execFile(process.execPath, [bin, ...args], { env, encoding: "utf8" }, (error, stdout) =>
						error === null || error === undefined ? resolve(stdout) : reject(error),
					),
				);
				return JSON.parse(stdout) as unknown;
			};
			const listed = (await out(["status"])) as { roles: Array<{ role: string }> };
			expect(listed.roles.map((role) => role.role)).toEqual(["alpha", "sleepy"]);
			expect(await out(["run", "alpha"])).toMatchObject({ runId: expect.stringMatching(/^alpha:manual:/) });
			expect(await out(["chat", "alpha", "hello", "from", "the", "cli"])).toMatchObject({ ok: true });
			expect(await out(["reload"])).toMatchObject({ ok: true });
			// The retired tasks/retry verbs are usage errors now:
			// the CLI no longer maps them to a route.
			const retired = await new Promise<{ code: number | undefined; stderr: string }>((resolve) => {
				execFile(process.execPath, [bin, "tasks"], { env, encoding: "utf8" }, (error, _stdout, stderr) =>
					resolve({ code: (error as { code?: number } | null)?.code, stderr }),
				);
			});
			expect(retired.code).not.toBe(0);
			expect(retired.stderr).toContain("usage:");
			await (await host.conversation("alpha"))!.waitForIdle(context);
		} finally {
			await admin.stop();
			await host.close();
		}
	});
});
