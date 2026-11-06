/**
 * The nightly needs-you card: at most one `flag` item per digest, in the needs-you line format, with role and
 * presence name `role-oversight` (not a role folder — the item names the digest itself). Raised only when there is
 * something to decide: a scheduled run that missed its every-run counts, or pending rule proposals on the digest of
 * a Monday (the weekly proposals slot). Raising a new card resolves the previous digest's card as superseded.
 *
 * The line helpers are reused from src/needs-you.ts untouched; this module only builds the fields.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RoleDefinition } from "./types.ts";
import {
	appendNeedsYouLine,
	needsYouId,
	readNeedsYouFile,
	serialiseNeedsYouLine,
	serialiseResolvedLine,
	validateRaiseItem,
	type RaiseItemFields,
} from "./needs-you.ts";
import type { Digest, DigestRole } from "./oversight-types.ts";

/** The one delegation the card suggests. */
export const CARD_TASK_TEXT =
	'When the owner says which proposals to accept or decline and which findings to act on, record each decision with the role through `bin/roles chat <role> "…"` (yes → its STATE.md Standing rules with the owner\'s words; no → declined) and ask the role about any findings; nothing before the go.';

/** The role identity the digest raises cards under: not a role folder, a digest byline. */
const CARD_ROLE = "role-oversight";

/** Proposals shown across roles per card; the rest are held (they stay in the digest). */
export const CARD_PROPOSALS_MAX = 5;
/** One body line never carries more than this many characters. */
const LINE_CHARS_MAX = 220;
/** Keep the body clear of the format's 2,000-character refusal. */
const BODY_BUDGET = 1_900;

/** True when the digest date is a Monday (the weekly proposals slot). */
export function isMonday(date: string): boolean {
	return new Date(`${date}T12:00:00Z`).getUTCDay() === 1;
}

function clip(text: string): string {
	return text.length > LINE_CHARS_MAX ? `${text.slice(0, LINE_CHARS_MAX - 1)}…` : text;
}

interface ProposalLine {
	role: string;
	proposal: string;
}

function proposalLines(roles: readonly DigestRole[]): ProposalLine[] {
	const lines: ProposalLine[] = [];
	for (const role of roles) {
		for (const proposal of role.pendingProposals) {
			lines.push({ role: role.role, proposal });
		}
	}
	return lines;
}

export interface DigestCard {
	fields: RaiseItemFields;
	/** How many pending proposals exist in total (shown + held). */
	proposalTotal: number;
}

/**
 * The card's fields for a digest, or undefined when there is nothing to decide: no every-run misses, and (outside a
 * Monday digest) no pending rule proposals to show.
 */
export function cardFor(digest: Digest, digestPath?: string, replaced: readonly string[] = []): DigestCard | undefined {
	const findingLines: string[] = [];
	for (const role of digest.roles) {
		for (const miss of role.everyRunMisses ?? []) {
			findingLines.push(clip(`- ${role.title}: every-run count — ${miss}`));
		}
	}
	const findings = findingLines.length;
	const monday = isMonday(digest.date);
	const proposals = monday ? proposalLines(digest.roles) : [];
	if (findings === 0 && proposals.length === 0) return undefined;

	const shown = proposals.slice(0, CARD_PROPOSALS_MAX).map((proposal) =>
		clip(`- ${proposal.role}: ${proposal.proposal}`),
	);
	const held = proposals.length - shown.length;
	const tail = [...shown, ...(held > 0 ? [`- … and ${held} more proposals held (see the digest)`] : []), ...replaced.map(clip)];

	// The body must survive the format's cap: keep as many finding lines as fit, then one line for the rest.
	const bodyWith = (kept: number): string => {
		const rest = findings - kept;
		const note = rest > 0 ? [`- … and ${rest} more findings held (see the digest)`] : [];
		return [...findingLines.slice(0, kept), ...note, ...tail].join("\n");
	};
	let kept = findings;
	while (kept > 0 && bodyWith(kept).length > BODY_BUDGET) kept--;
	const lines = bodyWith(kept).split("\n");

	const fields = validateRaiseItem({
		kind: "flag",
		title: clip(`Roles digest ${digest.date}: ${findings} findings${proposals.length > 0 ? `, ${proposals.length} proposals` : ""}`),
		body: lines.join("\n"),
		suggestion: { action: "delegate", tasks: [{ category: "system", text: CARD_TASK_TEXT }] },
		...(digestPath === undefined ? {} : { link: digestPath }),
	});
	return { fields, proposalTotal: proposals.length };
}

/**
 * One body line per still-open earlier card this card replaces, naming its title and digest, so undecided findings
 * are pointed to rather than closed silently. Read best effort from the raw file.
 */
function replacedLines(stateDir: string, ids: readonly string[]): string[] {
	if (ids.length === 0) return [];
	const wanted = new Set(ids);
	const lines: string[] = [];
	let text = "";
	try {
		text = readFileSync(join(stateDir, "needs-you.jsonl"), "utf8");
	} catch {
		return [];
	}
	for (const raw of text.split("\n")) {
		if (raw.trim() === "") continue;
		try {
			const parsed = JSON.parse(raw) as { type?: unknown; id?: unknown; title?: unknown; link?: unknown };
			if (parsed.type !== "item" || typeof parsed.id !== "string" || !wanted.has(parsed.id)) continue;
			const title = typeof parsed.title === "string" ? parsed.title : parsed.id;
			const where = typeof parsed.link === "string" ? parsed.link : "the earlier digest";
			lines.push(`- Replaces the still-open card "${title}" — its findings stay in ${where}`);
		} catch {
			// a garbled line names nothing
		}
	}
	return lines;
}

/** The minimal RoleDefinition serialiseNeedsYouLine reads (name and board name only). */
function cardRoleDefinition(): RoleDefinition {
	return {
		name: CARD_ROLE,
		settings: { boardName: CARD_ROLE },
	} as unknown as RoleDefinition;
}

export interface RaiseCardOptions {
	nowMs?: number;
	random?: () => string;
}

/**
 * Raise the digest's card, resolving any still-open card from an earlier digest first. Returns the new item id,
 * or undefined when there was nothing to decide. Validation failures throw: the caller reports them.
 */
export async function raiseDigestCard(stateDir: string, digest: Digest, options: RaiseCardOptions = {}): Promise<string | undefined> {
	const digestPath = join(stateDir, "digest", `${digest.date}.md`);
	const state = readNeedsYouFile(stateDir);
	const open = [...state.items].filter(([id, item]) => item.role === CARD_ROLE && !state.resolved.has(id)).map(([id]) => id);
	const card = cardFor(digest, digestPath, replacedLines(stateDir, open));
	if (card === undefined) return undefined;
	const nowMs = options.nowMs ?? Date.now();

	for (const id of open) {
		await appendNeedsYouLine(stateDir, serialiseResolvedLine(id, `superseded by ${digest.date} digest`, nowMs));
	}

	const id = needsYouId(CARD_ROLE, nowMs, options.random);
	await appendNeedsYouLine(stateDir, serialiseNeedsYouLine(card.fields, cardRoleDefinition(), id, nowMs));
	return id;
}
