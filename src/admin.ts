/**
 * The admin socket: `<state>/admin.sock`, mode 0600, the CLI's path into a
 * running host. GET /status (all roles' status), POST /run {role} (submit a run now, id
 * `<role>:manual:<iso>`), POST /chat {role, text} (submit "Message from the owner (via
 * cli): …"), POST /reload (re-read roles/ and re-apply settings).
 * No auth: local unix socket, operator-only by file mode.
 */
import { chmodSync, existsSync, rmSync } from "node:fs";
import { createServer, type RequestListener } from "node:http";
import type { Server } from "node:http";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { RoleHost } from "./harness.ts";
import { DEFAULT_RUN_PROMPT } from "./schedules.ts";
import type { RoleDefinition } from "./types.ts";

export type AdminResponse = {
	roles?: Array<Record<string, unknown>>;
	runId?: string;
	ok?: boolean;
	error?: string;
	enabled?: number;
	disabled?: number;
	problems?: string[];
};

export type AdminServer = {
	path: string;
	stop(): Promise<void>;
};

function readBody(request: import("node:http").IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let text = "";
		request.on("data", (chunk: Buffer) => (text += chunk.toString()));
		request.on("end", () => resolve(text));
		request.on("error", reject);
	});
}

export async function startAdmin(options: {
	host: RoleHost;
	stateDir: string;
	/** Where roles/ lives, for /reload. */
	rolesRoot: string;
	/** The disabled roles of the last load, for /status. */
	disabled?: () => readonly RoleDefinition[];
	/** The mirror's live statuses, by role name. */
	statuses?: () => Map<string, Record<string, unknown>>;
	/** The full reload; returns what loadRoles found, reported in the response. */
	onReload?: () => Promise<{ enabled: RoleDefinition[]; disabled: RoleDefinition[]; problems: string[] }>;
	context?: Context;
}): Promise<AdminServer> {
	const context = options.context ?? BACKGROUND_CONTEXT;
	const socketPath = join(options.stateDir, "admin.sock");
	if (existsSync(socketPath)) rmSync(socketPath);

	const handler: RequestListener = (request, response) => {
		const reply = (status: number, json: AdminResponse): void => {
			response.statusCode = status;
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify(json));
		};
		const url = new URL(request.url ?? "/", "http://admin");
		void (async () => {
			if (request.method === "GET" && url.pathname === "/status") {
				const statuses = options.statuses?.() ?? new Map<string, Record<string, unknown>>();
				const roles: Array<Record<string, unknown>> = options.host.roles().map((role) => ({
					role: role.name,
					title: role.settings.title,
					enabled: true,
					boardName: role.settings.boardName,
					...(statuses.get(role.name) ?? {}),
				}));
				for (const role of options.disabled?.() ?? []) {
					roles.push({ role: role.name, title: role.settings.title, enabled: false, boardName: role.settings.boardName });
				}
				reply(200, { roles });
				return;
			}
			if (request.method === "POST" && (url.pathname === "/run" || url.pathname === "/chat")) {
				const body = JSON.parse((await readBody(request)) || "{}") as { role?: string; text?: string };
				const roleName = body.role ?? "";
				const role = options.host.roles().find((candidate) => candidate.name === roleName);
				if (role === undefined) {
					reply(404, { error: `unknown role: ${roleName}` });
					return;
				}
				const iso = new Date().toISOString();
				if (url.pathname === "/run") {
					const runId = `${roleName}:manual:${iso}`;
					await options.host.submit(roleName, {
						content: `Scheduled run manual. ${role.settings.runPrompt ?? DEFAULT_RUN_PROMPT}`,
						requestId: `run:${runId}`,
						step: runId,
					});
					reply(202, { runId });
					return;
				}
				const text = (body.text ?? "").trim();
				if (text === "") {
					reply(400, { error: "chat needs a non-empty text" });
					return;
				}
				await options.host.submit(roleName, {
					content: `Message from the owner (via cli): ${text}`,
					requestId: `chat:${roleName}:${iso}`,
					step: `chat:${iso}`,
				});
				reply(202, { ok: true });
				return;
			}
			if (request.method === "POST" && url.pathname === "/reload") {
				if (options.onReload === undefined) {
					reply(500, { error: "no reload wiring in this process" });
					return;
				}
				const reloaded = await options.onReload();
				reply(200, { ok: true, enabled: reloaded.enabled.length, disabled: reloaded.disabled.length, problems: reloaded.problems });
				return;
			}
			reply(404, { error: `no route: ${request.method} ${url.pathname}` });
		})().catch((error) => {
			reply(500, { error: error instanceof Error ? error.message : String(error) });
		});
	};

	const server: Server = createServer(handler);
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	chmodSync(socketPath, 0o600);
	void context;
	return {
		path: socketPath,
		stop: async () => {
			await new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error))));
			if (existsSync(socketPath)) rmSync(socketPath);
		},
	};
}
