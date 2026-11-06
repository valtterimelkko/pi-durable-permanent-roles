/**
 * The daily SQLite backup of the role host's own state.
 *
 * The database is the one thing the host cannot rebuild: five permanent conversations, their tasks and their
 * documents. Pi Durable 1.4 migrates the SQLite schema to version 2 on open and **1.3.0 cannot open the result**, so
 * the rollback path is "restore a backup", and a backup has to exist before the upgrade is deployed.
 *
 * Every copy goes through SQLite's own online backup API from a read-only connection, so a live host is never stopped
 * and a WAL database is copied consistently. Nothing here touches the live state directory: every test builds its own
 * temporary database and state dir.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { backupFileName, BACKUP_KEEP, backupRolesState } from "../src/backup.ts";

const roots: string[] = [];
const BACKUP_BIN = fileURLToPath(new URL("../bin/roles-backup", import.meta.url));

afterAll(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function tempStateDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "sr-backup-"));
	roots.push(dir);
	return dir;
}

/** A roles.db with a table and rows, left OPEN (WAL), exactly like a running host. */
function liveDatabase(stateDir: string, rows: string[]): DatabaseSync {
	const db = new DatabaseSync(join(stateDir, "roles.db"));
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("CREATE TABLE IF NOT EXISTS conversations (id INTEGER PRIMARY KEY, role TEXT NOT NULL)");
	for (const role of rows) db.exec(`INSERT INTO conversations (role) VALUES ('${role}')`);
	return db;
}

function rowsOf(dbPath: string): string[] {
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		return (db.prepare("SELECT role FROM conversations ORDER BY id").all() as Array<{ role: string }>).map((row) => row.role);
	} finally {
		db.close();
	}
}

describe("backupFileName", () => {
	it("is a UTC YYYYmmdd-HHMMSS name that sorts", () => {
		expect(backupFileName(Date.UTC(2026, 9, 22, 3, 15, 9))).toBe("roles-20261022-031509.db");
	});
});

describe("backupRolesState", () => {
	it("copies a live WAL database consistently, and the copy is one self-contained file", async () => {
		const stateDir = await tempStateDir();
		const live = liveDatabase(stateDir, ["runtime-keeper", "docs-currency"]);
		try {
			const result = await backupRolesState({ stateDir, now: () => Date.UTC(2026, 9, 22, 3, 15, 9) });
			expect(result.path).toBe(join(stateDir, "backups", "roles-20261022-031509.db"));
			expect(result.bytes).toBeGreaterThan(0);
			expect(rowsOf(result.path)).toEqual(["runtime-keeper", "docs-currency"]);
			// Restorable anywhere: a plain rollback journal, no -wal or -shm beside it.
			expect(existsSync(`${result.path}-wal`)).toBe(false);
			expect(existsSync(`${result.path}-shm`)).toBe(false);
			expect(statSync(result.path).mode & 0o777).toBe(0o600);
		} finally {
			live.close();
		}
	});

	it("never overwrites an existing backup, even within the same second", async () => {
		const stateDir = await tempStateDir();
		const live = liveDatabase(stateDir, ["runtime-keeper"]);
		try {
			const now = () => Date.UTC(2026, 9, 22, 3, 15, 9);
			const first = await backupRolesState({ stateDir, now });
			writeFileSync(first.path, "sentinel", "utf8"); // a later run must not clobber this file
			const second = await backupRolesState({ stateDir, now });
			expect(second.path).not.toBe(first.path);
			expect(second.path.startsWith(first.path.replace(/\.db$/, ""))).toBe(true);
			expect(statSync(first.path).size).toBe("sentinel".length);
			expect(rowsOf(second.path)).toEqual(["runtime-keeper"]);
		} finally {
			live.close();
		}
	});

	it("keeps the newest 14 backups and prunes older ones, leaving other files alone", async () => {
		const stateDir = await tempStateDir();
		const live = liveDatabase(stateDir, ["runtime-keeper"]);
		try {
			expect(BACKUP_KEEP).toBe(14);
			for (let day = 1; day <= 16; day++) {
				await backupRolesState({ stateDir, now: () => Date.UTC(2026, 9, day, 3, 15, 0) });
			}
			const dir = join(stateDir, "backups");
			writeFileSync(join(dir, "notes.txt"), "not a backup", "utf8");
			const names = readdirSync(dir).filter((name) => name.startsWith("roles-")).sort();
			expect(names).toHaveLength(14);
			expect(names[0]).toBe("roles-20261003-031500.db");
			expect(names.at(-1)).toBe("roles-20261016-031500.db");
			expect(existsSync(join(dir, "notes.txt"))).toBe(true);
		} finally {
			live.close();
		}
	});

	it("fails loudly when there is no database to back up", async () => {
		const stateDir = await tempStateDir();
		await expect(backupRolesState({ stateDir })).rejects.toThrow(/roles\.db/);
		expect(existsSync(join(stateDir, "backups"))).toBe(false);
	});
});

describe("bin/roles-backup", () => {
	it("backs up the state dir named by STANDING_ROLES_STATE_DIR and reports the file", async () => {
		const stateDir = await tempStateDir();
		const live = liveDatabase(stateDir, ["runtime-keeper"]);
		try {
			const run = spawnSync(BACKUP_BIN, [], { env: { ...process.env, STANDING_ROLES_STATE_DIR: stateDir }, encoding: "utf8" });
			expect(run.status).toBe(0);
			expect(run.stdout).toMatch(/roles-\d{8}-\d{6}\.db/);
			const backups = readdirSync(join(stateDir, "backups"));
			expect(backups).toHaveLength(1);
			expect(rowsOf(join(stateDir, "backups", backups[0]))).toEqual(["runtime-keeper"]);
		} finally {
			live.close();
		}
	});

	it("exits non-zero when the backup cannot be made", async () => {
		const stateDir = await tempStateDir();
		const run = spawnSync(BACKUP_BIN, [], { env: { ...process.env, STANDING_ROLES_STATE_DIR: stateDir }, encoding: "utf8" });
		expect(run.status).not.toBe(0);
		expect(run.stderr).toMatch(/roles\.db/);
	});

	it("keeps an installable unit pair beside the service for the parent's deploy", async () => {
		const service = await import("node:fs").then((fs) =>
			fs.readFileSync(fileURLToPath(new URL("../systemd/pi-roles-backup.service", import.meta.url)), "utf8"),
		);
		const timer = await import("node:fs").then((fs) =>
			fs.readFileSync(fileURLToPath(new URL("../systemd/pi-roles-backup.timer", import.meta.url)), "utf8"),
		);
		expect(service).toContain("ExecStart=/opt/pi-durable-permanent-roles/bin/roles-backup");
		expect(service).toContain("Type=oneshot");
		expect(service).not.toContain("Restart=");
		expect(timer).toContain("OnCalendar=");
		expect(timer).toContain("Persistent=true");
		expect(timer).toContain("WantedBy=timers.target");
	});
});
