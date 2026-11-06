/**
 * `bin/roles-backup`: one run of the role host's state backup, for systemd's timer (systemd/pi-roles-backup.*).
 *
 * It prints one line on success — the file it wrote, its size and how many copies are kept — and one line on failure,
 * exiting 1 so a timer run shows as failed in the journal. It never signals, restarts or waits on the host: the
 * database is read through SQLite's online backup API from a read-only connection, which the running host's WAL mode
 * makes safe (src/backup.ts).
 */
import { backupRolesState } from "./backup.ts";

export const DEFAULT_STATE_DIR = "/var/lib/pi-roles";

/** The state directory to back up: STANDING_ROLES_STATE_DIR, else the host's default. */
export function stateDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.STANDING_ROLES_STATE_DIR;
	return configured !== undefined && configured !== "" ? configured : DEFAULT_STATE_DIR;
}

/** Run one backup; returns the process exit code and never throws. */
export async function runBackupCli(options: { stateDir?: string; log?: (line: string) => void; error?: (line: string) => void } = {}): Promise<number> {
	const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
	const error = options.error ?? ((line: string) => process.stderr.write(`${line}\n`));
	const stateDir = options.stateDir ?? stateDirFromEnv();
	try {
		const result = await backupRolesState({ stateDir });
		log(`roles-backup: wrote ${result.path} (${result.bytes} bytes, ${result.kept} kept)`);
		for (const pruned of result.pruned) log(`roles-backup: pruned ${pruned}`);
		return 0;
	} catch (failure) {
		error(`roles-backup: ${failure instanceof Error ? failure.message : String(failure)}`);
		return 1;
	}
}

process.exitCode = await runBackupCli();
