/**
 * The role host's harness: one Pi Durable harness over one SQLite file,
 * one conversation per enabled role (its id kept in a durable doc, so a restart finds the
 * same conversation), the role's model/thinking/instructions/tools/cwd applied on every
 * start, background compaction at half the default model's window with a summary that
 * points back at the role's notes folder, and the bash hard limit under every role.
 *
 * Shape adapted from the Phone Steward project, a sibling repository; the `Plumbing` seam and the per-role conversations are new.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { AssistantMessage, Message, ModelThinkingLevel, Models } from "@earendil-works/pi-ai";
import {
	AgentDoc,
	CompactionEntry,
	CompactionTask,
	Harness,
	createRegistry,
	defineDoc,
	defineExtension,
	hook,
	type CompactionPolicy,
	type Conversation,
	type ConversationId,
	type EntryRecord,
	type Extension,
	type HarnessSettings,
	type HookApi,
	type ModelRef,
	type Registry,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import { compactionPolicyFor, COMPACT_AT_DEFAULT } from "./context-policy.ts";
import { baseEveryDeltas, deltasOnly, SESSION_BASE_DELTAS } from "./doc-checkpoint.ts";
import { defaultMemoryRecord, type MemoryPhase } from "./memory-record.ts";
import { createDocsCommandRunner, docsCommitExtension, DOCS_ONLY_LIMIT, type DocsCommandRunner } from "./docs-commit.ts";
import { limitsExtension } from "./limits.ts";
import { loadNeverRunTable, readOnlyMessagingExtensionFor, READ_ONLY_MESSAGING_LIMIT } from "./messaging-limit.ts";
import { buildHostModels, type HostModels } from "./pi-registry.ts";
import { roleHostReports } from "./report-notify.ts";
import { appendRunEndLine, reportedCounts, reportedRun } from "./run-report.ts";
import { isScheduledSlot } from "./digest.ts";
import { raiseHostItem } from "./needs-you.ts";
import { join as joinPath } from "node:path";
import {
	changedPaths,
	initialRefChangeRoles,
	refChangeMessage,
	refChangeRequestId,
	referenceEntriesFor,
	type ReferenceEntry,
} from "./ref-files.ts";
import type { Plumbing, RoleDefinition } from "./types.ts";

/** Role name → conversation id, the host's durable registry of "which conversation is which role". */
export const RoleConversationsDoc = defineDoc<{ conversations: Record<string, number> }>({
	kind: "roles.conversations",
	version: 1,
	scope: "session",
	initial: () => ({ conversations: {} }),
	// Written once per role, when its conversation is created: replaying a handful of deltas is cheaper than a base.
	checkpointWhen: deltasOnly,
});

/** Role name → the role's last submitted run, durable across a host restart (the mirror's status.json). */
export const RoleLastRunsDoc = defineDoc<{ runs: Record<string, { atMs: number; slot: string }> }>({
	kind: "roles.lastRuns",
	version: 1,
	scope: "session",
	initial: () => ({ runs: {} }),
	// One write per submitted run (five roles, a few runs a day each): a base every 128 deltas bounds the replay.
	checkpointWhen: baseEveryDeltas(SESSION_BASE_DELTAS),
});

/**
 * Role name → the reference hashes last applied: the host compares each role's
 * reference files against this and submits one input when they differ. One write per actual change.
 */
export const RoleReferenceHashesDoc = defineDoc<{ hashes: Record<string, Record<string, string>> }>({
	kind: "roles.referenceHashes",
	version: 1,
	scope: "session",
	initial: () => ({ hashes: {} }),
	checkpointWhen: deltasOnly,
});

/** The plain last-step line every run input carries: a small model skips a last step that
 * lives only in the system prompt. Appended in submit to every kind: scheduled slots, watch firings, inbox and
 * owner chat, the reference-change input. Roles skipped the preamble's capture step without it. */
export const RUN_INPUT_REPORT_REMINDER =
	"Before your last step, capture what this run should keep (preamble, Capture before you finish): an owner correction or decision, a changed state, a lesson, a link across time. Last step of this run: call report_run.";

/**
 * The report nudge: a run that settles without report_run gets this one input in the same
 * conversation, and only when no other run is queued behind it (otherwise the report could land under the wrong
 * slot). If the run is still unreported afterwards, the host raises a problem card itself — never silent.
 */
export const REPORT_NUDGE_TEXT =
	"The host noticed the run you just finished ended without report_run. Call report_run now for that run (its counts, what you did, what you could not cover), then stop. Do nothing else.";

/**
 * The every-run nudge: a scheduled run whose report leaves one of the role's
 * everyRunCounts at 0 or out gets this one input in the same conversation (only when nothing is queued behind it);
 * if its newest report still misses the count, the host raises a problem card. Rides on the report nudge's switch.
 */
export function everyRunNudgeText(missed: readonly string[]): string {
	const names = missed.join(", ");
	return `The host noticed your report for the run you just finished gives ${names} as 0 or leaves it out, and ${names} is required on every scheduled run (your settings' everyRunCounts), even when an earlier run today already did it. Do that part now, then call report_run again for this run with the corrected counts, then stop.`;
}

export type OpenRoleHostOptions = {
	dbPath: string;
	/** The state directory: <stateDir>/roles/<name>/notes is injected into each prompt. */
	stateDir: string;
	/** The report nudge and its fallback card (REPORT_NUDGE_TEXT); production turns it on through loadConfig. */
	reportNudge?: boolean;
	/** The enabled roles (loadRoles), already validated. */
	roles: readonly RoleDefinition[];
	/** roles/defaults.json's effective model — also the window the compaction policy measures. */
	defaultModel: { provider: string; modelId: string };
	/** The plumbing (host-plumb); default a no-op with empty placeholder extensions. */
	plumbing?: Plumbing;
	/** The model registry and credentials; production reads Pi's own (piAgentDir). */
	hostModels?: HostModels;
	piAgentDir?: string;
	/** Fraction of the window at which background compaction starts (default 0.5). */
	compactAt?: number;
	/** Resume interrupted work at start-up (default true). */
	resume?: boolean;
	/** TEST-ONLY registry override. */
	registry?: Registry;
	/** TEST-ONLY seam for the docs-only limit: the command runner (git, guide-check). */
	docsRunner?: DocsCommandRunner;
	/** TEST-ONLY seam for the memory run-record; default the live cgroup read. */
	memoryRecord?: (phase: MemoryPhase, role: RoleDefinition, slot: string) => void;
	/** The systemd units a role may never stop or restart directly (config.guardedServices). */
	guardedServices?: readonly string[];
	/** The role host's own unit, which no role may restart (config.serviceName). */
	serviceName?: string;
	/** The repo-guide checker the docs_commit tool runs when a role edits a guide (config.guideCheck). */
	guideCheck?: string;
};

export type RoleHost = {
	readonly harness: Harness;
	roles(): readonly RoleDefinition[];
	/** The role conversation's id, as a string (the HostApi surface). */
	conversationId(roleName: string): string | undefined;
	conversation(roleName: string): Promise<Conversation | undefined>;
	roleForConversation(conversationId: string): RoleDefinition | undefined;
	/** The slot of the role's current run (the last submit), or undefined before its first run. */
	currentSlot(roleName: string): string | undefined;
	/** Submit an input into a role's conversation (whenBusy followUp; requestId dedupes). */
	submit(roleName: string, input: { content: string; requestId: string; step?: string }): Promise<void>;
	/** Re-apply the roles after a reload: new roles get conversations, changed settings re-configure. */
	applyRoles(roles: readonly RoleDefinition[]): Promise<void>;
	/** The compaction policy Pi Durable reads (a live getter over the default model's window). */
	compactionPolicy(): CompactionPolicy;
	/** When each role last had a run submitted, for the mirror's status.json. */
	lastRun(roleName: string): { atMs: number; slot: string } | undefined;
	/** Whether the role has a run executing or queued (the unsettled-slots FIFO is non-empty); watches stamp late firings with it. */
	isBusy(roleName: string): boolean;
	close(): Promise<void>;
};

/** A plumbing that does nothing: used when host-plumb's createPlumbing is not wired yet. */
export function noOpPlumbing(): Plumbing {
	const empty = (name: string): Extension => defineExtension({ name });
	return {
		extensions: () => ({ integrations: empty("integrations"), notify: empty("notify"), tasks: [] }),
		start: async () => undefined,
		stop: async () => undefined,
		runStarted: () => undefined,
		runEnded: () => undefined,
	};
}

export function roleHostRegistry(plumbing: Plumbing, docsCommit?: Extension, readOnlyLimits: Extension[] = []): Registry {
	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(limitsExtension());
	registry.install(roleCompactionExtension());
	if (docsCommit !== undefined) registry.install(docsCommit);
	for (const limit of readOnlyLimits) registry.install(limit);
	const extensions = plumbing.extensions();
	registry.install(extensions.integrations);
	registry.install(extensions.notify);
	for (const task of extensions.tasks) registry.install(task);
	return registry;
}

/**
 * The extensions a role's conversation selects, in a stable order: the shared three always,
 * then a hard limit's extension for each limit the role carries, then the tool groups from
 * settings.tools. Later wraps sit outside earlier ones: the docs and messaging refusals wrap
 * the shared reboot-refusing bash.
 */
export function extensionSelectionFor(
	extensions: { coding: Extension; limits: Extension; compaction: Extension; docs: Extension; integrations: Extension; notify: Extension },
	tools: ReadonlyArray<"coding" | "integrations" | "notify">,
	limits: ReadonlyArray<string> = [],
	readOnlyMessaging?: Extension,
): Extension[] {
	const selection = [extensions.coding, extensions.limits, extensions.compaction];
	if (limits.includes(DOCS_ONLY_LIMIT)) selection.push(extensions.docs);
	if (limits.includes(READ_ONLY_MESSAGING_LIMIT) && readOnlyMessaging !== undefined) selection.push(readOnlyMessaging);
	if (tools.includes("integrations")) selection.push(extensions.integrations);
	if (tools.includes("notify")) selection.push(extensions.notify);
	return selection;
}

function roleCompactionExtension(): Extension {
	return defineExtension({
		name: "role-compaction",
		hooks: [
			hook(CompactionTask, {
				beforeCompact: (compaction, api, context) => summarizeForCompaction(compaction, api, context),
			}),
		],
	});
}

type CompactionHost = {
	modelFor(conversationId: ConversationId): ModelRef | undefined;
	notesFor(conversationId: ConversationId): string | undefined;
};
let activeCompactionHost: CompactionHost | undefined;

/** Set by openRoleHost so the compaction hook can find the role's notes folder and models. */
export function setCompactionHost(host: CompactionHost | undefined): void {
	activeCompactionHost = host;
}

const SUMMARY_SYSTEM =
	"You are a context summarization assistant. Read the conversation and write a structured summary that another assistant will use to continue it. Do not answer or continue the conversation. If it starts with an earlier summary, keep its information and fold the newer messages into it.";

/**
 * Messages as plain text, so the summariser reads a transcript instead of continuing it:
 * the same shape as Pi Durable's `serializeConversation` (not exported), which the default
 * summary path sends — visible text, tool calls and tool results; system messages and
 * thinking omitted; tool results capped at 2,000 characters so the request stays inside the
 * window it summarises.
 */
function serializeForSummary(messages: readonly Message[]): string {
	const textOf = (content: string | ReadonlyArray<{ type: string; text?: string }>): string =>
		typeof content === "string"
			? content
			: content.flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : [])).join("\n");
	const parts: string[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			const text = textOf(message.content);
			if (text.length > 0) parts.push(`[User]: ${text}`);
		} else if (message.role === "assistant") {
			const texts = message.content.flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : []));
			const calls = message.content.flatMap((block) =>
				block.type === "toolCall"
					? [`${block.name}(${Object.entries(block.arguments).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(", ")})`]
					: [],
			);
			if (texts.length > 0) parts.push(`[Assistant]: ${texts.join("\n")}`);
			if (calls.length > 0) parts.push(`[Assistant tool calls]: ${calls.join("; ")}`);
		} else if (message.role === "toolResult") {
			const text = textOf(message.content);
			if (text.length > 2_000) parts.push(`[Tool result]: ${text.slice(0, 2_000)}\n\n[... ${text.length - 2_000} more characters truncated]`);
			else if (text.length > 0) parts.push(`[Tool result]: ${text}`);
		}
	}
	return parts.join("\n\n");
}

/**
 * The threshold compaction's summary, written with the conversation's own model from the
 * conversation itself (Pi Durable's default path does the same: `<conversation>` plus the
 * serialized messages) and instructions that keep decisions and open items and end with the
 * notes pointer. Any failure falls back to Pi Durable's default summary (undefined), never
 * to a failed run.
 */
export async function summarizeForCompaction(
	compaction: { readonly instructions?: string; readonly messages?: readonly Message[] },
	api: HookApi,
	context: Context,
): Promise<{ summary: string } | undefined> {
	// A manual compaction carries the instructions already; leave it to the default path.
	if (compaction.instructions !== undefined) return undefined;
	const host = activeCompactionHost;
	if (host === undefined) return undefined;
	const notesDir = host.notesFor(api.conversationId);
	if (notesDir === undefined) return undefined;
	try {
		const stored = await api.snapshot(AgentDoc, api.conversationId, context);
		const modelRef: ModelRef | undefined = stored?.model ?? host.modelFor(api.conversationId);
		if (modelRef === undefined) return undefined;
		const model = api.models.getModel(modelRef.provider, modelRef.modelId);
		if (model === undefined) return undefined;
		const now = Date.now();
		const request = `<conversation>\n${serializeForSummary(compaction.messages ?? [])}\n</conversation>\n\nWrite the summary as markdown with these headings: ## Goal, ## Decisions and open items, ## Progress, ## Where to look.\n\nKeep what only this conversation knows: decisions taken, open items, and what the role is waiting on. Drop numbers and lists the tools can re-read. End your summary with exactly this line: Your folder ${notesDir} is the record: re-read it before continuing.`;
		const message: AssistantMessage = await api.models.completeSimple(
			model,
			{
				messages: [
					{ role: "system", content: SUMMARY_SYSTEM, timestamp: now },
					{
						role: "user",
						content: [
							{
								type: "text",
								text: request,
							},
						],
						timestamp: now,
					},
				],
			},
			{ maxTokens: Math.min(model.maxTokens > 0 ? model.maxTokens : 8_000, 8_000) },
		);
		if (message.stopReason !== "stop") return undefined;
		const text = message.content
			.flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
			.join("\n")
			.trim();
		if (text.length === 0) return undefined;
		const footer = `Your folder ${notesDir} is the record: re-read it before continuing.`;
		return { summary: text.endsWith(footer) ? text : `${text}\n\n${footer}` };
	} catch {
		return undefined;
	}
}

export async function openRoleHost(options: OpenRoleHostOptions): Promise<RoleHost> {
	const context: Context = BACKGROUND_CONTEXT;
	const plumbing = options.plumbing ?? noOpPlumbing();
	// The memory run-record seam: tests inject a recorder;
	// production logs the cgroup's memory numbers to the journal at each run's start and end.
	const memoryRecord = options.memoryRecord ?? defaultMemoryRecord;
	// The model registry: a passed-in one (tests, scratch), else Pi's own registry and auth.
	let models: MutableModels = options.hostModels?.models ?? createModels();
	if (options.hostModels === undefined) {
		const host = await buildHostModels({ agentDir: options.piAgentDir ?? `${process.env.HOME ?? "/root"}/.pi/agent` });
		for (const problem of host.problems) console.error(`[roles] pi registry: ${problem}`);
		models = host.models;
	}
	const defaultWindow = models.getModel(options.defaultModel.provider, options.defaultModel.modelId)?.contextWindow ?? 0;
	const compactAt = options.compactAt ?? COMPACT_AT_DEFAULT;
	// The canonical extension objects: installed in the registry (by name) and handed to
	// configure (which stores their names).
	const plumbingExtensions = plumbing.extensions();
	// The docs-only-commits limit: the docs_commit tool and the git-refusing bash
	// wrap, selected only for the roles that carry the limit. roleForConversation resolves at call
	// time, once byName and the conversation ids are filled below.
	const docs = docsCommitExtension({
		roleForConversation: (conversationId) =>
			[...byName.values()].find((role) => conversationIds.get(role.name)?.toString() === conversationId),
		runner: options.docsRunner ?? createDocsCommandRunner(),
		...(options.guideCheck === undefined ? {} : { guideCheck: options.guideCheck }),
	});
	// The read-only-messaging limit: one bash-only wrap per role that carries it, built from the role's own
	// never-run table. A role whose table is missing or malformed is reported and gets no wrap (the
	// docs-only limit stays available); a wrap that refuses nothing would be a lie.
	const readOnlyLimits: Extension[] = [];
	const readOnlyByRole = new Map<string, Extension>();
	for (const role of options.roles) {
		if (!role.settings.enabled || !role.settings.limits?.includes(READ_ONLY_MESSAGING_LIMIT)) continue;
		const rulesPath = joinPath(role.dir, role.settings.readOnlyRules ?? "never-run.json");
		try {
			const table = await loadNeverRunTable(rulesPath);
			const extension = readOnlyMessagingExtensionFor(role.name, table);
			readOnlyLimits.push(extension);
			readOnlyByRole.set(role.name, extension);
		} catch (error) {
			console.error(`[roles] read-only rules for ${role.name} could not be loaded (${rulesPath}): ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const extensionObjects = {
		coding: CodingTools,
		limits: limitsExtension({
			guardedServices: options.guardedServices ?? [],
			ownHostService: options.serviceName ?? "pi-roles",
		}),
		compaction: roleCompactionExtension(),
		docs,
		integrations: plumbingExtensions.integrations,
		notify: plumbingExtensions.notify,
	};
	const registry = options.registry ?? roleHostRegistry(plumbing, docs, readOnlyLimits);
	const storage = await openNodeSqliteStorage(options.dbPath);
	const settings: HarnessSettings = {
		get compaction() {
			return compactionPolicyFor(defaultWindow, compactAt);
		},
	};
	// Pi Durable 1.5 reports carry one tagged `Report` (`kind` says what happened, the `error` rides inside): the kinds
	// that mean a role's work has stopped reach the owner on the notify path (src/report-notify.ts); every report keeps
	// its journal line. `opened` stays unset until Harness.open returns; a report raised during open is held and
	// flushed right after.
	let opened: Harness | undefined;
	let roleNameOf: (conversationId: ConversationId) => string | undefined = () => undefined;
	const reports = roleHostReports({
		harness: () => opened,
		context,
		roleOf: (conversationId) => roleNameOf(conversationId),
	});
	const harness = await Harness.open(storage, {
		models,
		registry,
		settings,
		env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? options.stateDir }),
		onReport: reports,
	}, context);
	opened = harness;
	await reports.flush(); // reports raised during open (a migration_failed report) go out now

	const byName = new Map<string, RoleDefinition>();
	const conversationIds = new Map<string, ConversationId>();
	const lastRuns = new Map<string, { atMs: number; slot: string }>();
	// Per role, the FIFO of submitted-but-not-settled slots. A submit pushes its slot; the run's
	// settle callback removes it. The head is the run executing now (follow-ups run in order), so a report filed
	// during a busy run tags the ACTIVE run even when later runs are already queued behind it.
	const unsettledSlots = new Map<string, string[]>();
	// Seed the in-memory read path from the durable doc, so a restart keeps each role's last run
	// instead of showing lastRunAt/lastRunSlot as null. A state dir without the doc (or an old one)
	// simply seeds nothing: null until that role's next run.
	const storedLastRuns = await harness.snapshot(RoleLastRunsDoc, context);
	for (const [name, value] of Object.entries(storedLastRuns?.runs ?? {})) {
		if (value !== undefined) lastRuns.set(name, value);
	}
	for (const role of options.roles) byName.set(role.name, role);

	const conversationFor = async (role: RoleDefinition): Promise<Conversation> => {
		const known = conversationIds.get(role.name);
		if (known !== undefined) {
			const existing = await harness.conversation(known, context);
			if (existing !== undefined) return existing;
		}
		// Create the conversation and record its id in one commit, so a crash cannot leave
		// an unrecorded conversation behind.
		const id = await harness.commit(
			async (tx) => {
				const doc = await tx.doc(RoleConversationsDoc);
				const recorded = doc.conversations[role.name];
				if (recorded !== undefined) return recorded as ConversationId;
				const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
				doc.conversations[role.name] = created.id;
				return created.id;
			},
			context,
		);
		const conversation = await harness.conversation(id, context);
		if (conversation === undefined) throw new Error(`conversation ${id} for role ${role.name} vanished`);
		conversationIds.set(role.name, id);
		return conversation;
	};

	/** Apply the role's settings to its conversation. Runs on every start and reload. */
	const applyRole = async (role: RoleDefinition): Promise<void> => {
		const conversation = await conversationFor(role);
		await conversation.configure(
			{
				model: role.model,
				thinkingLevel: role.thinking as ModelThinkingLevel,
				extensions: extensionSelectionFor(
					extensionObjects,
					role.settings.tools,
					role.settings.limits ?? [],
					readOnlyByRole.get(role.name),
				),
				instructions: role.instructions,
				cwd: role.settings.cwd,
			},
			context,
		);
	};

	setCompactionHost({
		modelFor: () => options.defaultModel,
		notesFor: (conversationId) =>
			host.roleForConversation(conversationId.toString())?.notesDir,
	});

	const host: RoleHost = {
		harness,
		roles: () => [...byName.values()],
		conversationId: (roleName) => conversationIds.get(roleName)?.toString(),
		conversation: (roleName) => {
			const id = conversationIds.get(roleName);
			return id === undefined ? Promise.resolve(undefined) : harness.conversation(id, context);
		},
		roleForConversation: (conversationId) =>
			[...byName.values()].find((role) => conversationIds.get(role.name)?.toString() === conversationId),
		currentSlot: (roleName) => unsettledSlots.get(roleName)?.[0] ?? lastRuns.get(roleName)?.slot,
		submit: async (roleName, input) => {
			const role = byName.get(roleName);
			if (role === undefined) throw new Error(`unknown role: ${roleName}`);
			const conversation = await conversationFor(role);
			// Every run input carries the report_run reminder as its last line: a small
			// model skips a last step that lives only in the system prompt. Plain suffix, no logic about whether
			// the role "should" report; the requestIds are untouched.
			const submission = await conversation.submit(
				{ type: "input", content: `${input.content}\n${RUN_INPUT_REPORT_REMINDER}`, requestId: input.requestId, whenBusy: "followUp" },
				context,
			);
			const at = { atMs: Date.now(), slot: input.step ?? input.requestId };
			lastRuns.set(roleName, at);
			const fifo = unsettledSlots.get(roleName) ?? [];
			fifo.push(at.slot);
			unsettledSlots.set(roleName, fifo);
			// Persist the last run in the same commit seam as the Map set, so a restart finds it.
			await harness.commit(
				async (tx) => {
					const doc = await tx.doc(RoleLastRunsDoc);
					doc.runs[roleName] = at;
				},
				context,
			);
			plumbing.runStarted(role, input.step ?? input.requestId);
			// The run-record: one journal line with the cgroup's memory numbers at each end
			// best-effort, never fails the run.
			memoryRecord("start", role, at.slot);
			// runEnded when the conversation goes idle after the run; never on the critical path.
				void submission
					.wait(context)
					.catch(() => undefined)
					.then(async () => {
						// The report nudge, then the fallback card (REPORT_NUDGE_TEXT). Best effort: an error is logged
						// and the run still settles below.
						if (options.reportNudge === true && !reportedRun(role.name, at.slot)) {
							const queue = unsettledSlots.get(roleName) ?? [];
							const alone = queue.length === 1 && queue[0] === at.slot;
							try {
								if (alone) {
									const nudge = await conversation.submit(
										{ type: "input", content: REPORT_NUDGE_TEXT, requestId: `${input.requestId}:report-nudge`, whenBusy: "followUp" },
										context,
									);
									await nudge.wait(context).catch(() => undefined);
								}
								if (!reportedRun(role.name, at.slot)) {
									const transcript = joinPath(options.stateDir, "roles", role.name, "transcript.jsonl");
									await raiseHostItem(options.stateDir, role, {
										kind: "problem",
										title: `${role.settings.title ?? role.name}: a run ended without a report`.slice(0, 120),
										body: `The run ${at.slot} (started ${new Date(at.atMs).toISOString()}) ended without report_run${alone ? ", even after one reminder" : " (not reminded: another run was queued behind it)"}, so the morning digest shows it as unreported and what it did is invisible there. What it did is in the role's transcript: ${transcript} (search for the slot), or ask the role in its chat.`,
									});
								}
							} catch (error) {
								console.error(
									`[pi-roles] report nudge failed for ${role.name} ${at.slot}: ${error instanceof Error ? error.message : String(error)}`,
								);
							}
						}
						// The every-run nudge, then its fallback card (everyRunNudgeText). Only reported scheduled runs: an
						// unreported run already got the report nudge and card above. Best effort, like the report nudge.
						const everyRun = role.settings.everyRunCounts ?? [];
						if (options.reportNudge === true && everyRun.length > 0 && isScheduledSlot(at.slot) && reportedRun(role.name, at.slot)) {
							const missing = (): string[] =>
								everyRun.filter((name) => !((reportedCounts(role.name, at.slot)?.[name] ?? 0) > 0));
							try {
								if (missing().length > 0) {
									const queue = unsettledSlots.get(roleName) ?? [];
									const alone = queue.length === 1 && queue[0] === at.slot;
									if (alone) {
										const nudge = await conversation.submit(
											{ type: "input", content: everyRunNudgeText(missing()), requestId: `${input.requestId}:every-run-nudge`, whenBusy: "followUp" },
											context,
										);
										await nudge.wait(context).catch(() => undefined);
									}
									const still = missing();
									if (still.length > 0) {
										const transcript = joinPath(options.stateDir, "roles", role.name, "transcript.jsonl");
										await raiseHostItem(options.stateDir, role, {
											kind: "problem",
											title: `${role.settings.title ?? role.name}: a scheduled run skipped ${still.join(", ")}`.slice(0, 120),
											body: `The scheduled run ${at.slot} reported ${still.join(", ")} as 0 or left it out${alone ? ", even after one reminder" : " (not reminded: another run was queued behind it)"}; the role's settings require it on every scheduled run. What the run did is in ${transcript} (search for the slot), or ask the role in its chat.`,
										});
									}
								}
							} catch (error) {
								console.error(
									`[pi-roles] every-run nudge failed for ${role.name} ${at.slot}: ${error instanceof Error ? error.message : String(error)}`,
								);
							}
						}
						// This run settled: drop its slot from the FIFO (the head; follow-ups run in order).
						const fifo = unsettledSlots.get(roleName);
						if (fifo !== undefined) {
							const index = fifo.indexOf(at.slot);
							if (index !== -1) fifo.splice(index, 1);
							if (fifo.length === 0) unsettledSlots.delete(roleName);
						}
						try {
							memoryRecord("end", role, at.slot);
						} finally {
							plumbing.runEnded(role);
						}
						// Role oversight L1: the run-end record beside the memory record — whether the role
						// reported is read from this process's report_run marks. Best effort: an append error
						// is logged and never fails the run.
						appendRunEndLine(options.stateDir, role.name, at, Date.now()).catch((error: unknown) => {
							console.error(
								`[pi-roles] run-end line failed for ${role.name} ${at.slot}: ${error instanceof Error ? error.message : String(error)}`,
							);
						});
					});
		},
		applyRoles: async (roles) => {
			const keep = new Set(roles.map((role) => role.name));
			for (const gone of [...byName.keys()]) if (!keep.has(gone)) byName.delete(gone);
			for (const role of roles) {
				byName.set(role.name, role);
				await applyRole(role);
			}
			await checkReferences();
		},
		compactionPolicy: () => compactionPolicyFor(defaultWindow, compactAt),
		lastRun: (roleName) => lastRuns.get(roleName),
		isBusy: (roleName) => (unsettledSlots.get(roleName)?.length ?? 0) > 0,
		close: async () => {
			setCompactionHost(undefined);
			await harness.close(context);
		},
	};

	/**
	 * Reference files: hash each enabled role's reference set and compare it with the
	 * stored hashes. Changed, added or removed files reach the role as one input through the normal submit path
	 * (requestId keyed by the new hashes, so the same change is delivered once, also across a crash), then the new
	 * hashes are stored. On the very first sight (no stored hashes) the hashes are stored WITHOUT submitting, except
	 * for a role named in STANDING_ROLES_REFCHANGE_INITIAL. Never fails the host: a hash read error is logged.
	 */
	const storeReferenceHashes = async (roleName: string, current: readonly ReferenceEntry[]): Promise<void> => {
		await harness.commit(
			async (tx) => {
				const doc = await tx.doc(RoleReferenceHashesDoc);
				doc.hashes[roleName] = Object.fromEntries(current.map((entry) => [entry.path, entry.hash]));
			},
			context,
		);
	};
	const checkReferences = async (): Promise<void> => {
		const initial = initialRefChangeRoles();
		for (const role of byName.values()) {
			if (!role.settings.enabled) continue;
			let current: ReferenceEntry[];
			try {
				current = await referenceEntriesFor(role);
			} catch (error) {
				console.error(
					`[roles] reference hash failed for ${role.name}: ${error instanceof Error ? error.message : String(error)}`,
				);
				continue;
			}
			const doc = await harness.snapshot(RoleReferenceHashesDoc, context);
			const stored = doc?.hashes[role.name];
			if (stored === undefined && !initial.includes(role.name)) {
				await storeReferenceHashes(role.name, current);
				continue;
			}
			const changed = stored === undefined ? current.map((entry) => entry.path).sort() : changedPaths(stored, current);
			if (changed.length === 0) continue;
			await host.submit(role.name, {
				content: refChangeMessage(changed),
				requestId: refChangeRequestId(role.name, current),
			});
			await storeReferenceHashes(role.name, current);
		}
	};

	// After open, a report can name the role: the maps above are filled by the applyRoles loop.
	roleNameOf = (conversationId) => host.roleForConversation(conversationId.toString())?.name;
	for (const role of byName.values()) await applyRole(role);
	if (options.resume !== false) harness.resume();
	// Reference files: after resume — a role whose reference files changed since the
	// last apply gets one input; on the very first sight the hashes are stored silently (a role named in
	// STANDING_ROLES_REFCHANGE_INITIAL gets the input at first sight too).
	await checkReferences();
	return host;
}

/** A compaction summary entry's text (the wrapped user message). */
export function compactionTextOf(entry: EntryRecord): string | undefined {
	if (!CompactionEntry.is(entry)) return undefined;
	const message = entry.model?.[0];
	if (message === undefined) return undefined;
	const content = (message as { content?: Array<{ type: string; text?: string }> }).content ?? [];
	return content.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("");
}

/** Message text of one entry's model messages, for callers that need the raw transcript. */
export function messageTexts(entry: EntryRecord): string[] {
	return (entry.model ?? []).map((message: Message) => {
		const content = (message as { content?: string | Array<{ type: string; text?: string }> }).content;
		if (typeof content === "string") return content;
		return (content ?? []).flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("");
	});
}