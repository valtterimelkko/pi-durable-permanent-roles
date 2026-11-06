/**
 * The real-integration adapter: every capability over one external CLI (docs/ADOPTING.md).
 *
 * `createCliRunner(command)` spawns the configured program with the built argv, never a shell, so a value stays one
 * argument. The runner has a timeout, caps how much output it keeps, and returns an exit code instead of throwing:
 * an integration being down, slow or broken is a result the caller records, never an exception that fails a run.
 *
 * `createCliIntegrations(cli)` implements the four capabilities over the protocol in argv.ts. Claim and list output
 * is parsed defensively: unreadable JSON is no messages, never a crash — a bad line must not take the carrier down
 * or invent a message.
 */
import { execFile } from "node:child_process";
import { ArgumentError, READ_TIMEOUT_MS, WRITE_TIMEOUT_MS } from "../args.ts";
import type {
	CliResult,
	ExternalCli,
	InboxMarkEvent,
	InboxMessage,
	Integrations,
	PendingInboxRef,
	PresenceCard,
} from "./types.ts";
import {
	buildChannelAskArgv,
	buildChannelCloseArgv,
	buildChannelReplyArgv,
	buildInboxClaimArgv,
	buildInboxListArgv,
	buildInboxMarkArgv,
	buildMemoryCaptureArgv,
	buildMemoryRecallArgv,
	buildPresenceRegisterArgv,
} from "./argv.ts";

/** An integration verb that prints more than this is either broken or being misread. */
export const MAX_CAPTURED_OUTPUT = 32_768;

function capOutput(text: string): string {
	if (text.length <= MAX_CAPTURED_OUTPUT) return text;
	return `${text.slice(0, MAX_CAPTURED_OUTPUT)}\n…[output truncated]`;
}

/** The exit code of a failed execFile: a numeric code when the child exited, otherwise 1 (signal, spawn error). */
function exitCode(error: { code?: unknown } | null): number {
	if (error === null) return 0;
	return typeof error.code === "number" ? error.code : 1;
}

/** The production command runner: execFile, no shell, output capped, a result instead of a throw. */
export function createCliRunner(command: string): ExternalCli {
	return {
		run(argv, options = {}) {
			const timeoutMs = options.timeoutMs ?? READ_TIMEOUT_MS;
			return new Promise((resolve) => {
				execFile(
					command,
					[...argv],
					{
						timeout: timeoutMs,
						killSignal: "SIGKILL",
						encoding: "utf8",
						maxBuffer: 16 * 1024 * 1024,
						shell: false,
					},
					(error, stdout, stderr) => {
						resolve({
							code: exitCode(error),
							stdout: capOutput(String(stdout ?? "")),
							stderr: capOutput(String(stderr ?? "")),
						});
					},
				);
			});
		},
	};
}

/** `{"messages":[{"id":"…","content":"…"}]}` — unreadable output is no messages, never a crash. */
export function parseClaimOutput(stdout: string): InboxMessage[] {
	try {
		const parsed: unknown = JSON.parse(stdout.trim());
		if (parsed === null || typeof parsed !== "object") return [];
		const messages = (parsed as { messages?: unknown }).messages;
		if (!Array.isArray(messages)) return [];
		return messages.flatMap((entry) => {
			if (entry === null || typeof entry !== "object") return [];
			const { id, content } = entry as { id?: unknown; content?: unknown };
			if (typeof id !== "string" || id === "" || typeof content !== "string") return [];
			return [{ id, content }];
		});
	} catch {
		return [];
	}
}

/** `{"messages":[{"id":"…","via":"…","origin":"…"}]}` — unreadable output is no rows, never a crash. */
export function parseListedMessages(stdout: string): PendingInboxRef[] {
	try {
		const parsed: unknown = JSON.parse(stdout.trim());
		if (parsed === null || typeof parsed !== "object") return [];
		const messages = (parsed as { messages?: unknown }).messages;
		if (!Array.isArray(messages)) return [];
		return messages.flatMap((entry) => {
			if (entry === null || typeof entry !== "object") return [];
			const { id, via, origin } = entry as { id?: unknown; via?: unknown; origin?: unknown };
			if (typeof id !== "string" || id === "") return [];
			return [
				{
					id,
					...(typeof via === "string" ? { via } : {}),
					...(typeof origin === "string" ? { origin } : {}),
				},
			];
		});
	} catch {
		return [];
	}
}

function requireOk(result: CliResult, what: string): string {
	if (result.code !== 0) {
		throw new Error((result.stderr.trim() || result.stdout.trim() || `${what} exited ${result.code}`).slice(0, 300));
	}
	return result.stdout;
}

/** The four capabilities over one CLI that speaks the documented protocol. */
export function createCliIntegrations(cli: ExternalCli): Integrations {
	return {
		enabled: true,
		presence: {
			register: async (card: PresenceCard) => {
				await cli.run(buildPresenceRegisterArgv(card), { timeoutMs: WRITE_TIMEOUT_MS });
			},
		},
		memory: {
			recall: async (query: string) => requireOk(await cli.run(buildMemoryRecallArgv(query)), "memory recall"),
			capture: async (input: { note: string; idempotencyKey: string }) => {
				const result = await cli.run(buildMemoryCaptureArgv(input), { timeoutMs: WRITE_TIMEOUT_MS });
				if (result.code !== 0) {
					throw new Error((result.stderr.trim() || `memory capture exited ${result.code}`).slice(0, 300));
				}
			},
		},
		inbox: {
			claim: async (name: string) =>
				parseClaimOutput(requireOk(await cli.run(buildInboxClaimArgv(name)), "inbox claim")),
			listClaimed: async (name: string) =>
				parseListedMessages(requireOk(await cli.run(buildInboxListArgv(name, "claimed")), "inbox list")),
			mark: async (name, input: { id: string; event: InboxMarkEvent; detail?: string }) => {
				void name;
				const result = await cli.run(buildInboxMarkArgv(input), { timeoutMs: WRITE_TIMEOUT_MS });
				if (result.code !== 0) {
					throw new Error((result.stderr.trim() || `inbox mark exited ${result.code}`).slice(0, 300));
				}
			},
		},
		channel: {
			reply: async (input) =>
				requireOk(await cli.run(buildChannelReplyArgv(input), { timeoutMs: WRITE_TIMEOUT_MS }), "channel reply"),
			askOwner: async (input) =>
				requireOk(await cli.run(buildChannelAskArgv(input), { timeoutMs: WRITE_TIMEOUT_MS }), "channel ask"),
			close: async (input) =>
				requireOk(await cli.run(buildChannelCloseArgv(input), { timeoutMs: WRITE_TIMEOUT_MS }), "channel close"),
		},
	};
}

export { ArgumentError };
