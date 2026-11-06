# The shipped roles

Each role is a folder in `roles/`: `settings.json` (the trigger and wiring), `instructions.md` (the
role's judgement), reference files (the role's ground truth), and — for the message watchers — a
`never-run.json` table the code guard enforces. The shared preamble (`roles/PREAMBLE.md`) is
prepended to every role's instructions; it carries the working style, the notes discipline, the
rules process and the shared limits. Switch any role off with `"enabled": false`, or delete the
folder.

Schedules are in the host's configured time zone (`STANDING_ROLES_TIMEZONE`). Every role ships
`"enabled": false`, and the example unit ships `STANDING_ROLES_SCHEDULES=off` — a fresh install
runs nothing. Nothing runs until you enable a role AND switch schedules on. The times below are
examples; change them to your routine.

## runtime-keeper

- **Purpose**: every runtime the agents on the host run on (coding-agent CLIs, SDKs, the servers
  that host them) stays current, working together, upgraded in a dependency order that never breaks
  something downstream.
- **Checks daily**: installed vs latest version per runtime, changelog reading on every change,
  upgrade in order, verification after (flags, gate, a disposable live run), and restarts only
  through `bin/flush-restart` when a service is provably idle.
- **May change**: the runtimes it manages, through their documented upgrade paths.
- **Must ask about**: breaking changes it cannot assess before upgrading; anything needing the
  role host's own restart (it notifies; another agent restarts the host).
- **Reference files**: `RUNTIMES.md` (per-runtime six-field entries — two worked examples), and
  `UPDATING.md` (the proof that must come before any production restart).
- **Schedule**: daily 03:00 (example — change it).
- **Switch off**: `"enabled": false` in `roles/runtime-keeper/settings.json`.

## system-updates

- **Purpose**: the operating system's own software stays current and patched; disk stays measured;
  the services in `SERVICES.md` stay updated under their standing permission.
- **Checks each run**: `/tmp` mode (a watch fires the role when it drifts from `1777`), upgradable
  packages (apply now / hold for reboot / leave to the runtime keeper), the restart-needed list,
  free space, the weekly sweep (measure and delegate, never delete).
- **May change**: system packages through the documented non-interactive invocation; services
  updated one at a time and health-checked.
- **Must ask about**: anything needing a reboot (hold and remind); critical infrastructure (the
  gateway/auth layer is never this role's to touch).
- **Reference files**: `UPDATES.md` (sources, invocations, restart duty), `DISK.md` (the
  suggest-don't-clean cache list, the weekly sweep), `SERVICES.md` (your services; a template).
- **Schedule**: weekdays 04:00 (example — change it), plus the `tmp-mode` watch (every 60 s).
- **Switch off**: `"enabled": false`, and remove the watch if you do.

## docs-currency

- **Purpose**: the documentation of the repositories in `TARGETS.md` stays current — small,
  surgical fixes, committed the same night; uncommitted work flagged everywhere, never touched.
- **Checks each run**: what moved in each target repository since its cursor; the docs that
  describe the changed files; every target's uncommitted changes (one line each, contents never).
- **May change**: documentation only, and only through `docs_commit` — the hard limit refuses the
  git write commands in its bash and non-documentation paths in the tool.
- **Must ask about**: ambiguous drift, restructuring, anything that would rewrite a guide's binding
  rules, repositories whose docs are too far behind for surgical fixes.
- **Reference files**: `TARGETS.md` (your repositories, `fix` or `watch` status).
- **Schedule**: daily 22:00 (example — change it).
- **Switch off**: `"enabled": false`.

## work-messages (read-only example)

- **Purpose**: watches a work mailbox or chat and reports what needs the operator, with a one-line
  why. Never writes to the account it watches.
- **Checks each run**: new arrivals through the read commands of `YOUR_MAIL_CLI` (the placeholder
  for your own read-capable CLI), against the flags and threads it follows.
- **May change**: nothing outside its notes folder.
- **Must ask about**: everything that looks like a write; the guard refuses the never-run table,
  and the role never tests its edges.
- **Reference files**: `MESSAGING.md` (the source of truth for the never-run list), and
  `never-run.json` (the machine-readable table the code guard loads; a drift test keeps the pair
  in step).
- **Schedule**: weekdays 08:00, 13:00, 18:00 (examples — change them).
- **Limits**: `read-only-messaging` with `readOnlyRules: "never-run.json"`.
- **Switch off**: `"enabled": false`.

## personal-messages (read-only example)

- **Purpose**: watches personal mail twice a day, every day, and surfaces what matters with a why
  (an always-flag list you fill in, plus anything the operator has engaged with before).
- **Checks each run**: new mail since the watermark per mailbox; engagement (replied, written to,
  answered marker) for everything outside the always-flag list.
- **May change**: nothing outside its notes folder. Read-only by limit and by instruction.
- **Reference files**: `MAIL.md` (read commands, watermark scheme, always-flag list, failure
  handling), and `never-run.json`.
- **Schedule**: daily 08:00 and 18:00 (examples — change them).
- **Limits**: `read-only-messaging` with its own `never-run.json`.
- **Switch off**: `"enabled": false`.

## example (disabled)

The format documentation, shipped disabled. Copy it to start a real role; see
docs/WRITING-A-ROLE.md for the walk-through.

## The daily digest

`bin/roles-digest` (systemd: `pi-roles-digest.timer`, 06:30) joins the last 24 hours: per role —
runs, unreported runs, named counts against the 7-day median, what it did, what it could not
cover, notes changes, pending rule proposals, every-run misses. One notification text, plus
`<stateDir>/digest/<date>.json` and `.md`. With `--card` it raises at most one needs-you item,
only when there is something to decide. With `--send` it delivers through the configured
notification path (or appends to `notifications.jsonl`).
