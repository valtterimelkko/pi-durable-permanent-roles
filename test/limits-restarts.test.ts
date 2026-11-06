import { describe, expect, it } from "vitest";
import { refuseReason } from "../src/limits.ts";

/**
 * A role's bash refuses direct restarts of the guarded services — they go through `bin/flush-restart`
 * only. The list is configuration; the role host's own unit is always guarded, with the own-host
 * reason. The operator's FLUSH_RESTART_NOW override is never a role's. `bin/flush-restart` itself
 * stays allowed: it is the guard.
 */
const GUARDED = { services: new Set(["my-app", "other-service"]), ownHostService: "pi-roles" };

describe("refuseReason — service restarts only through bin/flush-restart", () => {
	const refused: string[] = [
		"systemctl restart my-app",
		"systemctl kill other-service",
		"systemctl try-restart my-app",
		"systemctl reload-or-restart other-service",
		"systemctl --user restart my-app",
		"systemctl restart my-app.service",
		"systemctl restart other-service.service",
		"sudo systemctl restart my-app",
		'bash -c "systemctl restart my-app"',
		"echo hi; systemctl restart my-app",
		"$(systemctl restart my-app)",
		"systemctl restart pi-roles",
		"systemctl kill pi-roles.service",
		"sudo systemctl restart pi-roles",
		'bash -c "systemctl restart pi-roles"',
		"FLUSH_RESTART_NOW=1 bin/flush-restart my-app",
		"env FLUSH_RESTART_NOW=1 bin/flush-restart other-service",
		"FLUSH_RESTART_NOW=1 systemctl restart my-app",
	];

	it.each(refused)("refuses: %s", (command) => {
		const reason = refuseReason(command, 0, GUARDED);
		expect(reason, command).toBeDefined();
		if (command.includes("pi-roles")) {
			expect(reason, command).toContain("never restarts its own host");
		} else {
			expect(reason, command).toContain("bin/flush-restart");
		}
	});

	const allowed: string[] = [
		"bin/flush-restart my-app",
		"bin/flush-restart other-service",
		"systemctl status my-app",
		"systemctl --user status my-app",
		"systemctl restart nginx",
		"systemctl stop docker",
		"journalctl -u my-app",
		"journalctl -u other-service.service",
		"npm run gate",
		'echo "FLUSH_RESTART_NOW=1 is the operator\'s override"',
		"grep FLUSH_RESTART_NOW docs/*.md",
		"git -C /srv/demo log --oneline -1",
		// Without the configured list only the own host stays guarded.
		"systemctl restart my-app",
	];

	it.each(allowed)("allows: %s", (command) => {
		if (command === "systemctl restart my-app") {
			expect(refuseReason(command)).toBeUndefined();
		} else {
			expect(refuseReason(command, 0, GUARDED), command).toBeUndefined();
		}
	});
});
