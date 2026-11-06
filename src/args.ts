/**
 * Shared argument helpers for every value the host passes to an external command (src/integrations/argv.ts,
 * src/notify.ts, src/needs-you.ts). The rule: fixed verbs and flags are literals, so owner or model text can only
 * ever land in a value slot; callers pass argv without a shell (execFile), so no crafted text can split into extra
 * arguments; and a value that starts with `-` is refused, so text can never become a flag.
 */
import { createHash } from "node:crypto";

/** How long one integration CLI read may take. */
export const READ_TIMEOUT_MS = 20_000;
/** How long one integration CLI write may take. */
export const WRITE_TIMEOUT_MS = 30_000;
/** A read tool's answer is capped at this many characters. */
export const MAX_READ_CHARS = 6_000;

/** A refused argument: thrown by a builder, or returned to the model as a refusal, never as a crash. */
export class ArgumentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ArgumentError";
	}
}

const CONTROL_TEST = /\p{C}/u;
const CONTROL_ALL = /\p{C}/gu;

/** Free text that must fit one line: controls become spaces, runs collapse, trimmed, capped. */
export function singleLine(text: string, maxLength = 200): string {
	const stripped = text.replace(CONTROL_ALL, " ").replace(/ {2,}/g, " ").trim();
	return stripped.length <= maxLength ? stripped : `${stripped.slice(0, maxLength - 1)}…`;
}

/** A note: keeps line breaks, drops carriage returns and every other control character, capped. */
export function noteText(text: string, maxLength = 2_000): string {
	const stripped = text.replace(/\r/g, "").replace(/[^\P{C}\n]/gu, " ").trim();
	return stripped.length <= maxLength ? stripped : `${stripped.slice(0, maxLength - 1)}…`;
}

/** A free-text value from the model: non-blank, no control characters, never flag-like, capped. */
export function textArg(value: unknown, field: string, max = 400): string {
	if (typeof value !== "string") throw new ArgumentError(`${field} is required`);
	const trimmed = value.trim();
	if (trimmed === "") throw new ArgumentError(`${field} is required`);
	if (CONTROL_TEST.test(trimmed)) throw new ArgumentError(`${field} contains characters that are not allowed`);
	if (trimmed.startsWith("-")) throw new ArgumentError(`${field} cannot start with a dash`);
	return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

/** An id this host passes from its own settings or from integration output (never free model text). */
export function idArg(value: unknown, field: string, max = 120): string {
	if (typeof value !== "string") throw new ArgumentError(`${field} is required`);
	const trimmed = value.trim();
	if (trimmed === "" || CONTROL_TEST.test(trimmed) || /\s/.test(trimmed) || trimmed.startsWith("-")) {
		throw new ArgumentError(`${field} is invalid`);
	}
	if (trimmed.length > max) throw new ArgumentError(`${field} is too long`);
	return trimmed;
}

const IDEMPOTENCY_SHAPE = /^[0-9a-f]{16}$/;

/** The idempotency key a capture carries: 16 lowercase hex characters. */
export function assertIdempotencyKey(key: string): string {
	if (!IDEMPOTENCY_SHAPE.test(key)) {
		throw new ArgumentError("idempotency key must be 16 lowercase hex characters");
	}
	return key;
}

/** A capture's idempotency key: 16 lowercase hex over the facts of the capture. */
export function captureIdempotencyKey(input: { note: string; target: string; source: string }): string {
	return createHash("sha256")
		.update(`${input.target}\u0000${input.source}\u0000${input.note}`)
		.digest("hex")
		.slice(0, 16);
}
