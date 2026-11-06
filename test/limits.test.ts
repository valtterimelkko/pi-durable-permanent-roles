import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { DEFAULT_BASH_TIMEOUT_SECONDS, refuseReason, wrapBashWithLimits } from "../src/limits.ts";
import { createBashTool } from "@earendil-works/pi-durable/tools";

describe("refuseReason — commands that must be refused (plan R5)", () => {
	const cases: Array<[string, string]> = [
		["reboot", "reboot"],
		["shutdown -h now", "shutdown"],
		["poweroff", "poweroff"],
		["halt", "halt"],
		["sudo reboot", "sudo"],
		["sudo shutdown -r now", "sudo"],
		["exec reboot", "exec"],
		["exec /sbin/reboot", "absolute path"],
		["/sbin/reboot", "absolute path"],
		["/usr/sbin/shutdown -h now", "absolute path"],
		["systemctl reboot", "systemctl"],
		["systemctl poweroff", "systemctl"],
		["systemctl halt", "systemctl"],
		["systemctl kexec", "systemctl"],
		["sudo systemctl reboot", "systemctl after sudo"],
		["init 0", "init 0"],
		["init 6", "init 6"],
		["telinit 0", "telinit 0"],
		["telinit 6", "telinit 6"],
		["sudo init 6", "sudo init"],
		["echo hi; reboot", "after ;"],
		["echo hi && shutdown -h now", "after &&"],
		["df -h | halt", "after |"],
		["df -h || poweroff", "after ||"],
		["cd /tmp && exec /usr/sbin/reboot", "chain"],
		["systemctl --no-pager reboot", "systemctl with flag"],
	];

	for (const [command] of cases) {
		it(`refuses: ${command}`, () => {
			expect(refuseReason(command)).toBeDefined();
		});
	}
});

describe("refuseReason — false positives that must pass", () => {
	const cases: Array<[string, string]> = [
		["echo reboot-notes", "echo of a note"],
		["git log --grep=shutdown", "git grep pattern"],
		["cat /var/run/reboot-required", "reading the reboot flag file"],
		["ls /var/run/reboot-required.pkgs", "listing the reboot packages"],
		["echo 'please systemctl restart things'", "quoted text about systemctl"],
		["grep reboot /var/log/syslog", "grepping logs"],
		["systemctl status standing-roles", "systemctl status"],
		["systemctl restart nginx", "systemctl restart of a unit"],
		["init 5", "init to a runlevel that is not 0 or 6"],
		["telinit 1", "telinit to a runlevel that is not 0 or 6"],
		["man shutdown", "reading the manual"],
		["npm run build && npm test", "ordinary chain"],
	];

	for (const [command] of cases) {
		it(`allows: ${command}`, () => {
			expect(refuseReason(command)).toBeUndefined();
		});
	}
});

describe("wrapBashWithLimits — the bash tool wrapper", () => {
	/** A recording stand-in for the winning bash tool. */
	function recordingBash(ran: string[]): ReturnType<typeof createBashTool> {
		const bash = createBashTool();
		return {
			...bash,
			execute: async (args) => {
				ran.push(args.command);
				return { output: [{ type: "text", text: "ran" }] };
			},
		};
	}

	const api = {} as ToolExecutionApi;

	it("a refused command returns an error result and never runs", async () => {
		const ran: string[] = [];
		const wrapped = wrapBashWithLimits(recordingBash(ran));
		const result = await wrapped.execute({ command: "echo hi && sudo reboot" }, api, BACKGROUND_CONTEXT);
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.output)).toContain("refused");
		expect(ran).toEqual([]);
	});

	it("an ordinary command runs unchanged", async () => {
		const ran: string[] = [];
		const wrapped = wrapBashWithLimits(recordingBash(ran));
		const result = await wrapped.execute({ command: "cat /var/run/reboot-required" }, api, BACKGROUND_CONTEXT);
		expect(result.isError).toBeUndefined();
		expect(ran).toEqual(["cat /var/run/reboot-required"]);
	});

	it("every bash call carries the default 20-minute timeout unless the call sets one", async () => {
		const seen: Array<{ command: string; timeout?: number }> = [];
		const bash = createBashTool();
		const wrapped = wrapBashWithLimits({
			...bash,
			execute: async (args) => {
				seen.push({ command: args.command, timeout: args.timeout });
				return { output: [{ type: "text", text: "ran" }] };
			},
		});
		await wrapped.execute({ command: "sleep 3600" }, api, BACKGROUND_CONTEXT);
		await wrapped.execute({ command: "quick", timeout: 30 }, api, BACKGROUND_CONTEXT);
		expect(seen[0]).toEqual({ command: "sleep 3600", timeout: DEFAULT_BASH_TIMEOUT_SECONDS });
		expect(DEFAULT_BASH_TIMEOUT_SECONDS).toBe(1200); // seconds: one hung command cannot hold a role for an hour
		expect(seen[1]).toEqual({ command: "quick", timeout: 30 }); // the call's own choice wins
	});

	it("a timeout error result reaches the role unchanged — the stopped command says why", async () => {
		const bash = createBashTool();
		const stopped = {
			output: [{ type: "text", text: "sleep 3600 was stopped: it ran past the 1200-second limit" }] as Array<{ type: "text"; text: string }>,
			isError: true,
		};
		const wrapped = wrapBashWithLimits({ ...bash, execute: async () => stopped });
		const result = await wrapped.execute({ command: "sleep 3600" }, api, BACKGROUND_CONTEXT);
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.output)).toContain("stopped");
	});
});

describe("refuseReason — never start a scan at / (a FUSE or network mount can hang)", () => {
	const refused: string[] = [
		"find / -name RUNTIMES.md",
		"sudo find / -name RUNTIMES.md",
		'bash -c "find / -name RUNTIMES.md"',
		"du -sh /",
		"du /",
		"grep -r pattern /",
		"grep -rn pattern /",
		"rg foo /",
		"rg --files /",
		"$(find / -name x)",
	];

	it.each(refused)("refuses: %s", (command) => {
		const reason = refuseReason(command);
		expect(reason, command).toBeDefined();
		expect(reason, command).toContain("-xdev");
		expect(reason, command).toContain("FUSE or network mount");
	});

	const allowed: string[] = [
		"find /root -name RUNTIMES.md",
		"find /srv/demo/roles -name '*.md'",
		"find / -name RUNTIMES.md -xdev",
		"find / -xdev -name RUNTIMES.md",
		"du -sh /root",
		"du -x /",
		"du --one-file-system /",
		"grep -r pattern /etc/hostname.d",
		"grep pattern /etc/hostname",
		"rg foo /srv/demo/src",
		"rg foo",
	];

	it.each(allowed)("allows: %s", (command) => {
		expect(refuseReason(command), command).toBeUndefined();
	});
});
