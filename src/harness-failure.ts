/**
 * Pi Durable 1.2+: any Storage error fails the whole Session, which closes itself; every later
 * call rejects with SessionFailed. 1.5 tags the end by `kind` (`SessionEnd`): `{ kind: "failed",
 * error }` or `{ kind: "closed" }`. Without a watcher the unit stays "active" while every role is
 * dead, so a failed close ends the process and systemd restarts it
 * (a storage failure fails the whole session). A close on purpose (shutdown) is left alone.
 */
import type { SessionEnd } from "@earendil-works/pi-durable";

export type HarnessEnd = SessionEnd;

export type HarnessFailureDeps = {
	log(line: string): void;
	exit(code: number): void;
};

export async function exitOnHarnessFailure(closed: Promise<HarnessEnd>, deps: HarnessFailureDeps): Promise<void> {
	const end = await closed;
	if (end.kind !== "failed") return;
	const error = end.error;
	deps.log(`[roles] the harness failed (storage error): ${error instanceof Error ? (error.stack ?? error.message) : String(error)}; exiting so the service restarts`);
	deps.exit(1);
}
