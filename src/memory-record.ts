/**
 * Memory run-record. At each role run's start and end
 * the host logs ONE journal line with the service cgroup's memory.current, memory.peak, the
 * anon/file split from memory.stat and the memory.events max/oom/oom_kill counts, plus the
 * role and slot — so the next memory peak is explainable from the record rather than guessed at afterwards.
 *
 * Thin by design: read-only file reads, one line, no judgement. Any read error is
 * logged inside that line and never fails a run. The cgroup root, the reader and the log
 * sink are injected; tests point the root at a temp tree, never at the live cgroup.
 */
import { readFileSync } from "node:fs";
import type { RoleDefinition } from "./types.ts";

/** The running service's cgroup root (the role host's systemd unit). */
export const SERVICE_CGROUP_ROOT = process.env.STANDING_ROLES_CGROUP_ROOT ?? "/sys/fs/cgroup/system.slice/pi-roles.service";

export type MemoryPhase = "start" | "end";

/** Anything the cgroup files gave us; every field is optional because reads can fail. */
export type CgroupMemorySample = {
	currentBytes?: number;
	peakBytes?: number;
	anonBytes?: number;
	fileBytes?: number;
	eventsMax?: number;
	eventsOom?: number;
	eventsOomKill?: number;
	/** "memory.peak: <reason>" per read that failed — logged in the line, never thrown. */
	errors: string[];
};

/** Injections for the record; every part defaults to the production behaviour. */
export type MemoryRecordDeps = {
	/** The service cgroup's root directory (tests inject a temp tree). */
	root?: string;
	/** Reads one cgroup file (default node:fs readFileSync, utf8). */
	readFile?: (path: string) => string;
	/** The journal sink (default console.error, the host's log convention). */
	log?: (line: string) => void;
};

const DEFAULTS: Required<Pick<MemoryRecordDeps, "root">> & { readFile: (path: string) => string; log: (line: string) => void } = {
	root: SERVICE_CGROUP_ROOT,
	readFile: (path) => readFileSync(path, "utf8"),
	log: (line) => console.error(line),
};

/** Parse one `key value`-per-line cgroup file into a map. */
function parseKeyValues(content: string): Map<string, number> {
	const map = new Map<string, number>();
	for (const line of content.split("\n")) {
		const parts = line.trim().split(/\s+/);
		if (parts.length === 2 && /^\d+$/.test(parts[1]!)) map.set(parts[0]!, Number(parts[1]));
	}
	return map;
}

/** Read the four cgroup files; each read is guarded, a failure becomes an error note. */
export function readMemorySample(deps: MemoryRecordDeps): CgroupMemorySample {
	const root = deps.root ?? DEFAULTS.root;
	const readFile = deps.readFile ?? DEFAULTS.readFile;
	const sample: CgroupMemorySample = { errors: [] };
	const read = (name: string): string | undefined => {
		try {
			return readFile(`${root}/${name}`);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			sample.errors.push(`${name}: ${reason.replaceAll("\n", " ")}`);
			return undefined;
		}
	};

	const current = read("memory.current");
	if (current !== undefined) sample.currentBytes = Number(current.trim());
	const peak = read("memory.peak");
	if (peak !== undefined) sample.peakBytes = Number(peak.trim());

	const stat = read("memory.stat");
	if (stat !== undefined) {
		const values = parseKeyValues(stat);
		sample.anonBytes = values.get("anon");
		sample.fileBytes = values.get("file");
	}
	const events = read("memory.events");
	if (events !== undefined) {
		const counts = parseKeyValues(events);
		sample.eventsMax = counts.get("max");
		sample.eventsOom = counts.get("oom");
		sample.eventsOomKill = counts.get("oom_kill");
	}
	return sample;
}

/** The one journal line for a run event; fields the reads missed are error notes instead. */
export function memoryRecordLine(phase: MemoryPhase, role: { name: string }, slot: string, sample: CgroupMemorySample): string {
	const fields = [
		`memory run-${phase}`,
		`role=${role.name}`,
		`slot=${slot.replaceAll(/\s+/g, " ")}`,
	];
	if (sample.currentBytes !== undefined) fields.push(`current=${sample.currentBytes}`);
	if (sample.peakBytes !== undefined) fields.push(`peak=${sample.peakBytes}`);
	if (sample.anonBytes !== undefined) fields.push(`anon=${sample.anonBytes}`);
	if (sample.fileBytes !== undefined) fields.push(`file=${sample.fileBytes}`);
	if (sample.eventsMax !== undefined) fields.push(`events.max=${sample.eventsMax}`);
	if (sample.eventsOom !== undefined) fields.push(`events.oom=${sample.eventsOom}`);
	if (sample.eventsOomKill !== undefined) fields.push(`events.oom_kill=${sample.eventsOomKill}`);
	for (const error of sample.errors) {
		const separator = error.indexOf(": ");
		const name = separator === -1 ? error : error.slice(0, separator);
		const reason = separator === -1 ? "read failed" : error.slice(separator + 2);
		fields.push(`error(${name})=${reason}`);
	}
	return `[roles] ${fields.join(" ")}`;
}

/**
 * Record one role run event. Best-effort by contract: reads are guarded per file, and even
 * an unexpected failure only logs — a role's run never fails for the record's sake.
 */
export function recordRunMemory(phase: MemoryPhase, role: { name: string }, slot: string, deps: MemoryRecordDeps = {}): void {
	const log = deps.log ?? DEFAULTS.log;
	try {
		log(memoryRecordLine(phase, role, slot, readMemorySample(deps)));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		try {
			log(`[roles] memory run-${phase} role=${role.name} slot=${slot} error=${reason.replaceAll("\n", " ")}`);
		} catch {
			// Even the log sink is gone; the run must go on.
		}
	}
}

/** The harness's default record: the production cgroup, the [roles] journal line. */
export function defaultMemoryRecord(phase: MemoryPhase, role: RoleDefinition, slot: string): void {
	recordRunMemory(phase, role, slot);
}
