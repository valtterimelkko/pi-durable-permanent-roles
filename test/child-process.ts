/**
 * Child process for the host crash test, following the Phone Steward project's
 * crash-test approach (read-only template): every crash is a real SIGKILL of a separate
 * child process at a deterministic point, and every reopen is a fresh process opening the
 * same SQLite file. Delivery counts are read from the reopened storage, never from memory.
 *
 *     node --experimental-strip-types test/child-process.ts '<json stage>'
 *
 * Stages print `MARKER {…}` lines on stdout. The crash stage arms the
 * "after-submit-before-ledger" gate (src/crash-gate.ts): the tick submits the scheduled run
 * (durable, with its requestId), writes the marker file and then blocks — the test parent
 * SIGKILLs it there. The resume stage reopens, ticks again (the ledger mark never
 * happened), and the stable requestId dedupes the resubmission, so the run continues
 * exactly once.
 *
 * RED-proof knob: `dedupe: false` makes the resume stage submit with a DIFFERENT requestId,
 * so the run is delivered twice and the test's exactly-once assertion must fail.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, UserEntry } from "@earendil-works/pi-durable";
import { armCrashGate } from "../src/crash-gate.ts";
import { openRoleHost } from "../src/harness.ts";
import { startSchedulers } from "../src/schedules.ts";
import { loadRoles } from "../src/roles.ts";
import { installRoleFaux } from "./helpers.ts";
import { createModels } from "@earendil-works/pi-ai/models";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";

const context = BACKGROUND_CONTEXT;

type Stage = {
	stage: "crash-submit" | "resume-verify";
	db: string;
	stateDir: string;
	rolesRoot: string;
	markerFile?: string;
	releaseFile?: string;
	clockMs: number;
	dedupe?: boolean;
};

function marker(payload: Record<string, unknown>): void {
	process.stdout.write(`MARKER ${JSON.stringify(payload)}\n`);
}

async function open(stage: Stage) {
	const credentials = new InMemoryCredentialStore();
	const models = createModels({ credentials });
	installRoleFaux(models, {});
	const { enabled } = await loadRoles({ rolesRoot: stage.rolesRoot, stateDir: stage.stateDir });
	return openRoleHost({
		dbPath: stage.db,
		stateDir: stage.stateDir,
		roles: enabled,
		defaultModel: { provider: "faux", modelId: "m-1" },
		hostModels: { models, credentials, problems: [] },
	});
}

async function main(): Promise<void> {
	const stage = JSON.parse(process.argv[2] ?? "{}") as Stage;
	const host = await open(stage);
	const ids: Record<string, string | undefined> = {};
	for (const role of host.roles()) ids[role.name] = host.conversationId(role.name);
	marker({ event: "opened", conversations: ids });

	if (stage.stage === "crash-submit") {
		if (stage.markerFile === undefined || stage.releaseFile === undefined) throw new Error("crash-submit needs marker and release files");
		armCrashGate("after-submit-before-ledger", stage.markerFile, stage.releaseFile);
		const scheduler = startSchedulers({ host, enabled: true, clock: () => stage.clockMs });
		const submitted = await scheduler.tick();
		// Reached only if the gate is released (never in the crash test).
		marker({ event: "submitted", submitted });
		scheduler.stop();
		await host.close();
		return;
	}

	// resume-verify: the same slot is still due (the ledger mark never happened). With the
	// knob off, the child deliberately uses a different requestId, so delivery happens twice.
	const scheduler = startSchedulers({
		host,
		enabled: true,
		clock: () => stage.clockMs,
		requestIdPrefix: stage.dedupe === false ? "run-other:" : "run:",
	});
	const submitted = await scheduler.tick();
	marker({ event: "submitted", submitted });
	await host.harness.waitForIdle(context);
	const conversation = await host.conversation("alpha");
	const entries = await conversation!.entries({ order: "ascending" }, 100, undefined, context);
	marker({
		event: "result",
		conversationId: host.conversationId("alpha"),
		userEntries: entries.items.filter((entry) => UserEntry.is(entry)).length,
		assistantEntries: entries.items.filter((entry) => AssistantEntry.is(entry)).length,
		assistantTexts: entries.items
			.filter((entry) => AssistantEntry.is(entry))
			.map((entry) => {
				const message = entry.model?.[0] as { content?: Array<{ type: string; text?: string }> } | undefined;
				return (message?.content ?? []).flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("");
			}),
	});
	scheduler.stop();
	await host.close();
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		process.stderr.write(`[child] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
		process.exit(1);
	});
