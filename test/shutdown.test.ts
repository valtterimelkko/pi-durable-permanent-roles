import { describe, expect, it } from "vitest";
import { createShutdown } from "../src/shutdown.ts";

describe("createShutdown — the host's orderly, bounded SIGTERM", () => {
	it("stops the timers, then the plumbing, closes the admin socket, then the harness, then exits 0 — once", async () => {
		const order: string[] = [];
		const exits: number[] = [];
		const shutdown = createShutdown({
			timers: [
				{ stop: () => void order.push("schedules") },
				{ stop: () => void order.push("mirror") },
			],
			stopPlumbing: async () => void order.push("plumbing"),
			servers: { close: async () => void order.push("admin") },
			closeHarness: async () => void order.push("harness"),
			exit: (code) => void exits.push(code),
			log: () => undefined,
		});
		await shutdown("SIGTERM");
		await shutdown("SIGTERM");
		expect(order).toEqual(["schedules", "mirror", "plumbing", "admin", "harness"]);
		expect(exits).toEqual([0]);
	});

	it("keeps going when a step throws, and still closes the harness", async () => {
		const order: string[] = [];
		const shutdown = createShutdown({
			timers: [{ stop: () => void order.push("timers") }],
			stopPlumbing: async () => {
				throw new Error("plumbing stuck");
			},
			servers: { close: async () => void order.push("admin") },
			closeHarness: async () => void order.push("harness"),
			exit: () => undefined,
			log: () => undefined,
		});
		await shutdown("SIGTERM");
		expect(order).toEqual(["timers", "admin", "harness"]);
	});

	it("forces the exit at the deadline when the harness refuses to close", async () => {
		const exits: number[] = [];
		const started = Date.now();
		const shutdown = createShutdown({
			timers: [{ stop: () => undefined }],
			servers: { close: async () => undefined },
			closeHarness: () => new Promise<void>(() => undefined),
			exit: (code) => void exits.push(code),
			log: () => undefined,
			deadlineMs: 300,
		});
		await shutdown("SIGTERM");
		expect(exits).toEqual([1]);
		expect(Date.now() - started).toBeLessThan(5_000);
	});
});
