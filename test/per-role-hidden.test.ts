/** Hidden command lines (eval, here-strings, pipes into a shell, script files) are judged as command lines. */
import { it, expect } from "vitest";
import { neverRunTable, tableBashRefusal, type MessagingRule } from "../src/messaging-limit.ts";
import { docsOnlyBashRefusal } from "../src/docs-commit.ts";

const table = neverRunTable(
	[
		{
			cli: "your-mail-cli",
			surface: "the watched mailbox",
			verbs: [{ path: ["draft", "new"] }, { path: ["send"] }, { path: ["auth", "logout"] }],
			flags: [],
		},
	] satisfies MessagingRule[],
	"roles/work-messages/MESSAGING.md",
	"work-messages",
);

const refusal = (command: string): string | undefined => tableBashRefusal(table, command);

const hidden = [
	'eval "your-mail-cli draft new --to a@b"',
	'echo "your-mail-cli send --to 1" | bash',
	"bash <<< 'your-mail-cli send x'",
	"su -c 'your-mail-cli auth logout'",
	"python3 /opt/tools/your-mail-cli.py draft new --to a@b",
];
for (const c of hidden) it(`messaging refuses: ${c}`, () => expect(refusal(c)).toBeDefined());

const docs = ['eval "git commit -m x"', "echo 'git push' | sh", "bash <<< 'git add .'", "su -c 'git push'"];
for (const c of docs) it(`docs-only refuses: ${c}`, () => expect(docsOnlyBashRefusal(c)).toBeDefined());

it("reads stay allowed", () => {
	expect(refusal('eval "your-mail-cli list --since 2026-10-20"')).toBeUndefined();
	expect(docsOnlyBashRefusal("echo 'git status' | sh")).toBeUndefined();
});
