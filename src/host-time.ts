/**
 * The host's clock helpers, all in one configured time zone (STANDING_ROLES_TIMEZONE, default "UTC").
 *
 * Schedules, the digest's day windows and the notification de-duplication bucket all read the same zone, so a role's
 * 07:00 means 07:00 wherever the adopter runs the host, and the day a digest is dated by is the day its window ends
 * in. IANA zone names are accepted ("Europe/London", "America/New_York", …); an unknown name falls back to UTC with
 * one logged line, never a crash.
 */

/** The environment variable the host reads its time zone from. */
export const TIMEZONE_ENV = "STANDING_ROLES_TIMEZONE";

let cachedZone: string | undefined;

/** The configured zone (default "UTC"); a name Intl cannot use falls back to "UTC". */
export function hostTimeZone(env: NodeJS.ProcessEnv = process.env): string {
	const raw = env[TIMEZONE_ENV];
	if (cachedZone !== undefined && raw === cachedZoneRaw) return cachedZone;
	cachedZoneRaw = raw;
	if (raw === undefined || raw.trim() === "") {
		cachedZone = "UTC";
		return cachedZone;
	}
	try {
		new Intl.DateTimeFormat("en-GB", { timeZone: raw });
		cachedZone = raw;
	} catch {
		console.error(`[roles] unknown time zone "${raw}" (${TIMEZONE_ENV}); using UTC`);
		cachedZone = "UTC";
	}
	return cachedZone;
}

let cachedZoneRaw: string | undefined;

function partsFormatter(zone: string): Intl.DateTimeFormat {
	return new Intl.DateTimeFormat("en-GB", {
		timeZone: zone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
		weekday: "short",
	});
}

/** The calendar date (`YYYY-MM-DD`), `HH:MM` and weekday of an instant, in the host's zone. */
export function zoneParts(ms: number, zone: string = hostTimeZone()): { date: string; time: string; weekday: string } {
	const parts = partsFormatter(zone).formatToParts(new Date(ms));
	const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
	return {
		date: `${get("year")}-${get("month")}-${get("day")}`,
		time: `${get("hour")}:${get("minute")}`,
		weekday: get("weekday"),
	};
}

/** The UTC instant of a wall-clock date and HH:MM in the host's zone (corrects twice for DST edges). */
export function zoneMs(date: string, time: string, zone: string = hostTimeZone()): number {
	const [y, m, d] = date.split("-").map(Number);
	const [hh, mm] = time.split(":").map(Number);
	let guess = Date.UTC(y!, m! - 1, d!, hh, mm);
	for (let i = 0; i < 2; i++) {
		const said = zoneParts(guess, zone);
		if (said.date === date && said.time === time) break;
		const [gy, gm, gd] = said.date.split("-").map(Number);
		const [gh, gn] = said.time.split(":").map(Number);
		guess += Date.UTC(y!, m! - 1, d!, hh, mm) - Date.UTC(gy!, gm! - 1, gd!, gh, gn);
	}
	return guess;
}

const DATE_ONLY = new Map<string, Intl.DateTimeFormat>();

/** The calendar date (`YYYY-MM-DD`) of an instant in the host's zone. Throws for a non-instant. */
export function zoneDate(instant: string | number | Date, zone: string = hostTimeZone()): string {
	const date = instant instanceof Date ? instant : new Date(instant);
	if (Number.isNaN(date.getTime())) throw new Error(`zoneDate: not an instant: ${String(instant)}`);
	let formatter = DATE_ONLY.get(zone);
	if (formatter === undefined) {
		formatter = new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
		DATE_ONLY.set(zone, formatter);
	}
	const parts = formatter.formatToParts(date);
	const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
	const day = `${get("year")}-${get("month")}-${get("day")}`;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`zoneDate: cannot format ${date.toISOString()} in ${zone}`);
	return day;
}

/** The date-hour bucket (`YYYY-MM-DDTHH`) of an instant in the host's zone: notification dedupe keys are stable inside it. */
export function zoneDateHour(nowMs: number, zone: string = hostTimeZone()): string {
	const { date, time } = zoneParts(nowMs, zone);
	return `${date}T${time.slice(0, 2)}`;
}
