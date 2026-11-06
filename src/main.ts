/**
 * The host process: one Node process — open the harness, resume, start
 * the mirror, the schedules and the watches (when enabled), the admin socket and the plumbing; an orderly,
 * bounded shutdown on SIGTERM (shutdown.ts). `startHost` takes the plumbing as a parameter
 * so tests pass a fake; production wiring goes through `loadPlumbing()`.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { ExternalCli, Plumbing } from "./types.ts";
import { createPlumbing } from "./plumbing.ts";
import { createCliIntegrations, createCliRunner } from "./integrations/cli.ts";
import { createStubIntegrations } from "./integrations/stub.ts";
import { jsonlNotifier, notifyCommandSender } from "./notify.ts";
import { loadConfig, type HostConfig } from "./config.ts";
import { noOpPlumbing, openRoleHost, type RoleHost } from "./harness.ts";
import { startAdmin, type AdminResponse, type AdminServer } from "./admin.ts";
import { startMirror, type Mirror } from "./mirror.ts";
import { loadRoles } from "./roles.ts";
import { startSchedulers, type Scheduler } from "./schedules.ts";
import { startWatches, type Watcher } from "./watches.ts";
import { createShutdown } from "./shutdown.ts";
import type { HostModels } from "./pi-registry.ts";
import { exitOnHarnessFailure } from "./harness-failure.ts";

export type HostService = {
	host: RoleHost;
	admin: AdminServer;
	scheduler: Scheduler | null;
	/** The watch trigger; runs only while schedules are on (the same switch). */
	watcher: Watcher | null;
	mirror: Mirror;
	plumbing: Plumbing;
	/** Submit a framed owner message (the admin /chat path). */
	chat(roleName: string, text: string): Promise<void>;
	/** Re-read roles/ and re-apply settings (the admin /reload path). */
	reload(): Promise<void>;
	/** All roles' status (the admin GET /status path). */
	status(): Promise<AdminResponse>;
	/** Orderly, bounded shutdown: timers, plumbing, admin socket, harness. */
	shutdown(signal: string): Promise<void>;
	/** shutdown("SIGTERM"). */
	stop(): Promise<void>;
};

export type StartHostOptions = {
	config: HostConfig;
	/** The plumbing; default loadPlumbing(config) — production passes its result here. */
	plumbing?: Plumbing;
	/** The model registry; production reads Pi's own. */
	hostModels?: HostModels;
	/** Injectable clock for the schedules and the mirror. */
	clock?: () => number;
	/** Schedule tick interval (default 60 s). */
	intervalMs?: number;
	/** Wire SIGTERM/SIGINT to the shutdown (production only; tests call shutdown directly). */
	signals?: boolean;
	/** The shutdown's exit function (production: process.exit). */
	exit?: (code: number) => void;
	context?: Context;
};

/**
 * The production plumbing: the integration adapter (CLI mode) or the stub (default), and the configured
 * owner-notification sender. STANDING_ROLES_INTEGRATIONS=on with a command gives the real adapter; anything else
 * gives the stub, which works with no external system and sends notifications to the state directory's JSONL file.
 */
export function loadPlumbing(config: HostConfig): Plumbing & { refreshPresenceCards?(): void } {
	const cliMode = config.integrations && config.integrationsCommand !== undefined;
	const notifier = config.notifyCommand !== undefined ? notifyCommandSender(config.notifyCommand) : jsonlNotifier(config.stateDir);
	if (!cliMode) {
		return createPlumbing({
			integrations: createStubIntegrations(config.stateDir),
			notify: notifier,
		});
	}
	const cli: ExternalCli = createCliRunner(config.integrationsCommand!);
	return createPlumbing({
		integrations: createCliIntegrations(cli),
		integrationsCli: cli,
		notify: notifier,
	});
}

export async function startHost(options: StartHostOptions): Promise<HostService> {
	const context = options.context ?? BACKGROUND_CONTEXT;
	const config = options.config;
	mkdirSync(config.stateDir, { recursive: true });

	const loaded = await loadRoles({ rolesRoot: config.rolesRoot, stateDir: config.stateDir });
	for (const problem of loaded.problems) console.error(`[roles] ${problem}`);
	// The plumbing exists before the harness opens: its tool extensions are installed in the registry at open.
	// The reload wiring below uses refreshPresenceCards when the plumbing has it (createPlumbing does; a test's
	// bare Plumbing fake may not).
	const plumbing: Plumbing & { refreshPresenceCards?(): void } = options.plumbing ?? loadPlumbing(config);

	const host = await openRoleHost({
		dbPath: join(config.stateDir, "roles.db"),
		stateDir: config.stateDir,
		roles: loaded.enabled,
		defaultModel: loaded.defaults.model,
		plumbing,
		hostModels: options.hostModels,
		piAgentDir: config.piAgentDir,
		reportNudge: config.reportNudge === true,
	});
	host.harness.resume();

	const mirror = await startMirror({ host, stateDir: config.stateDir, now: options.clock, context });
	const scheduler = config.schedules
		? startSchedulers({ host, enabled: true, clock: options.clock, intervalMs: options.intervalMs, context })
		: null;
	// The watches share the schedules' switch: nothing runs while it is off.
	const watcher = config.schedules
		? startWatches({ host, enabled: true, clock: options.clock, intervalMs: options.intervalMs, context })
		: null;

	let lastDisabled = loaded.disabled;
	const admin = await startAdmin({
		host,
		stateDir: config.stateDir,
		rolesRoot: config.rolesRoot,
		disabled: () => lastDisabled,
		statuses: () => mirrorRef.mirror.statuses() as unknown as Map<string, Record<string, unknown>>,
		onReload: async () => {
			const reloaded = await loadRoles({ rolesRoot: config.rolesRoot, stateDir: config.stateDir });
			for (const problem of reloaded.problems) console.error(`[roles] ${problem}`);
			await host.applyRoles(reloaded.enabled);
			lastDisabled = reloaded.disabled;
			// Follow any roles the reload added or removed. Stop the mirror that is running now (the previous reload's,
			// not the start's): stopping a stale one left every earlier mirror appending, one copy per reload.
			await mirrorRef.mirror.stop();
			const fresh = await startMirror({ host, stateDir: config.stateDir, now: options.clock, context });
			mirrorRef.mirror = fresh;
			// A role switched on gets its board card at once (the same rule as start), never a heartbeat wait.
			plumbing.refreshPresenceCards?.();
			return reloaded;
		},
		context,
	});

	// Pi Durable 1.2+: a storage error fails the whole harness; exit so systemd restarts the unit.
	void exitOnHarnessFailure(host.harness.closed, { log: (line) => console.error(line), exit: options.exit ?? (() => undefined) });
	await plumbing.start(host);

	const mirrorRef: { mirror: Mirror } = { mirror };
	const shutdown = createShutdown({
		timers: [
			...(scheduler ? [scheduler] : []),
			...(watcher ? [watcher] : []),
			{ stop: () => void mirrorRef.mirror.stop() },
		],
		stopPlumbing: () => plumbing.stop(),
		servers: { close: () => admin.stop() },
		closeHarness: () => host.close(),
		exit: options.exit ?? (() => undefined),
		log: (line) => console.error(line),
	});
	if (options.signals === true) {
		process.on("SIGTERM", () => void shutdown("SIGTERM"));
		process.on("SIGINT", () => void shutdown("SIGINT"));
	}

	const request = async (method: string, path: string, body?: unknown): Promise<AdminResponse> => {
		const { request: httpRequest } = await import("node:http");
		const data = body === undefined ? undefined : JSON.stringify(body);
		return new Promise((resolve, reject) => {
			const req = httpRequest(
				{
					socketPath: admin.path,
					path,
					method,
					headers: data === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(data) },
				},
				(res) => {
					let text = "";
					res.on("data", (chunk: Buffer) => (text += chunk.toString()));
					res.on("end", () => resolve(JSON.parse(text) as AdminResponse));
				},
			);
			req.on("error", reject);
			if (data !== undefined) req.write(data);
			req.end();
		});
	};

	return {
		host,
		admin,
		scheduler,
		watcher,
		get mirror() {
			return mirrorRef.mirror;
		},
		plumbing,
		chat: async (roleName, text) => {
			await request("POST", "/chat", { role: roleName, text });
		},
		reload: async () => {
			await request("POST", "/reload");
		},
		status: async () => request("GET", "/status"),
		shutdown,
		stop: () => shutdown("SIGTERM"),
	};
}

/** The production entrypoint. */
async function main(): Promise<void> {
	const config = loadConfig();
	const plumbing = loadPlumbing(config);
	await startHost({ config, plumbing, signals: true, exit: (code) => process.exit(code) });
	console.error(`[roles] running (state: ${config.stateDir}, schedules: ${config.schedules ? "on" : "off"})`);
}

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
	main().catch((error) => {
		console.error(`[roles] failed to start: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
		process.exit(1);
	});
}
