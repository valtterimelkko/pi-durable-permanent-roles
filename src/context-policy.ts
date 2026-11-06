/**
 * The roles' compaction policy (S7): background compaction at a fraction of the model's
 * context window, default one half. Adapted from the Phone Steward project, a sibling repository (the
 * mapping onto Pi Durable's `CompactionPolicy`) with `COMPACT_AT_DEFAULT = 0.5`.
 *
 *   reserveTokens    = max(16 384, round(0.10 x W))     (the block point is W - reserve)
 *   backgroundTokens = (W - reserve) - round(compactAt x W)
 *   keepRecentTokens = max(20 000, round(0.05 x W))
 *   compactAtTokens  = W - reserve - backgroundTokens = round(compactAt x W)
 *
 * A window so small that the reserve floor (16 384) would put the fraction at or above the
 * block point keeps the small-window rule (reserve = W / 4), which is the only sane reading
 * for such a window. An unknown window (0) keeps Pi Durable's defaults (no background
 * compaction rather than a guess).
 */
import type { CompactionPolicy } from "@earendil-works/pi-durable";

export const COMPACT_AT_DEFAULT = 0.5;
export const COMPACT_AT_MIN = 0.5;
export const COMPACT_AT_MAX = 0.9;
export const KEEP_RECENT_TOKENS = 20_000;
/** Room always kept free for the model's answer (Pi Durable's own default reserve). */
export const MIN_RESERVE_TOKENS = 16_384;
/** The small-window rule starts background compaction this far below the block point. */
const BACKGROUND_FRACTION = 0.25;

/** A fraction outside 0.5–0.9 (or not a number) falls back to the default. */
export function clampCompactAt(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return COMPACT_AT_DEFAULT;
	return Math.min(COMPACT_AT_MAX, Math.max(COMPACT_AT_MIN, value));
}

export function compactionPolicyFor(contextWindow: number, compactAt: number = COMPACT_AT_DEFAULT): CompactionPolicy {
	const window = Number.isFinite(contextWindow) && contextWindow > 0 ? Math.floor(contextWindow) : 0;
	if (window === 0) {
		// Unknown window: Pi Durable disables the threshold when the window is 0 anyway.
		return { enabled: true, reserveTokens: MIN_RESERVE_TOKENS, keepRecentTokens: KEEP_RECENT_TOKENS, backgroundTokens: 0 };
	}
	const fraction = clampCompactAt(compactAt);
	const reserve = Math.max(Math.round(0.1 * window), MIN_RESERVE_TOKENS);
	const block = window - reserve;
	const background = block - Math.round(fraction * window);
	// The general rule is degenerate (the fraction at or above the block point) only on a
	// window small enough that the reserve floor dominates; there the small-window rule applies.
	if (background > 0 || reserve > MIN_RESERVE_TOKENS) {
		return {
			enabled: true,
			reserveTokens: reserve,
			keepRecentTokens: Math.max(KEEP_RECENT_TOKENS, Math.round(0.05 * window)),
			backgroundTokens: Math.max(0, background),
		};
	}
	const smallReserve = Math.floor(window / 4);
	const effective = Math.max(1, window - smallReserve);
	return {
		enabled: true,
		reserveTokens: smallReserve,
		keepRecentTokens: Math.max(1, Math.min(KEEP_RECENT_TOKENS, Math.floor(effective / 2))),
		backgroundTokens: Math.round(BACKGROUND_FRACTION * effective),
	};
}

/** The token count at which background compaction starts. */
export function compactAtTokensFor(contextWindow: number, policy: CompactionPolicy): number {
	const window = Number.isFinite(contextWindow) && contextWindow > 0 ? Math.floor(contextWindow) : 0;
	if (window === 0) return 0;
	return Math.max(0, window - policy.reserveTokens - policy.backgroundTokens);
}
