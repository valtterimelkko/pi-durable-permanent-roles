# Adopting the permanent roles host

This guide takes you from a fresh clone to running roles on your own server. Read
docs/ARCHITECTURE.md once for the shape of the system; come back here for every configuration
value.

## Requirements

- Node.js 24 or newer. Node 24 runs the TypeScript sources directly; no build step.
- The host is installed by cloning this repository (`git clone`); it is not published to the npm
  registry (`package.json` is `"private": true` on purpose).
- A Pi-compatible model credential: the host reads the model registry and credentials the way the
  Pi coding agent does, from Pi's agent directory (default `~/.pi/agent`; set
  `STANDING_ROLES_PI_DIR` to point elsewhere). If you use Pi, you already have this.
- Linux with systemd recommended (the units in `systemd/` assume it), and enough memory for one
  model conversation at a time (the example units cap the host at 3 GB).
- No external services required: with everything at its defaults, the host runs, roles load, and
  notifications land in a local JSONL file.

## Install

```bash
git clone <this repository> /opt/pi-durable-permanent-roles
cd /opt/pi-durable-permanent-roles
npm ci
npm test            # proves the host on your machine without touching anything
STANDING_ROLES_STATE_DIR=$PWD/.state node src/main.ts   # boots quiet: nothing runs
```

Before anything runs: every role ships `"enabled": false`, and the example unit ships
`STANDING_ROLES_SCHEDULES=off` — a fresh install runs nothing. Fill in the role templates first
(see docs/ROLES.md), then turn roles on one at a time: set `"enabled": true` in the role's
settings.json, watch one run through `bin/roles status` and the role's transcript, and move to the
next.

Copy the systemd units if you want supervision:

```bash
cp systemd/pi-roles.service systemd/pi-roles-*.service systemd/pi-roles-*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now pi-roles pi-roles-backup.timer pi-roles-digest.timer
```

The shipped units assume `HOME=/root` and run as root; edit their `Environment=HOME=...`,
`WorkingDirectory`, `STANDING_ROLES_STATE_DIR` and other environment lines to match your layout
and user before enabling them.

## Set your model

`roles/defaults.json` sets the model and thinking level every role uses unless its own
`settings.json` overrides:

```json
{
  "model": { "provider": "anthropic", "modelId": "claude-sonnet-4-5" },
  "thinking": "high"
}
```

Use a provider and model id your Pi installation can serve (the same names `pi` uses).

## Configuration values

Every value is an environment variable. The systemd units show them in one place.

| Name | Default | Meaning |
|---|---|---|
| `STANDING_ROLES_STATE_DIR` | `/var/lib/pi-roles` | Durable state: `roles.db`, `admin.sock`, `roles/<name>/{notes,transcript.jsonl,status.json}`, `runs.jsonl`, `digest/`, `needs-you.jsonl`, `notifications.jsonl`, backups. |
| `STANDING_ROLES_ROOT` | this repository's `roles/` | Where roles are loaded from. |
| `STANDING_ROLES_SCHEDULES` | `off` | The schedule tick (60 s). `on` lets enabled roles run their slots; also gates watches. |
| `STANDING_ROLES_REPORT_NUDGE` | `on` | Remind a run that ended without `report_run`, then raise a card. |
| `STANDING_ROLES_INTEGRATIONS` | `off` | `on` enables the integration CLI (see the seams below). |
| `STANDING_ROLES_INTEGRATIONS_COMMAND` | unset | The integration CLI program, run with the built argv, no shell. Required when integrations are on. |
| `STANDING_ROLES_NOTIFY_COMMAND` | unset | The owner-notification program, run as `<command> <title> <body>`. Unset: notifications append to `<stateDir>/notifications.jsonl`. |
| `STANDING_ROLES_TIMEZONE` | `UTC` | IANA zone for schedules, digest days and notification dedupe buckets — `Europe/London`, `America/New_York`, any zone your `Intl` accepts; an unknown name falls back to UTC with one logged line. |
| `STANDING_ROLES_GUARDED_SERVICES` | empty | Comma-separated systemd units roles may never stop or restart directly (the flush-restart tool's list). |
| `STANDING_ROLES_SERVICE_NAME` | `pi-roles` | The role host's own unit name — never restarted by a role. |
| `STANDING_ROLES_GUIDE_CHECK` | unset | Repo-guide checker `docs_commit` runs when a role edits `AGENTS.md`/`CLAUDE.md` (`<checker> repo .` in the repository). Unset: the step is skipped. |
| `STANDING_ROLES_PI_DIR` | `~/.pi/agent` | Pi's agent directory (model registry and credentials), read-only. |
| `STANDING_ROLES_REFCHANGE_INITIAL` | empty | Comma-separated role names that get a reference-change input on first sight (default: first sight stores hashes silently). |
| `FLUSH_RESTART_IDLE_COMMAND_<NAME>` | unset | The idle probe for a guarded service (exit 0 = idle, else busy; stdout is the detail). Without a probe, flush-restart answers "not now". |
| `FLUSH_RESTART_RESTART_COMMAND_<NAME>` | `systemctl restart <service>` | The restart command for a service (split on whitespace). |
| `STANDING_ROLES_CGROUP_ROOT` | `/sys/fs/cgroup/system.slice/pi-roles.service` | The cgroup root the host reads its own memory numbers from. |

`on`/`off` flags accept exactly those words; anything else keeps the default.

## Which files to edit

- `roles/defaults.json` — your model (required before real runs).
- `roles/*/settings.json` — enable the roles you want (`"enabled": true`), set schedules to your
  routine, point `cwd` at a real working directory.
- `roles/work-messages/` and `roles/personal-messages/` — replace `YOUR_MAIL_CLI` with your own
  read-capable CLI in `MESSAGING.md`/`MAIL.md` **and** in `never-run.json` (both stay in step; a
  drift test checks the work-messages pair).
- `roles/docs-currency/TARGETS.md` — the repositories your docs keeper may fix.
- `roles/runtime-keeper/RUNTIMES.md` — the runtimes on your host (two worked examples included).
- `roles/system-updates/{UPDATES,DISK,SERVICES}.md` — your package sources, caches and services.

## What to delete if you do not need it

- The message watchers: delete `roles/work-messages/` and `roles/personal-messages/` (and nothing
  else — the read-only limit engine in `src/messaging-limit.ts` is generic and harmless without
  them).
- The docs keeper: delete `roles/docs-currency/`.
- Any role you do not want: set `"enabled": false` or delete the folder. The `roles/example` folder
  is documentation; delete it once real roles exist.
- The systemd digest and backup units: optional; run `bin/roles-digest` and `bin/roles-backup` any
  other way you like.

## Bring your own orchestration and memory

The host needs four capabilities it has no opinion about. Each is a TypeScript interface in
`src/integrations/types.ts`, with a default stub that works with no external system:

| Capability | Interface | Stub behaviour (default) | What it is for |
|---|---|---|---|
| Presence | `PresenceSink` (`register(card)`) | no-op | Publish each role as working/waiting so you and other agents can see them. |
| Memory | `MemoryBridge` (`recall(query)`, `capture({note, idempotencyKey})`) | recall answers a "not configured" notice; capture appends one JSON line to `<stateDir>/integrations/memory-captures.jsonl` | Grounding reads (`memory_recall`) and durable outcome captures (`memory_capture`). |
| Inbox | `PeerInbox` (`claim`, `listClaimed`, `mark`, optional `hasPending`) | no messages, marks accepted | Messages addressed to a role by name, submitted into its conversation with idempotent request ids. |
| Channel | `PeerChannel` (`reply`, `askOwner`, `close`) | refuses with the "not configured" notice | Answering a peer agent on an existing thread, as the role's own presence name. |

### The CLI protocol (the shipped real implementation)

Set `STANDING_ROLES_INTEGRATIONS=on` and `STANDING_ROLES_INTEGRATIONS_COMMAND=/path/to/your-cli`.
The host runs your program with argv arrays, never a shell; a value that starts with `-` is refused
before it is built. The verbs, frozen by tests:

```text
presence register --name NAME --title TITLE --status working|waiting --step STEP
memory recall --query QUERY                      # stdout: the answer text
memory capture --note NOTE --idempotency-key K   # 16 lowercase hex; retries replay the same key
inbox claim --name NAME                          # stdout JSON: {"messages":[{"id","content"}]}
inbox list --name NAME --state claimed           # stdout JSON: {"messages":[{"id","via?","origin?"}]}
inbox mark --id ID --event delivered|failed [--detail TEXT]
channel reply --thread T --from NAME --text TEXT
channel ask  --thread T --from NAME --text TEXT
channel close --thread T --from NAME --text TEXT
```

Semantics the host relies on: a non-zero exit is an error the caller records (a down integration
never fails a run); presence registration is idempotent per name (re-registering updates the
card); `memory capture` is idempotent per idempotency key; `inbox claim` returns and atomically
claims pending messages, and `inbox list --state claimed` lets the host recover ones it claimed
but never delivered. Presence effects and captures ride a durable outbox inside the host, so a
crash between queueing and delivery cannot lose or duplicate them.

### What to edit to plug in your own tools

- **Your own CLI**: nothing in the host — write a program speaking the protocol above and set the
  two environment variables.
- **In-process implementations**: edit `src/integrations/cli.ts` (or add a sibling module next to
  `src/integrations/stub.ts`) to return your own `Integrations` object, and wire it in
  `loadPlumbing()` in `src/main.ts`. The interfaces are the contract; the plumbing, tools and
  carrier do not change.
- **Tool names for roles**: the `integrations` tool group exposes `memory_recall`,
  `memory_capture`, `peer_reply`, `peer_ask_owner` and `peer_thread_close`; the `notify` group
  exposes `notify_owner`, `raise_item`, `resolve_item` and `report_run`. Role instructions and the
  shared preamble (roles/PREAMBLE.md) use exactly these generic names.
- **Notifications**: any program that accepts `<command> <title> <body>` — a Telegram bot helper,
  a desktop notifier, a webhook curl wrapper. Pi Web UI's notify helper is one example.

## The ready-to-paste agent prompt

Give this to your own coding agent to adapt the repository to your host:

```text
Work in /opt/pi-durable-permanent-roles (a Node 24 + TypeScript host that runs permanent
upkeep roles on Pi Durable). Read docs/ADOPTING.md and docs/ARCHITECTURE.md first, then:

1. Set roles/defaults.json to a model my Pi installation serves (provider + modelId).
2. Point STANDING_ROLES_STATE_DIR in systemd/pi-roles*.service at a persistent directory,
   set STANDING_ROLES_TIMEZONE to my zone, and set STANDING_ROLES_GUARDED_SERVICES to the
   services I actually run. Keep every other default.
3. For each role in roles/ (except example), edit its settings.json: enabled only where I
   say, schedules that fit my routine in my zone, cwd a real directory.
4. roles/system-updates/{UPDATES,DISK,SERVICES}.md: fill in my package sources, my caches,
   and my services, keeping the safety rails (never reboot, restarts only through
   bin/flush-restart, never delete anything).
5. roles/runtime-keeper/RUNTIMES.md: add one entry per agent CLI I run, in the shipped
   six-field shape (installed version, latest, changelog, upgrade, check after, restart).
6. roles/docs-currency/TARGETS.md: list my repositories with fix/watch statuses.
7. roles/work-messages and roles/personal-messages: I will give you my read-capable CLI
   name; replace YOUR_MAIL_CLI in MESSAGING.md/MAIL.md and never-run.json so both stay in
   step (npm test has a drift check), and keep the tables read-only.
8. If I have a memory/presence integration CLI, set STANDING_ROLES_INTEGRATIONS=on and
   STANDING_ROLES_INTEGRATIONS_COMMAND, or tell me exactly what my CLI must implement
   (the protocol table in docs/ADOPTING.md).
9. Run npm run gate until green. Do not push anywhere; do not enable schedules until I say.
```

## Validating and committing

```bash
npm run gate     # typecheck + the whole test suite; must pass before you commit
```

Tests never touch a real model, the live state directory, or an external system; they run the
host against an in-memory store and a scripted provider. Keep it that way: the suite is the
fastest proof an adopter has that the host works on their machine.
