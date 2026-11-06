/**
 * The host's orderly, bounded shutdown (adapted from the Phone Steward project, a sibling repository): stop the
 * timers (schedules, mirror), stop the plumbing, close the admin socket, close the harness
 * and its SQLite storage, then exit 0. A deadline forces the exit if any step stalls, so a
 * systemd stop never waits for its own timeout on this process.
 */

export type ShutdownDeps = {
	/** Everything with a timer: schedules, mirror. Stopped first, synchronously. */
	timers: Array<{ stop(): void }>;
	/** The plumbing's carrier loops and heartbeat; bounded, never throws. */
	stopPlumbing?(): Promise<void>;
	/** The admin socket server. */
	servers: { close(): Promise<void> };
	closeHarness(): Promise<void>;
	exit(code: number): void;
	log(line: string): void;
	/** Force the exit after this long (default 4 s, inside the 5 s systemd budget). */
	deadlineMs?: number;
};

export function createShutdown(deps: ShutdownDeps): (signal: string) => Promise<void> {
	let started = false;
	const deadlineMs = deps.deadlineMs ?? 4_000;
	return async (signal) => {
		if (started) return;
		started = true;
		deps.log(`[roles] ${signal} received; closing`);
		let finished = false;
		const exitOnce = (code: number): void => {
			if (finished) return;
			finished = true;
			deps.exit(code);
		};
		const forced = new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				deps.log(`[roles] shutdown still running after ${deadlineMs} ms; forcing exit`);
				exitOnce(1);
				resolve();
			}, deadlineMs);
			timer.unref();
		});
		const orderly = (async () => {
			try {
				for (const timer of deps.timers) timer.stop();
				await deps.stopPlumbing?.();
			} catch (error) {
				deps.log(`[roles] stopping the timers or plumbing failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			try {
				await deps.servers.close();
			} catch (error) {
				deps.log(`[roles] closing the admin socket failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			try {
				await deps.closeHarness();
			} catch (error) {
				deps.log(`[roles] closing the harness failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			exitOnce(0);
		})();
		await Promise.race([orderly, forced]);
	};
}
