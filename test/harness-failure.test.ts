/**
 * Pi Durable 1.2+: any Storage error fails the whole Session, which closes itself. 1.5 tags the end by `kind`:
 * `{ kind: "failed", error }` or `{ kind: "closed" }` (plan PI-DURABLE-1.5-MIGRATION §B.2 item 4). Without this
 * watcher the unit stays "active" while every role is dead, so a failed close ends the process and systemd restarts
 * it. A close on purpose (shutdown) is left alone.
 *
 * The tagged tests are the guard the plan calls high-risk: a cast that kept reading `end.reason` would still compile
 * while a failed Session left a live-looking dead host — these tests prevent exactly that.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { describe, expect, it } from "vitest";
import { exitOnHarnessFailure } from "../src/harness-failure.ts";

/** A storage error fails the whole Session; the host must restart, not limp. */
function seams() {
	const lines: string[] = [];
	const exits: number[] = [];
	return { lines, exits, deps: { log: (line: string) => lines.push(line), exit: (code: number) => exits.push(code) } };
}

describe("exit on a failed harness", () => {
	it("logs the cause and exits non-zero when the harness closed because of a storage error (kind failed)", async () => {
		const s = seams();
		await exitOnHarnessFailure(Promise.resolve({ kind: "failed", error: new Error("disk I/O error") }), s.deps);
		expect(s.exits).toEqual([1]);
		expect(s.lines.join("\n")).toContain("disk I/O error");
	});

	it("does nothing when the harness was closed on purpose (kind closed)", async () => {
		const s = seams();
		await exitOnHarnessFailure(Promise.resolve({ kind: "closed" }), s.deps);
		expect(s.exits).toEqual([]);
		expect(s.lines).toEqual([]);
	});

	it("exits on a real harness whose storage fails: harness.closed resolves kind failed", { timeout: 15_000 }, async () => {
		const { Harness, MemoryStorage, createRegistry } = await import("@earendil-works/pi-durable");
		const inner = new MemoryStorage();
		let failing = false;
		// Fail only the commits made after the flag is set, so the open succeeds and the failure is the session's own.
		const storage = new Proxy(inner, {
			get(target, property, receiver) {
				if (property === "commit") {
					return async (...args: unknown[]) => {
						if (failing) throw new Error("disk I/O error");
						return (Reflect.get(target, property, receiver) as (...callArgs: unknown[]) => unknown)(...args);
					};
				}
				return Reflect.get(target, property, receiver);
			},
		});
		const harness = await Harness.open(storage as typeof inner, { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
		failing = true;
		const s = seams();
		const watched = exitOnHarnessFailure(harness.closed, s.deps);
		await expect(harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT)).rejects.toThrow();
		await watched;
		expect(s.exits).toEqual([1]);
		expect(s.lines.join("\n")).toContain("disk I/O error");
	});
});
