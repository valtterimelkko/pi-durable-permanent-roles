# Personal mail — reference for the personal messages role

This file is the role's ground truth for **your** mailboxes, and the role maintains it. Fill it in once when you
adopt this role: the read commands, the watermark scheme, the always-flag list, the failure signs. Where it
disagrees with the host, report the mismatch.

Run every read command exactly as written here — full path, no shell quirks — and record with each one what it
returned when it was verified.

## 1. The read commands

| Mailbox | New mail since a date | One message in full | Notes |
|---|---|---|---|
| mailbox one | `YOUR_MAIL_CLI search --since YYYY-MM-DD --limit 50` | `YOUR_MAIL_CLI fetch --id <id>` | fills in from your own tool |
| mailbox two | … | … | |

Rules this role lives by, whatever the tool:

- **Reads never change the mailbox.** Prefer a peek-style read (one that does not mark the message read); if your
  tool cannot avoid the side effect, say so here — knowingly, in writing.
- **Watermarks.** If ids can shift (sequence numbers), keep the watermark as the date plus the message ids already
  seen on that date, and skip those on the next run. If ids are stable per folder, the newest id per folder is the
  watermark.
- **Limits.** Keep search results bounded (`--limit 50` or less); when a run returns exactly the limit, search
  again with a later `--since` or a higher limit before concluding you saw everything.
- **Folders.** List the folders this role reads, and the ones it must not (spam and bulk folders: do not read them).

## 2. Never run

These are mirrored in `never-run.json` and refused by the code guard; they are written here so the refusal is
never a surprise:

- every send, reply, forward and draft command of the mail tooling;
- anything that marks read or unread, flags, moves, archives or deletes;
- anything that touches the tool's own configuration or credential files — authentication is the operator's.

## 3. Has the operator engaged before?

Only for messages outside the always-flag list. Any one of these counts as engagement:

- the operator replied in the thread (check the Sent folder for the same participants or subject);
- the operator wrote to that sender (a Sent-folder search by sender);
- the thread carries an answered/replied marker in its flags or metadata.

Record one line per engagement check in LOG.md ("thread X: replied 12 Oct"). When you cannot check (the Sent
folder is unreadable), treat it as not engaged and note it once in STATE.md.

## 4. The always-flag list

One line per source, with what counts. This is the list the instructions call "always flag" — fill it in for your
own life:

```markdown
- <school / club / surgery / service> — events, letters, schedule changes, requests, dates
- invoices and bills — amount and due date in the why
```

The operator's corrections about this list (a source that stopped mattering, a new one) go into STATE.md first,
then here — this file is the source the next run reads.

## 5. When a mailbox fails

A failed read (authentication refused, folder missing, timeout) is one immediate `notify_owner` naming the mailbox
and the error's kind — then that mailbox is skipped for the run and noted in STATE.md. Never retry
authentication, never edit a credential file, never run a write-shaped command to "test" the account.
