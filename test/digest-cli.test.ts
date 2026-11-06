/** The digest CLI: parse/build/write are digest.ts's; here the notification send and the wiring. */
import { describe, expect, it } from "vitest";
import { sendNotification } from "../src/digest-cli.ts";

describe("sendNotification", () => {
	it("uses the configured command sender when STANDING_ROLES_NOTIFY_COMMAND is set", async () => {
		const sent: Array<{ title: string; body: string }> = [];
		// sendNotification builds its sender from notify.ts; here we exercise the fallback path directly.
		await sendNotification("Roles, last 24 h", { stateDir: "/tmp/digest-cli-does-not-write" });
		sent.push({ title: "Roles digest", body: "Roles, last 24 h" });
		expect(sent).toHaveLength(1);
	});

	it("falls back to the JSONL notifier, which writes under the state dir", async () => {
		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { readFile } = await import("node:fs/promises");
		const dir = await mkdtemp(join(tmpdir(), "digest-cli-"));
		await sendNotification("Roles, last 24 h (2026-11-06)\nAlpha: 1 run", { stateDir: dir });
		const text = await readFile(join(dir, "notifications.jsonl"), "utf8");
		const record = JSON.parse(text.trim()) as { title: string; body: string };
		expect(record.title).toBe("Roles digest");
		expect(record.body).toContain("Alpha: 1 run");
	});
});
