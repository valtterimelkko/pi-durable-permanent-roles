/**
 * Shared test fixtures: temp state dirs, a roles/ tree, and the scripted faux provider
 * (no model cost). Nothing here touches the live state directory or a real model.
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MutableModels } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import type { Plumbing } from "../src/types.ts";
import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type FauxProviderHandle,
	type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";

export async function makeStateDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "sr-state-"));
}

export type FixtureRole = {
	name: string;
	title?: string;
	boardName?: string;
	schedule?: Array<{ at: string; days: "daily" | "weekdays" }>;
	cwd?: string;
	tools?: string[];
	limits?: string[];
	readOnlyRules?: string;
	model?: { provider: string; modelId: string };
	thinking?: string;
	enabled?: boolean;
	runPrompt?: string;
	instructions?: string;
	/** Absolute paths of files outside the role folder the role works from. */
	referenceFiles?: string[];
	/** The role's named report counts. */
	reportCounts?: string[];
	everyRunCounts?: string[];
	watches?: Array<{ name: string; command: string; expect: string; everySeconds: number }>;
};

/** Write a roles/ tree: defaults.json (faux m-1), PREAMBLE.md, one folder per role. */
export async function writeRolesTree(root: string, roles: FixtureRole[]): Promise<void> {
	await mkdir(root, { recursive: true });
	await writeFile(
		join(root, "defaults.json"),
		JSON.stringify({ model: { provider: "faux", modelId: "m-1" }, thinking: "high" }, undefined, "\t"),
		"utf8",
	);
	await writeFile(join(root, "PREAMBLE.md"), "You are a permanent agent of the owner's host.\n\nYour reference files are in `{roleDir}`; your notes are in `{notes}`.\n\nWrite everything down in your folder.", "utf8");
	for (const role of roles) {
		const dir = join(root, role.name);
		await mkdir(dir, { recursive: true });
		const settings: Record<string, unknown> = {
			enabled: role.enabled ?? true,
			title: role.title ?? role.name,
			boardName: role.boardName ?? `role-${role.name}`,
			schedule: role.schedule ?? [],
			cwd: role.cwd ?? "/tmp",
			tools: role.tools ?? ["coding"],
		};
		if (role.model !== undefined) settings.model = role.model;
		if (role.thinking !== undefined) settings.thinking = role.thinking;
		if (role.runPrompt !== undefined) settings.runPrompt = role.runPrompt;
		if (role.limits !== undefined) settings.limits = role.limits;
		if (role.limits?.includes("read-only-messaging") === true) {
			settings.readOnlyRules = role.readOnlyRules ?? "never-run.json";
		}
		if (role.watches !== undefined) settings.watches = role.watches;
		if (role.reportCounts !== undefined) settings.reportCounts = role.reportCounts;
		if (role.everyRunCounts !== undefined) settings.everyRunCounts = role.everyRunCounts;
		if (role.referenceFiles !== undefined) settings.referenceFiles = role.referenceFiles;
		await writeFile(join(dir, "settings.json"), JSON.stringify(settings, undefined, "\t"), "utf8");
		await writeFile(join(dir, "instructions.md"), role.instructions ?? `Do the {role} work for {title}. Your reference files: {roleDir}. Your notes: {notes}.`, "utf8");
		if (settings.readOnlyRules !== undefined) {
			await writeFile(
				join(dir, String(settings.readOnlyRules)),
				JSON.stringify({
					reference: "roles/work-messages/MESSAGING.md",
					role: role.name,
					rules: [
						{
							cli: "YOUR_MAIL_CLI",
							surface: "the watched work mailbox",
							verbs: [{ path: ["send"] }, { path: ["reply"] }, { path: ["sync"] }, { path: ["draft"] }],
							flags: [],
						},
					],
				}, undefined, "\t"),
				"utf8",
			);
		}
	}
}

export function messageTextOf(message: TranscriptContext["messages"][number] | undefined): string {
	const content = message?.content;
	const parts = typeof content === "string" ? [{ type: "text", text: content }] : (content ?? []);
	return parts.flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("");
}

/** The last non-system message's text. */
function lastText(request: TranscriptContext): string {
	return messageTextOf(request.messages.findLast((message) => message.role !== "system"));
}

/**
 * The role host's scripted answers: a bash refusal check, an allowed-bash check, big
 * filler turns for compaction tests, the summariser's request, and a plain reply.
 */
export const roleFauxRoute: FauxResponseStep = (request: TranscriptContext): AssistantMessage => {
	const last = request.messages.findLast((message) => message.role !== "system");
	const text = lastText(request);
	if (last?.role === "toolResult") return fauxAssistantMessage([fauxText("Tool done.")]);
	if (last?.role === "user") {
		if (text.includes("Write the summary as markdown")) {
			// The summariser answers from its INPUT: it echoes each fact marker only if the
			// request carried it, so a test can assert the conversation reached the summariser
			// (a canned summary cannot catch a hook that never sends the conversation).
			const sent = JSON.stringify(request.messages);
			const fact = (marker: string) => (sent.includes(marker) ? `kept ${marker}` : `MISSING ${marker}`);
			return fauxAssistantMessage([fauxText(`## Decisions\n- ${fact("FACT-DECISION")}\n## Open items\n- ${fact("FACT-OPEN")}\n## Progress\n- ${fact("FACT-NUMBER")}`)]);
		}
		// The messaging-limit route comes first: its name contains the generic ones below.
		if (text.includes("messaging-refuse-check")) return fauxAssistantMessage([fauxToolCall("bash", { command: "YOUR_MAIL_CLI send --to a@b hello" })], { stopReason: "toolUse" });
		if (text.includes("messaging-allowed-check")) return fauxAssistantMessage([fauxToolCall("bash", { command: "echo work-messages-read-ok" })], { stopReason: "toolUse" });
		if (text.includes("docs-refuse-check")) return fauxAssistantMessage([fauxToolCall("bash", { command: "git add notes.md" })], { stopReason: "toolUse" });
		if (text.includes("docs-allowed-check")) return fauxAssistantMessage([fauxToolCall("bash", { command: "git status --porcelain" })], { stopReason: "toolUse" });
		if (text.includes("refuse-check")) return fauxAssistantMessage([fauxToolCall("bash", { command: "reboot" })], { stopReason: "toolUse" });
		if (text.includes("allowed-check")) return fauxAssistantMessage([fauxToolCall("bash", { command: "echo reboot-notes" })], { stopReason: "toolUse" });
		if (text.startsWith("FILLER")) return fauxAssistantMessage([fauxText("x".repeat(3_000))]);
	}
	return fauxAssistantMessage([fauxText(`Reply to: ${text.slice(0, 60)}`)]);
};

export type RoleFauxOptions = {
	/** Models the faux provider offers; the first is the default. */
	models?: Array<{ id: string; contextWindow?: number }>;
	/** Every model request hangs forever (a mid-turn crash point for tests). */
	hang?: boolean;
	/** Written once a hanging request is actually pending at the provider. */
	pendingMarker?: string;
};

/** Install the faux provider on a MutableModels collection and return its handle. */
export function installRoleFaux(models: MutableModels, options: RoleFauxOptions = {}): FauxProviderHandle {	const faux = fauxProvider({
		tokensPerSecond: 4000,
		models: options.models ?? [{ id: "m-1", contextWindow: 1_000_000 }, { id: "m-2", contextWindow: 1_000_000 }],
	});
	models.setProvider(faux.provider);
	let step: FauxResponseStep;
	if (options.hang) {
		let announced = false;
		step = () => {
			if (!announced && options.pendingMarker !== undefined) {
				announced = true;
				void import("node:fs").then((fs) => fs.writeFileSync(options.pendingMarker!, new Date().toISOString(), "utf8"));
			}
			return new Promise<AssistantMessage>(() => {});
		};
	} else {
		step = roleFauxRoute;
	}
	// More responses than any script needs; each request takes the next one.
	faux.setResponses(Array.from({ length: 128 }, () => step));
	return faux;
}

/** A scratch HostModels with the faux provider installed: no credentials, no real models. */
export function makeFauxHostModels(options: RoleFauxOptions = {}): {
	hostModels: { models: MutableModels; credentials: InMemoryCredentialStore; problems: string[] };
	defaultModel: { provider: string; modelId: string };
	faux: FauxProviderHandle;
} {
	const credentials = new InMemoryCredentialStore();
	const models = createModels({ credentials });
	const faux = installRoleFaux(models, options);
	return {
		hostModels: { models, credentials, problems: [] },
		defaultModel: { provider: "faux", modelId: faux.getModel().id },
		faux,
	};
}

/** A no-op plumbing that records runStarted/runEnded as "started <role> <step>" lines. */
export function recordingPlumbing(): { plumbing: Plumbing; events: string[] } {
	const events: string[] = [];
	return {
		events,
		plumbing: {
			extensions: () => ({
				integrations: { name: "integrations" },
				notify: { name: "notify" },
				tasks: [],
			}),
			start: async () => undefined,
			stop: async () => undefined,
			runStarted: (role, step) => void events.push(`started ${role.name} ${step}`),
			runEnded: (role) => void events.push(`ended ${role.name}`),
		},
	};
}
