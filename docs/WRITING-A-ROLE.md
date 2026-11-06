# Writing a role

A role is a folder in `roles/` with three things: a `settings.json`, an `instructions.md`, and any
reference files it needs. The host does the rest: the durable conversation, the schedule, the
watches, the limits, the reporting. `roles/example` is the shipped worked example (disabled); this
page walks through building one, with the example's fields explained.

## Folder layout

```text
roles/my-role/
  settings.json       required — the trigger and wiring
  instructions.md     required — the role's own prompt
  anything-else.md    optional — reference files the role reads by path
  never-run.json      optional — with the read-only-messaging limit
```

The host composes the prompt as `roles/PREAMBLE.md` + your `instructions.md`, with the placeholders
filled. Everything in the folder except `settings.json` and `instructions.md` is a *reference file*:
the role is told to open it by path (never search the disk), and the host submits one input whenever
a reference file changes — including the ones you later add.

## settings.json, field by field

```json
{
  "enabled": false,
  "title": "Example role",
  "boardName": "role-example",
  "schedule": [ { "at": "09:00", "days": "weekdays" } ],
  "runPrompt": "Work your example round: follow your instructions, update your notes, and notify the owner only if there is something for them.",
  "cwd": "/root",
  "tools": ["coding"],
  "model": { "provider": "anthropic", "modelId": "claude-sonnet-4-5" },
  "thinking": "high",
  "limits": ["read-only-messaging"],
  "readOnlyRules": "never-run.json",
  "reportCounts": ["things_checked", "items_raised"],
  "everyRunCounts": ["things_checked"],
  "watches": [ { "name": "tmp-mode", "command": "stat -c %a /tmp", "expect": "1777", "everySeconds": 60 } ],
  "referenceFiles": ["/srv/demo/RUNBOOK.md"]
}
```

| Field | Meaning |
|---|---|
| `enabled` | The one-line switch. `false` = no schedule, no presence card, no inbox claims. |
| `title` | The human name; also the presence card's task line and the digest's line label. |
| `boardName` | The role's presence name and inbox address. Unique across roles. |
| `schedule` | Slots `{ "at": "HH:MM", "days": "daily" \| "weekdays" }` in `STANDING_ROLES_TIMEZONE`. A slot missed while the host was down is caught up late, once, the same day. |
| `runPrompt` | Optional text submitted at each scheduled run after "Scheduled run `<slot>`.". |
| `model`, `thinking` | Optional overrides of `roles/defaults.json` (`low` \| `medium` \| `high` \| `max`). |
| `cwd` | The working directory the role's coding tools run in. |
| `tools` | Any of `coding`, `integrations` (memory + peer channels), `notify` (notify_owner, raise_item, resolve_item, report_run). |
| `limits` | Hard limits in code, applied only to the roles that name them: `docs-only-commits` (commit docs only through `docs_commit` — which also runs `git push` on the repository's current branch — with git writes refused in bash) or `read-only-messaging` (the never-run table's write commands refused in bash). |
| `readOnlyRules` | With `read-only-messaging`: the rules file relative to the role folder. Required with the limit — loading fails without it. |
| `reportCounts` | Up to 12 snake_case count names the role reports with `report_run`; filled into the prompt's `{counts}`. |
| `everyRunCounts` | Names from `reportCounts` that must be above zero on every scheduled run; the host nudges and then cards a run that reports them 0 or missing. |
| `watches` | Host-side triggers: `{ "name", "command", "expect", "everySeconds" }`. The command runs on its interval (while schedules are on); trimmed stdout ≠ `expect`, or a non-zero exit, submits one input naming the watch. Minimum interval 30 s. |
| `referenceFiles` | Absolute paths outside the role folder the role works from; one input when one changes. |

Unknown keys are kept and ignored, so you can add notes of your own.

## instructions.md — where the judgement lives

Write the role's job in plain British English, as a prompt for a competent agent:

- **Your job** — one paragraph: what "good" looks like, what the role owns.
- **A run** — the numbered steps of one round, starting with "re-read `STATE.md`".
- **Judgement and honesty** — what is a finding to report vs a thing to fix; what is never done.
- **What you write down** — `STATE.md` (what is true now), `LOG.md` (one dated line per run),
  captures (per the preamble's two kinds).
- **What the operator hears** — one message per run with items; a quiet run sends nothing.

Placeholders available: `{role}` (folder name), `{title}`, `{roleDir}` (the folder's absolute path),
`{notes}` (the durable notes folder under the state directory), `{counts}` (the reportCounts list).

Keep the prompt about judgement, not about rules the host already enforces — the preamble covers
the shared limits (nothing outward, no reboots, no scans from `/`, no secrets), and the code guards
enforce them anyway.

## The notes discipline

The preamble requires every role to keep `{notes}/STATE.md` (what is true now, open items, what it
is waiting on), `{notes}/LOG.md` (one dated line per run) and `{notes}/RULE-PROPOSALS.md` (new
decision rules as one-line proposals, never applied by the role). The digest snapshots the notes
daily and diffs them, so you can see what a role learnt. You never have to read a conversation to
audit a role.

## The report

Every run ends with `report_run`: the named counts, up to five did-lines, what it could not cover,
and how many proposals it wrote. The digest and the unreported-run nudge are built on it. Name your
`reportCounts` after what you will actually want to see trending.

## Testing your role

- `npm run gate` always passes with your folder in place (a malformed folder is reported, not
  fatal, but the folder tests will show it).
- Copy `test/roles-folder.test.ts`'s pattern to pin your role's settings the way the shipped roles
  are pinned.
- Run the host with `STANDING_ROLES_SCHEDULES=off` first: roles load, nothing runs. Then enable and
  watch one run through `bin/roles status` and the role's `transcript.jsonl`.

## Switching a role off

`"enabled": false` (the conversation survives, nothing runs) — or delete the folder (the host
reports nothing; the conversation's records stay in `roles.db` until you remove the state
directory).
