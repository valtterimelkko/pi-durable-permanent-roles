/** The environment → config mapping. */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
	it("defaults: schedules off, integrations off, notifications to the JSONL file, UTC, pi-roles", () => {
		const config = loadConfig({});
		expect(config.stateDir).toBe("/var/lib/pi-roles");
		expect(config.schedules).toBe(false);
		expect(config.reportNudge).toBe(true);
		expect(config.integrations).toBe(false);
		expect(config.integrationsCommand).toBeUndefined();
		expect(config.notifyCommand).toBeUndefined();
		expect(config.timezone).toBe("UTC");
		expect(config.guardedServices).toEqual([]);
		expect(config.serviceName).toBe("pi-roles");
		expect(config.guideCheck).toBeUndefined();
	});

	it("reads the state dir and roles root from the environment", () => {
		const config = loadConfig({ STANDING_ROLES_STATE_DIR: "/srv/state", STANDING_ROLES_ROOT: "/srv/roles/" });
		expect(config.stateDir).toBe("/srv/state");
		expect(config.rolesRoot).toBe("/srv/roles/");
	});

	it("flags accept on/off and ignore anything else", () => {
		expect(loadConfig({ STANDING_ROLES_SCHEDULES: "on" }).schedules).toBe(true);
		expect(loadConfig({ STANDING_ROLES_SCHEDULES: "off" }).schedules).toBe(false);
		expect(loadConfig({ STANDING_ROLES_SCHEDULES: "yes" }).schedules).toBe(false);
		expect(loadConfig({ STANDING_ROLES_REPORT_NUDGE: "off" }).reportNudge).toBe(false);
	});

	it("integrations and notifications", () => {
		const on = loadConfig({ STANDING_ROLES_INTEGRATIONS: "on", STANDING_ROLES_INTEGRATIONS_COMMAND: "/usr/local/bin/my-integrations" });
		expect(on.integrations).toBe(true);
		expect(on.integrationsCommand).toBe("/usr/local/bin/my-integrations");
		expect(loadConfig({ STANDING_ROLES_INTEGRATIONS: "on" }).integrationsCommand).toBeUndefined();
		expect(loadConfig({ STANDING_ROLES_NOTIFY_COMMAND: "/usr/local/bin/notify" }).notifyCommand).toBe("/usr/local/bin/notify");
	});

	it("time zone, guarded services and the own-host name", () => {
		const config = loadConfig({
			STANDING_ROLES_TIMEZONE: "Europe/Helsinki",
			STANDING_ROLES_GUARDED_SERVICES: "my-app.service, other-app",
			STANDING_ROLES_SERVICE_NAME: "my-roles",
			STANDING_ROLES_GUIDE_CHECK: "/usr/local/bin/guide-check",
		});
		expect(config.timezone).toBe("Europe/Helsinki");
		expect(config.guardedServices).toEqual(["my-app", "other-app"]);
		expect(config.serviceName).toBe("my-roles");
		expect(config.guideCheck).toBe("/usr/local/bin/guide-check");
	});

	it("the pi agent dir falls back to the home directory", () => {
		expect(loadConfig({ HOME: "/home/ada" }).piAgentDir).toBe("/home/ada/.pi/agent");
		expect(loadConfig({ STANDING_ROLES_PI_DIR: "/pi" }).piAgentDir).toBe("/pi");
	});
});
