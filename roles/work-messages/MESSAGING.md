# MESSAGING.md — the work-messages role's reference

This file is the **source of truth** for what this role may and may not run. The code guard
(`src/messaging-limit.ts`) reads its table from `{roleDir}/never-run.json`; this document says what the table
means and why. Keep the two in step: every "never" below must be a row in the JSON, and every JSON row must have
its reason here.

## 0. The CLI

`YOUR_MAIL_CLI` is the placeholder for the read-capable command-line tool this host supplies for the mailbox or
chat the role watches. Fill in:

- the **read** commands the role may run (list, search, fetch, show — whatever your CLI calls them);
- the **never-run** commands and flags below, one row each in `never-run.json`.

If your tool has no write commands at all, the never-run table still lists the verbs it *would* use — a table that
refuses nothing is a table that proves nothing when the tool gains a write one day.

## 1. Never run — sends and drafts

Every command that sends, posts, replies, forwards or files a draft is refused, in any invocation form:

| Command | Why it is never run |
|---|---|
| `YOUR_MAIL_CLI send …` | sends from the watched account |
| `YOUR_MAIL_CLI reply …` | sends from the watched account |
| `YOUR_MAIL_CLI forward …` | sends from the watched account |
| `YOUR_MAIL_CLI draft …` | files a draft into the watched mailbox |
| `YOUR_MAIL_CLI login …` | opens an interactive authentication flow; authentication is the operator's |
| `YOUR_MAIL_CLI move …` | changes the watched account's folders |
| `YOUR_MAIL_CLI archive …` | changes the watched account's folders |
| `YOUR_MAIL_CLI label …` | changes the watched account's labels |
| `YOUR_MAIL_CLI mark-read …` | changes the watched account's read state |
| `YOUR_MAIL_CLI delete …` | destroys mail in the watched account |
| `YOUR_MAIL_CLI download-attachment …` | writes a file from the watched account to disk |

Reads only; the role's value is judgement, not filing.

## 2. Never run — write-side flags

A flag that changes a read into a write is refused wherever it appears in the invocation; the shipped table
refuses `--send`, `--submit`, `--mark-read` and `--draft`. Keep the list in `never-run.json`'s `flags` arrays and
this paragraph in step.

## 3. What stays allowed

The read commands: listing, searching, fetching one message for reading. They stay allowed because the role's
whole duty is reading. If your CLI marks a message read as a side effect of fetching it, prefer its peek-style
read, or record here that the role reads with that side effect knowingly.

## 4. The guard in code

`src/messaging-limit.ts` loads `never-run.json` at host start and wraps the role's bash: every refused form
returns an error result to the role before the command runs. The matcher judges hidden forms too (`bash -c`,
`$(…)`, backticks, `echo … | sh`), so a mention inside a quoted string is text, but a real invocation is caught
however it is spelled. The role never tests the guard's edges; a write-shaped form the table misses is a finding
and a proposal, not an experiment.
