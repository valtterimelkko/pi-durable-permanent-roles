/**
 * Reference-change detection: a role that reads a reference file only once misses every later change to it. On start and reload the host hashes each role's
 * reference files — every file in the role's folder except `settings.json` and `instructions.md` (the reload
 * re-applies those itself), plus the role's outside `referenceFiles` (a missing file hashes as "missing") — and, for
 * a role whose hashes changed since the last apply, submits one input naming what changed, requestId keyed by the
 * hashes so the same change is delivered once, also across a crash. Pure computation lives here; the wiring (the
 * durable store and the submit) is in src/harness.ts.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RoleDefinition } from "./types.ts";

/** The hash of a reference file that does not exist (a missing reference is itself a state the role must hear about). */
export const MISSING_HASH = "missing";

/** Roles that get the reference-change input on first sight instead of a silent store (default: none). */
export const REFCHANGE_ENV = "STANDING_ROLES_REFCHANGE_INITIAL";

/** One hashed reference: role-folder files by relative path, outside files by absolute path. */
export type ReferenceEntry = { path: string; hash: string };

/** Every file under dir, relative paths, sorted; directories recursed. */
async function relativeFiles(dir: string, prefix = ""): Promise<string[]> {
	const names = await readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of names) {
		const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
		if (entry.isDirectory()) files.push(...(await relativeFiles(join(dir, entry.name), rel)));
		else if (entry.isFile()) files.push(rel);
	}
	return files.sort();
}

/** SHA-256 of a file's contents; "missing" when it cannot be read. */
async function fileHash(path: string): Promise<string> {
	try {
		return createHash("sha256").update(await readFile(path)).digest("hex");
	} catch {
		return MISSING_HASH;
	}
}

/** The role's reference set, hashed: folder files (minus settings.json and instructions.md) plus referenceFiles. */
export async function referenceEntriesFor(role: RoleDefinition): Promise<ReferenceEntry[]> {
	const entries: ReferenceEntry[] = [];
	for (const rel of await relativeFiles(role.dir)) {
		if (rel === "settings.json" || rel === "instructions.md") continue;
		entries.push({ path: rel, hash: await fileHash(join(role.dir, rel)) });
	}
	for (const outside of role.settings.referenceFiles ?? []) {
		entries.push({ path: outside, hash: await fileHash(outside) });
	}
	return entries;
}

/**
 * The paths whose hash differs between the stored map and the current set: changed, added, and removed (a removed
 * file is a change the role should hear about). Sorted, so the message is stable.
 */
export function changedPaths(stored: Record<string, string>, current: readonly ReferenceEntry[]): string[] {
	const currentPaths = new Set(current.map((entry) => entry.path));
	const changed: string[] = [];
	for (const entry of current) {
		if (stored[entry.path] !== entry.hash) changed.push(entry.path);
	}
	for (const path of Object.keys(stored)) {
		if (!currentPaths.has(path)) changed.push(path);
	}
	return [...new Set(changed)].sort();
}

/**
 * The requestId for one change: `refchange:<role>:<first 16 hex of a hash over the sorted new hash records>`. The
 * same change hashes to the same id (delivered once, also across a crash and resume); any change hashes differently.
 * The records carry their paths (sorted by path), so two files swapping hashes never collide.
 */
export function refChangeRequestId(roleName: string, current: readonly ReferenceEntry[]): string {
	const digest = createHash("sha256")
		.update(current.map((entry) => `${entry.path}=${entry.hash}`).sort().join("\n"))
		.digest("hex")
		.slice(0, 16);
	return `refchange:${roleName}:${digest}`;
}

/** The input the role receives — the plan's exact wording. */
export function refChangeMessage(paths: readonly string[]): string {
	return `Your reference files changed since you last read them: ${paths.join(", ")}. Reread them before your next step.`;
}

/** The roles named in STANDING_ROLES_REFCHANGE_INITIAL (comma-separated), trimmed; empty by default. */
export function initialRefChangeRoles(env: NodeJS.ProcessEnv = process.env): string[] {
	return (env[REFCHANGE_ENV] ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name !== "");
}
