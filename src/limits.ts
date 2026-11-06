/**
 * The hard limit every role runs under: the bash tool refuses to reboot or
 * shut down the host. One of the few rules in code rather than in the role's instructions:
 * a breach cannot be undone and the role would not see it happen.
 *
 * `refuseReason` is a pure function over the command text: it
 * tokenises shell-ishly, treats `;`, `&&`, `||`, `|`, `&`, `(`, `)`, `{`, `}`, `$(`,
 * backticks and newlines as command boundaries, recurses into the string argument of
 * `bash|sh|dash|zsh -c` and into `$(...)`/backticks, skips pass-through prefixes (`sudo`
 * with its flags, `env` with assignments, bare `VAR=val`, `exec`, `nohup`, `nice`,
 * `command`, `time`, `xargs`, `busybox`, `timeout <n>`), and refuses the command word when
 * its basename is reboot|shutdown|poweroff|halt|kexec, or init|telinit with 0|6, or
 * systemctl/loginctl with reboot|poweroff|halt|kexec anywhere in its words or a
 * reboot|poweroff|halt|kexec `*.target`. It also refuses direct restarts of the guarded services:
 * `systemctl restart|stop|kill|try-restart|reload-or-restart` of any unit in
 * STANDING_ROLES_GUARDED_SERVICES, or of the role host itself (STANDING_ROLES_SERVICE_NAME)
 * (`--user` forms and `.service` suffixes included), and any `FLUSH_RESTART_NOW=` assignment —
 * all with a reason pointing to `bin/flush-restart`, which stays allowed (it is the guard).
 * The role host gets the own-host reason: a role never restarts its own host — notify_owner,
 * and another agent runs the restart when no role is busy. Any command text containing
 * `/proc/sysrq-trigger` or `login1.Manager.Reboot/PowerOff/Halt` is refused outright. A
 * word inside a quoted argument of another command (`echo "…reboot…"`) is text.
 */
import { defineExtension, wrapTool } from "@earendil-works/pi-durable";
import { createBashTool } from "@earendil-works/pi-durable/tools";

/** The guarded service list: the configured units plus the role host's own. */
export interface Guarded {
	services: ReadonlySet<string>;
	/** The role host's own unit: never a role's own restart. */
	ownHostService: string;
}

/** The default when no configuration is passed (tests, and the guard still covers the host itself). */
export const DEFAULT_GUARDED: Guarded = { services: new Set(), ownHostService: "pi-roles" };

/** Commands that stop the whole host. Compared on the basename, so /sbin/reboot matches. */
const REFUSED_BINARIES = new Set(["reboot", "shutdown", "poweroff", "halt", "kexec"]);
/** `init`/`telinit` to runlevel 0 (halt) or 6 (reboot). */
const REFUSED_RUNLEVELS = new Set(["0", "6"]);
/** `systemctl`/`loginctl` words that stop or reboot the host. */
const REFUSED_CONTROL_WORDS = new Set(["reboot", "poweroff", "halt", "kexec"]);
/** Shells whose `-c` string is really the command line. */
const SHELLS = new Set(["bash", "sh", "dash", "zsh"]);
/** Commands whose `-c` argument is itself a command line (the shells, and `su`). */
const RUNS_C_STRING = new Set([...SHELLS, "su"]);
/** Prefixes that only change how the next command runs; the command word follows them. */
const PASS_THROUGH = new Set(["sudo", "exec", "nohup", "env", "nice", "command", "time", "xargs", "busybox", "timeout"]);
/** Flags whose next word is the flag's value, not the command. (`-n` is handled per-command: numeric.) */
const FLAGS_WITH_VALUE = new Set(["-u", "-g", "--user", "--group"]);
/** Flags of `timeout` that take a separate value (`-s 9`, `-k 5`). */
const TIMEOUT_FLAGS_WITH_VALUE = new Set(["-s", "-k", "--signal", "--kill-after"]);
/** Text that always means the host is about to be stopped, however it is spelled. */
const REFUSED_TEXT = ["/proc/sysrq-trigger", "login1.Manager.Reboot", "login1.Manager.PowerOff", "login1.Manager.Halt"];
/**
 * Every role bash call gets this default timeout, in seconds (Pi Durable's bash takes seconds), unless the
 * call sets its own — one hung command (a scan in a FUSE mount, a stuck build) must not hold a role busy
 * for an hour.
 */
export const DEFAULT_BASH_TIMEOUT_SECONDS = 1200;
/**
 * A role's bash refuses direct restarts of the guarded services — they go through `bin/flush-restart` only.
 * The list is configuration (STANDING_ROLES_GUARDED_SERVICES); the role host's own unit
 * (STANDING_ROLES_SERVICE_NAME) is always guarded, with the own-host reason. `bin/flush-restart` itself
 * stays allowed — it is the guard.
 */
const GUARD_VERBS = new Set(["restart", "stop", "kill", "try-restart", "reload-or-restart"]);
const GUARD_NOTICE = "a role restarts services only through bin/flush-restart";

function basenameOf(word: string): string {
	const stripped = word.replace(/\/+$/, "");
	const slash = stripped.lastIndexOf("/");
	return slash >= 0 ? stripped.slice(slash + 1) : stripped;
}

/** Strip one layer of matching quotes (or any wrapping quote characters) from a word. */
function unquote(word: string): string {
	let out = word.trim();
	while (out.length >= 2 && ((out.startsWith("'") && out.endsWith("'")) || (out.startsWith('"') && out.endsWith('"')))) {
		out = out.slice(1, -1).trim();
	}
	return out;
}

/**
 * Split one line into runnable segments at the shell's command boundaries, respecting
 * quotes (a boundary inside quotes is text): `;`, `&&`, `||`, `|`, `&`, `(`, `)`, `{`, `}`.
 */
export function commandSegments(line: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: string | undefined;
	for (let i = 0; i < line.length; i++) {
		const char = line[i]!;
		if (quote !== undefined) {
			current += char;
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			current += char;
			continue;
		}
		if (char === ";" || char === "|" || char === "&" || char === "(" || char === ")" || char === "{" || char === "}") {
			segments.push(current);
			current = "";
			if ((char === "|" || char === "&") && line[i + 1] === char) i++;
			continue;
		}
		current += char;
	}
	segments.push(current);
	return segments;
}

/** The words of one segment; a quoted chunk stays inside its word. */
function wordsOf(segment: string): string[] {
	const words: string[] = [];
	let current = "";
	let quote: string | undefined;
	for (const char of segment) {
		if (quote !== undefined) {
			current += char;
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			current += char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current !== "") words.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (current !== "") words.push(current);
	return words;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Analyse one segment: skip pass-through prefixes and their flags/assignments, then judge
 * the command word (recursing into a `bash -c` string). Returns the refusal reason or
 * undefined. `wasTimeout`/`wasNice` let `timeout 10` and `nice -n 10` drop their value.
 */
function analyseSegment(segment: string, depth: number, guarded: Guarded): string | undefined {
	const words = wordsOf(segment);
	let index = 0;
	let inPrefix = false;
	let lastWord = "";
	let prefixCommand = "";
	let timeoutDurationSeen = false;
	while (index < words.length) {
		const word = words[index]!;
		if (PASS_THROUGH.has(word)) {
			inPrefix = true;
			lastWord = word;
			prefixCommand = word;
			index++;
			continue;
		}
		// `timeout [flags] DURATION command`: the first bare number after its flags is the duration.
		if (prefixCommand === "timeout" && !timeoutDurationSeen && /^\d+(\.\d+)?[smhd]?$/.test(word)) {
			timeoutDurationSeen = true;
			index++;
			continue;
		}
		if (prefixCommand === "timeout" && TIMEOUT_FLAGS_WITH_VALUE.has(word) && words[index + 1] !== undefined) {
			index += 2;
			continue;
		}
		if (inPrefix || ASSIGNMENT.test(word)) {
			// Inside a prefix run: flags, their values and assignments are not commands.
			if (word === "--") {
				index++;
				continue;
			}
			if (word.startsWith("-")) {
				lastWord = word;
				index++;
				if (FLAGS_WITH_VALUE.has(word) && words[index] !== undefined && !words[index]!.startsWith("-")) index++;
				continue;
			}
			if (ASSIGNMENT.test(word)) {
				index++;
				continue;
			}
			if ((lastWord === "timeout" || lastWord === "nice" || lastWord === "-n") && /^\d+([smhdw]?)$/.test(word)) {
				lastWord = "";
				index++;
				continue;
			}
		}
		break;
	}
	const verb = words[index];
	if (verb === undefined) return undefined;
	const name = basenameOf(unquote(verb));
	// A flush-restart's window override is never a role's to set — however it reaches the command line.
	for (const word of words) {
		if (word.startsWith("FLUSH_RESTART_NOW=")) {
			return `refused: FLUSH_RESTART_NOW is the operator's override, never a role's — run bin/flush-restart without it`;
		}
	}
	if (name === "systemctl") {
		// The first non-flag word is the verb; a guarded unit anywhere after a guard verb is refused.
		const rest = words.slice(index + 1).map(unquote);
		const firstBare = rest.findIndex((word) => !word.startsWith("-"));
		if (firstBare >= 0 && GUARD_VERBS.has(rest[firstBare]!)) {
			for (const word of rest.slice(firstBare + 1)) {
				if (word.startsWith("-")) continue;
				const unit = basenameOf(word).replace(/\.service$/, "");
				if (unit === guarded.ownHostService) {
					// The role host is never a role's own restart — notify_owner instead.
					return `refused: systemctl ${rest[firstBare]} ${unit} would restart the role host itself; a role never restarts its own host — notify_owner instead, and another agent runs the restart when no role is busy`;
				}
				if (guarded.services.has(unit)) {
					return `refused: systemctl ${rest[firstBare]} ${unit} would disrupt a guarded service; ${GUARD_NOTICE}`;
				}
			}
		}
	}
	// A scan started at / can hang unkillably for up to an hour on a FUSE or network mount.
	// find, du, grep -r and rg refuse the root start unless -xdev scopes them — a
	// guard, not a sandbox; the preamble's rule is the real control.
	if (name === "find" || name === "du" || name === "grep" || name === "rg") {
		const rest = words.slice(index + 1).map(unquote);
		// rg and find/du are recursive by nature; grep only with -r/-R (also inside a short cluster like -rn).
		const recursive = name !== "grep" || rest.some((word) => /^-[a-zA-Z]*[rR]/.test(word));
		if (recursive) {
			// find/du take the start path as their first non-flag word; grep/rg take paths last.
			const starts = name === "find" || name === "du"
				? [rest.find((word) => !word.startsWith("-"))]
				: rest.filter((word) => !word.startsWith("-")).slice(-1);
			const scoped = rest.some(
				(word) =>
					word === "-xdev" ||
					(name === "du" && (word === "-x" || word === "--one-file-system")),
			);
			if (!scoped && starts.some((start) => start !== undefined && /^\/$/.test(start))) {
				return `refused: a scan starting at / can hang on a FUSE or network mount for up to an hour — search below a real root or add -xdev`;
			}
		}
	}
	if (REFUSED_BINARIES.has(name)) {
		return `refused: ${name} would stop or reboot the host, which no role may do`;
	}
	if ((name === "init" || name === "telinit") && words[index + 1] !== undefined) {
		const runlevel = unquote(words[index + 1]!);
		if (REFUSED_RUNLEVELS.has(runlevel)) {
			return `refused: ${name} ${runlevel} would halt or reboot the host, which no role may do`;
		}
	}
	if (name === "systemctl" || name === "loginctl") {
		for (const word of words.slice(index + 1)) {
			const bare = unquote(word);
			if (REFUSED_CONTROL_WORDS.has(bare) || REFUSED_CONTROL_WORDS.has(basenameOf(bare))) {
				return `refused: ${name} ${bare} would stop or reboot the host, which no role may do`;
			}
			const target = /\.target$/.exec(basenameOf(bare));
			if (target !== undefined && REFUSED_CONTROL_WORDS.has(basenameOf(bare).replace(/\.target$/, ""))) {
				return `refused: ${name} ${bare} would stop or reboot the host, which no role may do`;
			}
		}
	}
	if (name === "eval" && depth < 8) {
		// `eval` runs its arguments as a command line.
		const reason = refuseReason(words.slice(index + 1).map(unquote).join(" "), depth + 1, guarded);
		if (reason !== undefined) return reason;
	}
	if (RUNS_C_STRING.has(name) && depth < 8) {
		// Recurse into the -c string (also combined flags such as -lc, -ec) and a `<<<` here-string:
		// each is really a command line.
		for (let j = index + 1; j < words.length; j++) {
			const flag = words[j]!;
			const isC = /^-[A-Za-z]*c[A-Za-z]*$/.test(flag);
			if (!isC && flag !== "<<<") continue;
			const script = words[j + 1];
			if (script === undefined) break;
			const reason = refuseReason(unquote(script), depth + 1, guarded);
			if (reason !== undefined) return reason;
			if (isC) break;
		}
	}
	return undefined;
}

/** Recurse into every `$(...)` (with nesting) and backtick span of one line. */
function substitutions(line: string, depth: number, guarded: Guarded): string | undefined {
	for (let i = 0; i < line.length - 1; i++) {
		if (line[i] === "$" && line[i + 1] === "(") {
			let nesting = 1;
			let j = i + 2;
			while (j < line.length && nesting > 0) {
				if (line[j] === "(") nesting++;
				if (line[j] === ")") nesting--;
				j++;
			}
			const inner = line.slice(i + 2, j - 1);
			const reason = refuseReason(inner, depth + 1, guarded);
			if (reason !== undefined) return reason;
			i = j;
		}
	}
	for (let i = 0; i < line.length; i++) {
		if (line[i] !== "`") continue;
		const end = line.indexOf("`", i + 1);
		if (end < 0) break;
		const reason = refuseReason(line.slice(i + 1, end), depth + 1, guarded);
		if (reason !== undefined) return reason;
		i = end;
	}
	return undefined;
}

/**
 * Why the command must not run, or undefined when it may. See the module header for what is
 * refused and what deliberately passes (`echo reboot-notes`, `git log --grep=shutdown`,
 * `cat /var/run/reboot-required`, quoted mentions, `systemctl status …`).
 */
/**
 * `echo …  | bash` and `printf … | sh`: a shell that reads its script from stdin runs what is echoed into it, so the
 * echoed text is judged as a command line. A shell given -c or a file is judged on its own arguments elsewhere.
 */
function pipedIntoShell(line: string, depth: number, guarded: Guarded): string | undefined {
	const match = /(?:^|[;&|(]\s*)(?:echo|printf)\s+(.+?)\s*\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:\/\S*\/)?(?:bash|sh|dash|zsh)(?:\s+-s)?\s*(?:$|[;&|)])/.exec(line);
	if (match === null || depth >= 8) return undefined;
	const script = match[1]!.replace(/(["'])(.*?)\1/g, "$2").replace(/\\n/g, "\n");
	return refuseReason(script, depth + 1, guarded);
}

export function refuseReason(command: string, depth = 0, guarded: Guarded = DEFAULT_GUARDED): string | undefined {
	if (depth > 8) return undefined;
	// Text that always means a stop, however it is wrapped (dbus-send's reboot call, sysrq).
	for (const needle of REFUSED_TEXT) {
		if (command.includes(needle)) {
			return `refused: this command would stop or reboot the host (${needle}), which no role may do`;
		}
	}
	for (const line of command.split("\n")) {
		const piped = pipedIntoShell(line, depth, guarded);
		if (piped !== undefined) return piped;
		const substitution = substitutions(line, depth, guarded);
		if (substitution !== undefined) return substitution;
		for (const segment of commandSegments(line)) {
			const reason = analyseSegment(segment, depth, guarded);
			if (reason !== undefined) return reason;
		}
	}
	return undefined;
}

/** The extension installed in every role registry: it wraps whichever tool won the name `bash`. */
export function limitsExtension(options: { guardedServices?: readonly string[]; ownHostService?: string } = {}): ReturnType<typeof defineExtension> {
	const guarded: Guarded = {
		services: new Set(options.guardedServices ?? []),
		ownHostService: options.ownHostService ?? DEFAULT_GUARDED.ownHostService,
	};
	return defineExtension({
		name: "role-limits",
		wraps: [wrapTool(createBashTool(), (bash) => wrapBashWithLimits(bash, guarded))],
	});
}

/** Wrap one bash tool so refused commands return an error result instead of running, and every call carries the default timeout. */
export function wrapBashWithLimits(bash: ReturnType<typeof createBashTool>, guarded: Guarded = DEFAULT_GUARDED): ReturnType<typeof createBashTool> {
	return {
		...bash,
		execute: async (args, api, context) => {
			const reason = refuseReason(args.command, 0, guarded);
			if (reason !== undefined) {
				return { output: [{ type: "text", text: reason }], isError: true };
			}
			// The durability default: the tool's own timeout option (seconds) when the call set none; a timeout
			// comes back as the tool's own error result, which says the command was stopped and why.
			const withTimeout =
				args.timeout === undefined ? ({ ...args, timeout: DEFAULT_BASH_TIMEOUT_SECONDS } as typeof args) : args;
			return bash.execute(withTimeout, api, context);
		},
	};
}

/**
 * Command lines hidden inside one line of shell, for the per-role limits (docs-only, read-only messaging) to judge the
 * same way this module judges reboots: the arguments of `eval`, the `-c` string of a shell or `su`, a `<<<` here-string
 * fed to a shell, and the text `echo`/`printf` pipes into a shell reading stdin. `$(…)`, backticks and `bash -c` the
 * per-role limits already handle themselves; listing `-c` here too is harmless.
 */
export function hiddenCommandLines(line: string): string[] {
	const found: string[] = [];
	const piped = /(?:^|[;&|(]\s*)(?:echo|printf)\s+(.+?)\s*\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:\/\S*\/)?(?:bash|sh|dash|zsh)(?:\s+-s)?\s*(?:$|[;&|)])/.exec(line);
	if (piped !== null) found.push(piped[1]!.replace(/(["'])(.*?)\1/g, "$2").replace(/\\n/g, "\n"));
	for (const segment of commandSegments(line)) {
		const words = wordsOf(segment);
		for (let i = 0; i < words.length; i++) {
			const name = basenameOf(unquote(words[i]!));
			if (name === "eval") {
				found.push(words.slice(i + 1).map(unquote).join(" "));
				break;
			}
			if (SHELLS.has(name) || name === "su") {
				for (let j = i + 1; j < words.length; j++) {
					const flag = words[j]!;
					const isC = /^-[A-Za-z]*c[A-Za-z]*$/.test(flag);
					if (!isC && flag !== "<<<") continue;
					const script = words[j + 1];
					if (script !== undefined) found.push(unquote(script));
					break;
				}
			}
		}
	}
	return found;
}
