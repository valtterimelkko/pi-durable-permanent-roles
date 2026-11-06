/**
 * The read-only message-watch roles: the settings wiring, and the never-run table kept in step with
 * its reference document (the drift check — every refused row in the doc must be in the JSON table,
 * and the table must refuse through a recording of the real matcher).
 */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { loadRoles } from "../src/roles.ts";
import { loadNeverRunTable, tableBashRefusal } from "../src/messaging-limit.ts";

const repoRoles = new URL("../roles/", import.meta.url).pathname;

describe("the work-messages role folder", () => {
	it("carries the read-only limit with its rules file", async () => {
		const { disabled, problems } = await loadRoles({ rolesRoot: repoRoles, stateDir: "/tmp/sr-state" });
		expect(problems).toEqual([]);
		const role = disabled.find((candidate) => candidate.name === "work-messages");
		expect(role).toBeDefined();
		expect(role!.settings.limits).toEqual(["read-only-messaging"]);
		expect(role!.settings.readOnlyRules).toBe("never-run.json");
	});

	it("the table loads and matches MESSAGING.md §1: every refused table row in the doc is in the JSON, and back", async () => {
		const table = await loadNeverRunTable(new URL("../roles/work-messages/never-run.json", import.meta.url).pathname);
		const doc = await readFile(new URL("../roles/work-messages/MESSAGING.md", import.meta.url).pathname, "utf8");
		// The doc's §1 table rows: `YOUR_MAIL_CLI <verb> …`
		const docRows = [...doc.matchAll(/`YOUR_MAIL_CLI ([a-z-]+)( …)?`/g)].map((match) => match[1]!);
		const tableVerbs = table.rules
			.filter((rule) => rule.cli === "YOUR_MAIL_CLI")
			.flatMap((rule) => rule.verbs.map((verb) => verb.path.join(" ")))
			.filter((path) => path !== "");
		expect(new Set(tableVerbs)).toEqual(new Set(docRows));
		for (const flag of table.rules.find((rule) => rule.cli === "YOUR_MAIL_CLI")!.flags) {
			expect(doc.includes(flag), `${flag} is named in MESSAGING.md`).toBe(true);
		}
	});

	it("the matcher refuses the never-run forms, including hidden ones, and allows reads", async () => {
		const table = await loadNeverRunTable(new URL("../roles/work-messages/never-run.json", import.meta.url).pathname);
		const refusal = tableBashRefusal(table, "YOUR_MAIL_CLI send --to a@example.com 'hello'");
		expect(refusal).toMatch(/refused:.*writes the watched work mailbox/);
		expect(tableBashRefusal(table, "sudo YOUR_MAIL_CLI send x")).toMatch(/refused:/);
		expect(tableBashRefusal(table, "bash -c 'YOUR_MAIL_CLI reply x'")).toMatch(/refused:/);
		expect(tableBashRefusal(table, "YOUR_MAIL_CLI search --since 2026-01-01")).toBeUndefined();
		expect(tableBashRefusal(table, "echo 'mentioning YOUR_MAIL_CLI send in prose'")).toBeUndefined();
	});
});

describe("the personal-messages role folder", () => {
	it("carries the read-only limit with its rules file, twice-daily schedule and every-run counts", async () => {
		const { disabled, problems } = await loadRoles({ rolesRoot: repoRoles, stateDir: "/tmp/sr-state" });
		expect(problems).toEqual([]);
		const role = disabled.find((candidate) => candidate.name === "personal-messages");
		expect(role).toBeDefined();
		expect(role!.settings.enabled).toBe(false);
		expect(role!.settings.limits).toEqual(["read-only-messaging"]);
		expect(role!.settings.readOnlyRules).toBe("never-run.json");
		expect(role!.settings.schedule).toEqual([
			{ at: "08:00", "days": "daily" },
			{ at: "18:00", "days": "daily" },
		]);
		expect(role!.settings.everyRunCounts).toEqual(["sources_read"]);
	});

	it("the table loads and refuses the write scripts however they are invoked", async () => {
		const table = await loadNeverRunTable(new URL("../roles/personal-messages/never-run.json", import.meta.url).pathname);
		expect(tableBashRefusal(table, "send_email --to x")).toMatch(/refused:/);
		expect(tableBashRefusal(table, "python3 /tools/create_draft.py --body hi")).toMatch(/refused:/);
		expect(tableBashRefusal(table, "xargs YOUR_MAIL_CLI send")).toMatch(/refused:/);
		expect(tableBashRefusal(table, "YOUR_MAIL_CLI search --since 2026-01-01")).toBeUndefined();
	});

	it("MAIL.md documents the never-run rule and the read-only promise", async () => {
		const mail = await readFile(new URL("../roles/personal-messages/MAIL.md", import.meta.url).pathname, "utf8");
		expect(mail).toContain("Never run");
		expect(mail).toContain("Reads never change the mailbox");
	});
});
