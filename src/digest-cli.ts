/**
 * roles-digest CLI: build the digest, write `<stateDir>/digest/<date>.{json,md}`, print the notification text — and
 * with --send, send exactly that text through the owner-notification path (STANDING_ROLES_NOTIFY_COMMAND, or the
 * JSONL file when unset). With --card, the digest's needs-you card is raised when there is something to decide
 * (off by default, so tests and dry runs never write needs-you lines).
 *
 *   bin/roles-digest [--now ISO] [--state-dir DIR] [--roles-dir DIR] [--send] [--card]
 *
 * State directory: STANDING_ROLES_STATE_DIR (default /var/lib/pi-roles). Roles: this repository's roles/.
 * Never sends unless --send is given; never raises a card unless --card is given.
 */
import { buildDigest, parseDigestArgs, writeDigest } from "./digest.ts";
import { raiseDigestCard } from "./digest-card.ts";
import { jsonlNotifier, notifyCommandSender } from "./notify.ts";

/**
 * Send the digest text through the configured owner-notification path. Exported for tests: they pass a recording
 * sender, so no test can send for real.
 */
export function sendNotification(
	text: string,
	options: { notifyCommand?: string; stateDir: string },
): Promise<void> {
	const sender = options.notifyCommand !== undefined ? notifyCommandSender(options.notifyCommand) : jsonlNotifier(options.stateDir);
	return sender("Roles digest", text);
}

async function main(): Promise<void> {
	const args = parseDigestArgs(process.argv.slice(2), process.env, defaultRolesDir());
	const digest = await buildDigest({
		now: args.now,
		stateDir: args.stateDir,
		rolesDir: args.rolesDir,
	});
	if (args.card) {
		try {
			const cardId = await raiseDigestCard(args.stateDir, digest);
			if (cardId !== undefined) digest.cardId = cardId;
		} catch (error) {
			process.stderr.write(`roles-digest: the card could not be raised: ${error instanceof Error ? error.message : String(error)}\n`);
		}
	}
	const paths = writeDigest(args.stateDir, digest);
	process.stdout.write(`${digest.notification}\n`);
	process.stderr.write(`wrote ${paths.jsonPath} and ${paths.mdPath}\n`);
	if (!args.send) return;
	await sendNotification(digest.notification, { notifyCommand: process.env.STANDING_ROLES_NOTIFY_COMMAND, stateDir: args.stateDir });
	process.stderr.write("sent\n");
}

function defaultRolesDir(): string {
	return new URL("../roles/", import.meta.url).pathname.replace(/\/$/, "");
}

try {
	await main();
} catch (error) {
	process.stderr.write(`roles-digest: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
