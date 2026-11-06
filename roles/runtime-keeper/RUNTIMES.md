# RUNTIMES.md — what the keeper keeps current

This file is the keeper's own ground truth, and the keeper maintains it. Every claim should name the command or
file it was read from. Versions drift — re-verify each command's output before acting on it, and treat a mismatch
between this file and the host as a finding to report, not a puzzle to work around. Nothing here upgrades, installs
or restarts anything by itself; the commands are what the keeper runs, under the limits in `instructions.md`.

Start by filling this file in for the runtimes on **your** host: the coding-agent CLIs and SDKs you run, the servers
that host them, the launchers and catalogues that reference them. Two worked examples follow; replace or extend
them with your own entries. Keep the shape: installed version, latest version, changelog, upgrade, check after,
restart.

**Dependency order** (upgrade top to bottom; a runtime only after the one it follows). Write yours once, keep it
current, and never break it:

1. the language runtime and its package manager (node, npm);
2. the standalone agent CLIs (each upgrade before the things that embed it);
3. the servers and SDKs built on those CLIs (an SDK follows the CLI, never leads it);
4. the wrappers, launchers and catalogues that reference the above.

A run only acts when a version actually changed. Restarts go through `bin/flush-restart` only.

## Example entry 1: the pi coding agent (npm-global CLI)

- **Installed version:** `npm ls -g @earendil-works/pi-coding-agent --depth=0` (or read the `version` field in the
  installed package's `package.json`).
- **Latest version:** `npm view @earendil-works/pi-coding-agent version` (the registry).
- **Changelog:** `CHANGELOG.md` inside the installed package; the upstream repository is in the package's
  `repository` field.
- **Upgrade:** the CLI's own update command, or `npm install -g` the new version. If a local wrapper script execs
  the real binary, read the wrapper afterwards: it must survive every upgrade.
- **Check after:** the installed package.json shows the new version; `pi --help` still exits 0.
- **Restart:** none — running sessions keep their loaded copy; new sessions pick the new one up.

## Example entry 2: an SDK embedded in a long-running server

- **Installed version:** the exact pins in the server checkout's `package.json` (and the copies under its
  `node_modules`), for each SDK package the server embeds.
- **Latest version:** the same registry query as the standalone CLI's entry — the SDK follows the CLI, never
  leads it.
- **Changelog:** the CLI's own changelog, read for API changes that touch what the server imports.
- **Upgrade:** bump the pins in the server's checkout, install in that checkout, build. This is a production
  checkout other agents may work in — check before you touch it, and never leave the tree dirty.
- **Check after:** the checkout's own gate and typecheck; then its live-validation scripts in a disposable
  configuration — never against production state. Only then restart.
- **Restart:** yes — production runs the built output; a flush restart puts the new SDK in front of every session.

## Adding a runtime

For each new runtime, research once and write the six fields above, plus anything the next adopter of this host
would trip over (a wrapper script, a second install location, a version pin held by another tool). Name the
command each fact was read from. If two runtimes share a changelog or an upgrade path, say so once and point at
it — do not maintain the same instructions twice.
