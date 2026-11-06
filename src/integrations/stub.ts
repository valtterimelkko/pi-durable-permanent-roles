/**
 * The default integration: works with no external system, off by default.
 *
 * - presence: a no-op (there is nowhere to publish a card).
 * - memory recall: a clear "not configured" notice, never an empty answer that could be mistaken for a search.
 * - memory capture: appended as one JSON line to `<stateDir>/integrations/memory-captures.jsonl`, so nothing a
 *   role records is lost and an adopter can read or replay the file later.
 * - inbox: no messages, and the mark calls are accepted silently.
 * - channel: refused with the same notice — a role must not invent a way to reach a peer that is not there.
 */
import { existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { STUB_NOTICE } from "./types.ts";
import type { InboxMarkEvent, Integrations } from "./types.ts";

/** One JSONL capture record. */
export type CaptureRecord = { at: string; note: string; idempotencyKey: string };

/** The JSONL appender behind the stub's memory capture. Exported for tests. */
export async function appendCaptureRecord(
	stateDir: string,
	input: { note: string; idempotencyKey: string },
): Promise<string> {
	const dir = join(stateDir, "integrations");
	await mkdir(dir, { recursive: true });
	const path = join(dir, "memory-captures.jsonl");
	const record: CaptureRecord = {
		at: new Date().toISOString(),
		note: input.note,
		idempotencyKey: input.idempotencyKey,
	};
	await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
	return path;
}

/** The stub's capture path, or undefined when the state dir holds none yet (a read-only check for adopters). */
export function captureRecordPath(stateDir: string): string {
	return join(stateDir, "integrations", "memory-captures.jsonl");
}

/** Does the stub have captures on disk already? (Never creates anything.) */
export function hasCaptureRecords(stateDir: string): boolean {
	return existsSync(captureRecordPath(stateDir));
}

/** The no-external-system implementation of the seam. */
export function createStubIntegrations(stateDir?: string): Integrations {
	const sink = stateDir;
	return {
		enabled: false,
		presence: {
			register: async () => undefined,
		},
		memory: {
			recall: async () => STUB_NOTICE,
			capture: async (input) => {
				if (sink === undefined) return; // tests without a state dir: the capture goes nowhere
				await appendCaptureRecord(sink, input);
			},
		},
		inbox: {
			claim: async () => [],
			listClaimed: async () => [],
			mark: async (_name: string, _input: { id: string; event: InboxMarkEvent; detail?: string }) => undefined,
			hasPending: () => false,
		},
		channel: {
			reply: async () => {
				throw new Error(STUB_NOTICE);
			},
			askOwner: async () => {
				throw new Error(STUB_NOTICE);
			},
			close: async () => {
				throw new Error(STUB_NOTICE);
			},
		},
	};
}
