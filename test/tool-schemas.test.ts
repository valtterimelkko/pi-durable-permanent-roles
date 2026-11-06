/**
 * Characterisation fixture for every tool the host registers.
 *
 * The fixture `test/fixtures/tool-schemas.json` holds the canonical JSON (object keys sorted, recursively) of each
 * tool's `parameters` schema. Regenerate it deliberately with `UPDATE_TOOL_SCHEMAS=1 npx vitest run
 * test/tool-schemas.test.ts` and diff it by hand; a silent wire-shape drift (a parameter lost, a bound changed, an
 * object closed) cannot then reach a role's model.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Extension } from "@earendil-works/pi-durable";
import { integrationsExtension } from "../src/integrations/tools.ts";
import { notifyExtension } from "../src/notify.ts";
import { docsCommitExtension } from "../src/docs-commit.ts";

const TOOL_NAMES = [
	"docs_commit",
	"memory_capture",
	"memory_recall",
	"notify_owner",
	"peer_ask_owner",
	"peer_reply",
	"peer_thread_close",
	"raise_item",
	"report_run",
	"resolve_item",
];

function neverRole(): undefined {
	return undefined;
}

/** The three extensions between them register every host-authored tool; the fakes are never called (schemas only). */
function harvest(): Extension[] {
	return [
		integrationsExtension({
			capture: async () => {},
			channel: {
				reply: async () => "",
				askOwner: async () => "",
				close: async () => "",
			},
			roleForConversation: neverRole,
		}),
		notifyExtension({}),
		docsCommitExtension({
			roleForConversation: neverRole,
			runner: { async run() { return { code: 0, stdout: "", stderr: "" }; } },
		}),
	];
}

type NamedSchema = { name: string; parameters: unknown };

function toolSchemas(): NamedSchema[] {
	return harvest().flatMap((extension) =>
		(extension.tools ?? []).map((tool) => ({ name: tool.name, parameters: tool.parameters })),
	);
}

/** Canonical form: every object's keys sorted, recursively, so key order can never flake the fixture. */
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([key, entry]) => [key, canonical(entry)]),
		);
	}
	return value;
}

describe("every host-authored tool's schema", () => {
	const schemas = toolSchemas();

	it("registers exactly the tool names the host promises, once each", () => {
		expect(schemas.map((schema) => schema.name).sort()).toEqual([...TOOL_NAMES].sort());
	});

	it("matches the frozen fixture (regenerate deliberately with UPDATE_TOOL_SCHEMAS=1)", () => {
		const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "tool-schemas.json");
		const fresh = canonical(Object.fromEntries(schemas.map((schema) => [schema.name, schema.parameters])));
		if (process.env.UPDATE_TOOL_SCHEMAS === "1") {
			mkdirSync(dirname(fixturePath), { recursive: true });
			writeFileSync(fixturePath, `${JSON.stringify(fresh, undefined, "\t")}\n`, "utf8");
		}
		const frozen = JSON.parse(readFileSync(fixturePath, "utf8")) as unknown;
		expect(JSON.stringify(fresh)).toBe(JSON.stringify(canonical(frozen)));
	});
});
