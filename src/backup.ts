/**
 * The role host's own state backup.
 *
 * `roles.db` holds what cannot be rebuilt: five permanent conversations, their tasks and their documents. Pi Durable
 * 1.4 migrates the SQLite schema to version 2 on the first open and 1.3.0 cannot open a migrated database, so a
 * restore-from-backup is the only rollback there is — which means a backup must exist before the upgrade.
 *
 * SQLite's online backup API from a read-only connection, so the running host is never stopped and a WAL
 * database is copied consistently; no file copy of a live database is ever made. The copy is written as a `.partial`
 * file, switched to a plain rollback journal so it is one self-contained file that restores anywhere, checked with
 * `PRAGMA integrity_check`, and only then renamed into place. A name that already exists is never overwritten: a
 * second backup inside the same second takes the next suffix. After a good copy, `roles-*.db` files beyond the newest
 * `keep` are removed; every other file in the directory is left alone.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

/** How many daily copies to keep: two weeks, matching the notify and needs-you retention windows. */
export const BACKUP_KEEP = 14;

/** The database name inside the state directory (src/main.ts opens `<stateDir>/roles.db`). */
export const DATABASE_NAME = "roles.db";

const NAME = /^roles-\d{8}-\d{6}(?:-\d+)?\.db$/;

/** `roles-YYYYmmdd-HHMMSS.db` in UTC, so the names sort in time order. */
export function backupFileName(nowMs: number): string {
	const iso = new Date(nowMs).toISOString(); // 2026-10-22T03:15:09.000Z
	return `roles-${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}.db`;
}

export type BackupOptions = {
	/** The state directory holding roles.db; the copy goes to `<stateDir>/backups/`. */
	stateDir: string;
	keep?: number;
	now?: () => number;
};

export type BackupResult = { path: string; bytes: number; kept: number; pruned: string[] };

/** The first name derived from `base` that does not exist yet (never overwrite an existing backup). */
function unusedName(dir: string, base: string): string {
	let candidate = join(dir, base);
	let suffix = 1;
	while (existsSync(candidate)) {
		suffix += 1;
		candidate = join(dir, base.replace(/\.db$/, `-${suffix}.db`));
	}
	return candidate;
}

/** Copy the live database with SQLite's online backup API and return the path written. */
export async function backupRolesState(options: BackupOptions): Promise<BackupResult> {
	const source = join(options.stateDir, DATABASE_NAME);
	if (!existsSync(source)) throw new Error(`no ${DATABASE_NAME} in ${options.stateDir}: nothing to back up`);
	const dir = join(options.stateDir, "backups");
	const final = unusedName(dir, backupFileName((options.now ?? Date.now)()));
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const partial = `${final}.partial`;
	rmSync(partial, { force: true });
	// Read-only: this process never writes the host's database.
	const db = new DatabaseSync(source, { readOnly: true });
	try {
		await backup(db, partial);
	} catch (error) {
		rmSync(partial, { force: true });
		throw error;
	} finally {
		db.close();
	}
	try {
		const copy = new DatabaseSync(partial);
		try {
			// The copy of a WAL database is itself marked WAL: a plain rollback journal makes it one file.
			copy.exec("PRAGMA journal_mode = DELETE");
			const check = copy.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
			if (check?.integrity_check !== "ok") {
				throw new Error(`the backup failed its integrity check: ${String(check?.integrity_check)}`);
			}
		} finally {
			copy.close();
		}
		chmodSync(partial, 0o600);
		renameSync(partial, final);
	} catch (error) {
		rmSync(partial, { force: true });
		throw error;
	}
	const keep = Math.max(1, options.keep ?? BACKUP_KEEP);
	const all = readdirSync(dir).filter((name) => NAME.test(name)).sort();
	const pruned = all.slice(0, Math.max(0, all.length - keep));
	for (const name of pruned) rmSync(join(dir, name), { force: true });
	return { path: final, bytes: statSync(final).size, kept: all.length - pruned.length, pruned: pruned.map((name) => join(dir, name)) };
}
