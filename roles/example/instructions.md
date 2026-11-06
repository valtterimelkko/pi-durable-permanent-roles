# Example role

This folder shows the format of a role. It ships **disabled** (`"enabled": false`): the host
loads it, reports it as disabled, and never schedules, registers or wakes it. Copy the folder
to start a real role; delete it once real roles exist.

## The format

- `settings.json` — the trigger and wiring:
  - `enabled` — one-line switch. `false` means: no schedule, no presence card, no inbox
    claims; the conversation (if one existed) stays.
  - `title` — the human name, also the presence card's task line.
  - `boardName` — the presence name the role is addressed by on the shared board and in the
    inbox, unique across roles.
  - `schedule` — slots `{ "at": "HH:MM", "days": "daily" | "weekdays" }` in the host's time
    zone (`STANDING_ROLES_TIMEZONE`, default UTC).
  - `runPrompt` — optional text submitted at each scheduled run after "Scheduled run <slot>.".
  - `model` (optional) — `{ "provider", "modelId" }`; omit to use `roles/defaults.json`.
  - `thinking` (optional) — low | medium | high | max; otherwise the default's.
  - `cwd` — the working directory the role's coding tools run in.
  - `tools` — the tool groups for this role's conversation: any of `coding`, `integrations`
    (memory recall/capture and peer channels), `notify` (notify_owner, raise_item, resolve_item,
    report_run).
  - `limits` (optional) — hard limits carried in code: `docs-only-commits` (commit docs only
    through `docs_commit`), `read-only-messaging` (refuse the never-run commands of the CLIs in
    the role's rules file).
  - `readOnlyRules` (optional) — with the read-only-messaging limit: a JSON rules file in this
    folder (see roles/work-messages/never-run.json).
  - `watches` (optional) — host-side triggers: `{ "name", "command", "expect", "everySeconds" }`;
    the host runs the command on its interval (while schedules are on) and submits one input
    whenever the trimmed stdout is not `expect` or the command fails.
  - `reportCounts` / `everyRunCounts` — the named counts the role reports with `report_run`;
    `everyRunCounts` must be above zero on every scheduled run.
  - `referenceFiles` (optional) — absolute paths outside this folder the role works from; the
    host submits one input whenever one changes.
- `instructions.md` — the role's own prompt, written after the shared `roles/PREAMBLE.md`.
  This is where the role's judgement lives: what to look at, what matters, what to bring the
  operator. Available placeholders: `{role}` (folder name), `{title}`, `{roleDir}`, `{notes}`
  (the role's own durable folder under the state directory) and `{counts}`.
- Any other file in the folder is a reference file: the role reads it by path, and the host
  submits one input whenever it changes.

Write in plain, concise British English. Keep the prompt about judgement, not about rules the
host already enforces (the preamble covers the shared limits).
