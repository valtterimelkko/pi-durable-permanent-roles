# UPDATING.md — proving a runtime update before it reaches production

`RUNTIMES.md` says, per runtime, how to read the installed version, learn the latest, upgrade and what to verify.
This file is the **proof** that has to come between "the upgrade succeeded" and "I may restart production",
whatever the runtime was. Nothing here replaces `RUNTIMES.md`; if the two disagree about a command on this host,
that is a finding to report (`RUNTIMES.md` wins on facts, this file on order).

## 1. Read the changelog every time — no exceptions

Every update, however small, begins with its changelog. A version number tells you nothing about whether the
things built on the runtime still work; the changelog does. Each runtime's entry in `RUNTIMES.md` says where its
changelog lives (inside the installed package, in the upstream repository, or printed by the CLI itself — they are
all different, and a runtime with none at all is worth saying so, not inventing a summary).

Read for the four things the other software on the host depends on, in this order of danger:

1. the **API surface** of any server or service on the host (a changed or removed endpoint, field or contract
   version);
2. the **SDK surface** (what embedded copies import, not what the standalone CLI exposes);
3. **model ids and catalogue shape** (a renamed provider or model id silently empties a picker somewhere else);
4. **CLI flags** that launchers, wrappers and scheduled jobs pass.

A changelog that touches none of these is usually a safe upgrade; one that touches any of them sets the size of
the proof below.

## 2. The proof before a production restart

An upgrade that only changed a version number can still break a startup. Before an upgrade reaches anything
production depends on:

1. **Flags still accepted.** Run each caller's command line in a throwaway form and confirm the new version takes
   the flags the callers actually pass — launchers drift from the CLI's reality.
2. **The gate on a disposable copy.** Typecheck and tests of the checkout that embeds the upgraded runtime, run in
   that checkout or a scratch copy — never against production state.
3. **One real session on a disposable instance.** Where the project ships a live-validation path (a disposable
   server, a validation script), use it. A green build that cannot hold one real conversation is not done.
4. **Say what you verified.** The report names the commands run and their results; "should be fine" is not a
   verification, and a check you could not run is a finding, not a footnote.

Green, then production — and only then the restart, through `bin/flush-restart`.

## 3. Contract mirrors and derived copies

When a runtime publishes a contract other things mirror (an API version constant, generated types, a vendored
copy), a version bump is not done until the mirrors match. A stale mirror quietly breaks the consumers, so the
mirror update is part of the same run, never a follow-up. Keep the list of what mirrors what in `RUNTIMES.md`.

## 4. Half-applied upgrades

If an upgrade fails halfway: leave the old version in place, stop that runtime's upgrade, and report exactly where
it stopped and what state the host is in. Do not retry blind; do not "finish it by hand" beyond the documented
rollback. A half-applied upgrade you cannot describe is worse than one you can.

## 5. Suggesting, not building

New capabilities are suggestions, with one line of why they matter, raised as an item — never built into someone
else's project by this role. A suggestion the operator accepts becomes somebody's tracked work; that is the
system working.
