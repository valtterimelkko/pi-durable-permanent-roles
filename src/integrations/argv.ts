/**
 * Every integration CLI call the role host makes, built as a pure argv array.
 *
 * The safety rule (src/args.ts): fixed verbs and flags are literals, so owner or model text can only ever land in a
 * value slot; a value that starts with `-` is refused; the runner passes argv without a shell. The exact argv of each
 * call is frozen by golden tests (test/integrations-argv.test.ts): a change here is a change to the protocol a real
 * integration implements and must be deliberate.
 *
 * The protocol (docs/ADOPTING.md documents it in full):
 *   presence register --name N --title T --status working|waiting --step S
 *   memory recall --query Q            (stdout: the answer text)
 *   memory capture --note N --idempotency-key K
 *   inbox claim --name N               (stdout JSON: {"messages":[{"id","content"}]})
 *   inbox list --name N --state claimed (stdout JSON: {"messages":[{"id","via?","origin?"}]})
 *   inbox mark --id ID --event delivered|failed [--detail TEXT]
 *   channel reply --thread T --from N --text TEXT
 *   channel ask --thread T --from N --text TEXT
 *   channel close --thread T --from N --text TEXT
 */
import { idArg, singleLine, textArg } from "../args.ts";
import { PRESENCE_STATUSES, type PresenceCard, type PresenceStatus } from "./types.ts";

export { PRESENCE_STATUSES };
export type { PresenceStatus };

function presenceStatus(value: string): PresenceStatus {
	if (!(PRESENCE_STATUSES as readonly string[]).includes(value)) {
		throw new Error(`status must be one of ${PRESENCE_STATUSES.join("|")}`);
	}
	return value as PresenceStatus;
}

export function buildPresenceRegisterArgv(card: PresenceCard): string[] {
	const name = idArg(card.name, "name");
	return [
		"presence",
		"register",
		"--name",
		name,
		"--title",
		singleLine(card.title, 120),
		"--status",
		presenceStatus(card.status),
		"--step",
		singleLine(card.step, 200),
	];
}

export function buildMemoryRecallArgv(query: unknown): string[] {
	return ["memory", "recall", "--query", textArg(query, "query")];
}

export function buildMemoryCaptureArgv(input: { note: unknown; idempotencyKey: string }): string[] {
	return [
		"memory",
		"capture",
		"--note",
		textArg(input.note, "note", 2_000),
		"--idempotency-key",
		input.idempotencyKey,
	];
}

export function buildInboxClaimArgv(name: string): string[] {
	return ["inbox", "claim", "--name", idArg(name, "name"), "--json"];
}

export function buildInboxListArgv(name: string, state: "claimed"): string[] {
	return ["inbox", "list", "--name", idArg(name, "name"), "--state", state, "--json"];
}

export function buildInboxMarkArgv(input: { id: string; event: "delivered" | "failed"; detail?: string }): string[] {
	const id = idArg(input.id, "id", 120);
	if (input.event !== "delivered" && input.event !== "failed") {
		throw new Error("event must be delivered|failed");
	}
	const base = ["inbox", "mark", "--id", id, "--event", input.event];
	if (input.detail === undefined) return base;
	return [...base, "--detail", singleLine(input.detail, 200)];
}

export function buildChannelReplyArgv(input: { thread: string; from: string; text: unknown }): string[] {
	return [
		"channel",
		"reply",
		"--thread",
		idArg(input.thread, "thread"),
		"--from",
		idArg(input.from, "from"),
		"--text",
		textArg(input.text, "text", 2_000),
	];
}

export function buildChannelAskArgv(input: { thread: string; from: string; text: unknown }): string[] {
	return [
		"channel",
		"ask",
		"--thread",
		idArg(input.thread, "thread"),
		"--from",
		idArg(input.from, "from"),
		"--text",
		textArg(input.text, "text", 2_000),
	];
}

export function buildChannelCloseArgv(input: { thread: string; from: string; text: unknown }): string[] {
	return [
		"channel",
		"close",
		"--thread",
		idArg(input.thread, "thread"),
		"--from",
		idArg(input.from, "from"),
		"--text",
		textArg(input.text, "text", 2_000),
	];
}
