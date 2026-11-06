# Architecture

One Node process, one SQLite file, one conversation per role. This page walks through the
components, the data flow, what sits on disk, and how durability works.

## Components

| Component | Source | What it does |
|---|---|---|
| Host process | `src/main.ts` | Opens the harness, resumes it, starts the mirror, schedules, watches, admin socket and plumbing; orderly shutdown on SIGTERM. |
| Harness | `src/harness.ts` (Pi Durable `Harness`) | One durable conversation per role: model, thinking level, instructions, tool selection, cwd, applied on every start and reload. |
| Roles loader | `src/roles.ts` | Reads `roles/`: `defaults.json`, `PREAMBLE.md`, one folder per role. A bad folder is reported and skipped, never fatal. Composes the prompt (preamble + instructions, `{role}`, `{title}`, `{roleDir}`, `{notes}`, `{counts}` filled). |
| Schedules | `src/schedules.ts` | One in-process 60 s tick; per-role durable ledger of created runs; run ids `<role>:<date>T<HH:MM>`; a missed slot is caught up late, once, the same zone-day. |
| Watches | `src/watches.ts` | Host-side triggers from a role's settings: run `command` on `everySeconds`, submit one input when trimmed stdout ≠ `expect` or the command fails. Runs only while schedules are on. |
| Reference files | `src/ref-files.ts` | Hashes each role's folder files (minus settings/instructions) plus its `referenceFiles`; one input naming what changed, once per change, across restarts. |
| Limits | `src/limits.ts`, `src/docs-commit.ts`, `src/messaging-limit.ts` | The bash guards: no reboot/shutdown, no scans from `/`, no direct restarts of guarded services, git writes refused for docs-only roles, never-run CLI tables for read-only messaging roles. |
| Plumbing | `src/plumbing.ts` | The wiring the host installs: tool groups, the durable outbox, presence cards with a heartbeat, the inbox carrier. |
| Integrations | `src/integrations/*` | The seam: capability interfaces, the stub default, the CLI adapter and its argv protocol, the durable outbox, the tool group. |
| Notification | `src/notify.ts` | The at-most-once owner notification task and the `notify_owner` tool; the needs-you tools; the `report_run` tool. |
| Carrier | `src/carrier.ts` | Polls the inbox integration per enabled role, submits claimed messages with idempotent request ids, marks them delivered/failed, and recovers crash-stranded claims at start. |
| Mirror | `src/mirror.ts` | Appends every conversation event to `<stateDir>/roles/<name>/transcript.jsonl` and rewrites `status.json` (busy, last run, next run, model). |
| Admin socket | `src/admin.ts` | `<stateDir>/admin.sock`, mode 0600: `GET /status`, `POST /run`, `POST /chat`, `POST /reload`. `bin/roles` speaks it. |
| Digest | `src/digest.ts`, `src/digest-cli.ts`, `src/digest-card.ts` | Joins `runs.jsonl` by role + slot, medians over the previous 7 days, snapshots and diffs notes, reads pending rule proposals, renders one notification plus `<date>.{json,md}`, raises at most one needs-you card. |
| Backup | `src/backup.ts` | SQLite online backup of `roles.db` into `<stateDir>/backups/`, keeping 14; never stops the host. |
| Reports | `src/report-notify.ts` | Pi Durable reports that mean "a role's work has stopped" go to the owner on the notify path; every report keeps its journal line. |
| Shutdown | `src/shutdown.ts` | Bounded, orderly stop: timers, plumbing, admin socket, harness, exit — with a forced exit if anything stalls. |

## Data flow

1. **A scheduled slot fires** (or a watch fires, a message arrives, the operator chats): the host
   submits an input into the role's conversation with a stable `requestId`. Pi Durable delivers the
   same id at most once, across crashes — every path (schedule `run:<slot>`, inbox `inbox:<id>`,
   reference change keyed by hashes) builds on that.
2. **The role works**: its bash goes through the limit guards; its tools are the groups its
   settings selected (`coding`, `integrations`, `notify`) plus any hard limit's extension.
3. **Integration effects queue**: presence cards and memory captures are written durably to the
   outbox, then delivered with backoff; a down integration waits, never fails a run. In stub mode
   nothing queues: captures land in the JSONL file, presence is a no-op.
4. **The run ends with `report_run`**: one JSON line appended to `runs.jsonl`; the host appends a
   `run-end` line when the conversation goes idle. An unreported run gets one nudge input, then a
   problem card.
5. **The morning digest joins it all**: runs, unreported runs, counts against the 7-day median,
   did-lines, notes changes (snapshot diffs), pending rule proposals, every-run misses. One
   notification text, one JSON, one markdown; at most one needs-you card, and only when there is
   something to decide.

## State on disk

Everything lives under `STANDING_ROLES_STATE_DIR` (default `/var/lib/pi-roles`):

```text
roles.db                  the Pi Durable SQLite storage (conversations, tasks, documents)
admin.sock                the admin socket, mode 0600
runs.jsonl                append-only report and run-end lines
needs-you.jsonl           append-only needs-you items and resolutions
notifications.jsonl       the default notification sink (when no command is configured)
digest/<date>.json|.md    the daily digest
digest/snapshots/<role>/<date>/   the notes snapshots the digest diffs (14 days kept)
digest/check/             (removed in this copy; the digest no longer runs an outside check)
roles/<name>/notes/       the role's durable notes folder ({notes} in its prompt)
roles/<name>/transcript.jsonl     the mirror's readable transcript
roles/<name>/status.json  the mirror's status line
integrations/memory-captures.jsonl  the stub memory capture sink
backups/roles-*.db        the nightly SQLite online backups (14 kept)
flush-restart.log         one line per flush-restart decision
```

## Durability and restarts

- **Conversations live in SQLite.** A restart resumes every role's conversation where it stopped;
  the compaction policy (background compaction at half the model's window by default) summarises
  with the role's own model and points the summary back at its notes folder.
- **Every submit is idempotent by requestId.** A crash between submitting and recording cannot
  duplicate a run, a message delivery or a reference-change input.
- **The schedule ledger is durable**: `createdRuns` per conversation, pruned weekly. A slot missed
  while the host was down is submitted late, once; older slots are skipped.
- **The outbox is durable**: presence cards and captures survive a restart; entries left mid-flight
  are re-armed once at start (both delivery shapes are safe to repeat).
- **Notification is at-most-once by design**: the durable `sent` mark lands before the send, so a
  crash can lose one ping and never duplicate one.
- **Backups before upgrades**: `roles-*.db` copies exist before any storage migration; restoring one
  is the only rollback if a migration goes wrong.
- **The host never restarts itself**: `bin/flush-restart` refuses the host's own unit; restarts are
  supervised (systemd restarts on failure) and left to an agent that is not a role.
