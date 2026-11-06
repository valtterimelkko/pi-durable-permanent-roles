/**
 * Presence cards for the standing roles. The presence sink is how the owner and other agents see a
 * role at all, and how an inbox resolves a role's name, so the card must exist and must be current.
 */
import { describe, expect, it } from "vitest";
import type { RoleDefinition, RoleSettings } from "../src/types.ts";
import { IDLE_PRESENCE_STATE, heartbeatEffects, presenceEffect, type PresenceState } from "../src/integrations/presence.ts";

function role(name: string, overrides: Partial<RoleSettings> = {}): RoleDefinition {
	return {
		name,
		dir: `/srv/standing-roles/roles/${name}`,
		settings: {
			enabled: true,
			title: `${name} title`,
			boardName: `role-${name}`,
			schedule: [],
			cwd: `/srv/standing-roles/roles/${name}`,
			tools: ["integrations", "notify"],
			...overrides,
		},
		model: { provider: "faux", modelId: "m-1" },
		thinking: "high",
		instructions: "",
		notesDir: `/var/lib/standing-roles/roles/${name}/notes`,
	};
}

function valueAfter(argv: readonly string[], flag: string): string {
	const index = argv.indexOf(flag);
	if (index === -1) return "";
	return argv[index + 1] ?? "";
}

describe("a presence card effect", () => {
	it("carries the exact register argv for the role", () => {
		expect(presenceEffect(role("docs"), { status: "working", step: "reading the notes" })).toEqual({
			dedupeKey: expect.stringMatching(/^presence:role-docs:working:[0-9a-f]{8}$/),
			argv: [
				"presence",
				"register",
				"--name",
				"role-docs",
				"--title",
				"docs title",
				"--status",
				"working",
				"--step",
				"reading the notes",
			],
			refresh: true,
		});
	});

	it("keys a step separately, so a status change never overwrites another step", () => {
		const first = presenceEffect(role("docs"), { status: "working", step: "reading the notes" });
		const second = presenceEffect(role("docs"), { status: "working", step: "writing the note" });
		const waiting = presenceEffect(role("docs"), { status: "waiting", step: "reading the notes" });
		expect(second.dedupeKey).not.toBe(first.dedupeKey);
		expect(waiting.dedupeKey).not.toBe(first.dedupeKey);
	});
});

describe("the heartbeat", () => {
	it("re-registers every enabled role with its current status, and leaves disabled roles off the presence", () => {
		const keeper = role("runtime-keeper");
		const docs = role("docs");
		const off = role("system-updates", { enabled: false, boardName: "role-system-updates" });
		const states = new Map<string, PresenceState>([
			["runtime-keeper", { status: "working", step: "checking the rollout" }],
			["docs", IDLE_PRESENCE_STATE],
			["system-updates", { status: "working", step: "should never appear" }],
		]);
		const effects = heartbeatEffects([keeper, docs, off], states);
		expect(effects).toHaveLength(2);
		expect(valueAfter(effects[0]!.argv, "--name")).toBe("role-runtime-keeper");
		expect(valueAfter(effects[0]!.argv, "--status")).toBe("working");
		expect(valueAfter(effects[0]!.argv, "--step")).toBe("checking the rollout");
		expect(valueAfter(effects[1]!.argv, "--status")).toBe("waiting");
		expect(valueAfter(effects[1]!.argv, "--step")).toBe("idle");
	});
});
