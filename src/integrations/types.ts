/**
 * The integration seam between the role host and outside systems (docs/ADOPTING.md, "Bring your own
 * orchestration and memory").
 *
 * The host needs four capabilities the default install has no opinion about:
 * - presence: a shared board where each role is visible as working or waiting;
 * - memory: a place to ask grounded questions and record durable outcomes;
 * - inbox: peer-to-owner and peer-to-peer messages addressed to a role by name;
 * - channel: answering a peer agent on an existing thread.
 *
 * Each capability is an interface here. The default implementation (src/integrations/stub.ts) works with no
 * external system: reads answer a clear "not configured" notice, captures and messages append to local JSONL
 * files under the state directory. A real implementation can be any command-line program speaking the protocol
 * in src/integrations/argv.ts, switched on with STANDING_ROLES_INTEGRATIONS=on and
 * STANDING_ROLES_INTEGRATIONS_COMMAND. Everything is off by default.
 */

/** One external command's result: an exit code, never a throw. */
export type CliResult = { code: number; stdout: string; stderr: string };

/** Runs one external command as an argv array, without a shell. Tests inject a recording fake. */
export interface ExternalCli {
	run(argv: readonly string[], options?: { timeoutMs?: number }): Promise<CliResult>;
}

/** Presence statuses: a finished run reports `waiting` with the step `idle`. */
export const PRESENCE_STATUSES = ["working", "waiting"] as const;
export type PresenceStatus = (typeof PRESENCE_STATUSES)[number];

/** One role's presence card. Re-registering the same name updates it, so repeats are safe. */
export interface PresenceCard {
	/** The role's presence name (settings.boardName), unique. */
	name: string;
	/** Human title. */
	title: string;
	status: PresenceStatus;
	/** What the role is doing right now, one short line. */
	step: string;
}

/** Where the host publishes each role's presence. */
export interface PresenceSink {
	register(card: PresenceCard): Promise<void>;
}

/** One grounded memory read. The answer is untrusted data for the role to read, never instructions. */
export interface MemoryBridge {
	recall(query: string): Promise<string>;
	capture(input: { note: string; idempotencyKey: string }): Promise<void>;
}

/** One message claimed from the role's inbox, ready to submit into its conversation. */
export interface InboxMessage {
	id: string;
	/** The exact text to submit (the sender's words, framed by the integration). */
	content: string;
}

/** A message the integration says was claimed but never delivered (a crash in between). */
export interface PendingInboxRef {
	id: string;
	via?: string;
	origin?: string;
}

export type InboxMarkEvent = "delivered" | "failed";

/** The role-named message drop the host polls. */
export interface PeerInbox {
	claim(name: string): Promise<InboxMessage[]>;
	/** Messages claimed earlier but never delivered; the carrier's start-up recovery passes them on. */
	listClaimed(name: string): Promise<PendingInboxRef[]>;
	mark(name: string, input: { id: string; event: InboxMarkEvent; detail?: string }): Promise<void>;
	/** Cheap in-process hint: the role's inbox might hold a claimable message. Uncertain answers true. */
	hasPending?(name: string): boolean;
}

/** Answering a peer agent on a thread a received message opened. A role never opens a thread. */
export interface PeerChannel {
	reply(input: { thread: string; from: string; text: string }): Promise<string>;
	askOwner(input: { thread: string; from: string; text: string }): Promise<string>;
	close(input: { thread: string; from: string; text: string }): Promise<string>;
}

/** The four capabilities, as the plumbing carries them. */
export interface Integrations {
	/** False for the stub: every capability answers locally, nothing leaves the host. */
	enabled: boolean;
	presence: PresenceSink;
	memory: MemoryBridge;
	inbox: PeerInbox;
	channel: PeerChannel;
}

/** The notice every stub read returns, so a role never mistakes a missing integration for an empty memory. */
export const STUB_NOTICE =
	"No memory integration is configured. The host answers from local files only; the owner can connect a real memory system (docs/ADOPTING.md, Bring your own orchestration and memory).";
