# AGENTS.md — pi-durable-permanent-roles

## Purpose

Permanent role agents on Pi Durable: one Node process runs a handful of long-lived upkeep roles
(runtime keeper, system updates, docs currency, read-only message watchers), each in its own durable
conversation, with hard safety limits in code, a morning digest, and integration seams for your own
memory, presence and messaging systems.

## Binding rules

1. **Tests never touch a real model, the live state directory, or an external system.** The suite
   runs the host against an in-memory store and a scripted provider; keep it that way.
2. **The code guards are the contract.** The limits in `src/limits.ts`, `src/docs-commit.ts` and
   `src/messaging-limit.ts`, and the argv safety rules in `src/args.ts`, change only deliberately,
   with their tests updated in the same change.
3. **The private source stays private.** Never commit credentials, tokens, real mailbox content,
   real host names, IP addresses or personal data. Placeholders (`YOUR_MAIL_CLI`, `example.com`,
   `YOUR_API_KEY`) and synthetic examples only.
4. **`AGENTS.md` and `CLAUDE.md` stay byte-identical**; edit one, copy to the other, and keep this
   file a router — procedures live in `docs/`.
5. **Plain British English** in every prompt, doc and comment; write for a stranger adopting the
   repository, not for the author.

## Start here

- Adopting the host, every configuration value, the integration seam protocol → `docs/ADOPTING.md`
- Components, data flow, state on disk, durability → `docs/ARCHITECTURE.md`
- The safety model: what the limits stop and what they do not → `docs/SAFETY.md`
- What each shipped role does and how to switch it off → `docs/ROLES.md`
- Adding or editing a role → `docs/WRITING-A-ROLE.md` (worked example: `roles/example`)
- Where a change belongs: host core `src/*.ts`, the seam `src/integrations/`, limits
  `src/limits.ts` + `src/docs-commit.ts` + `src/messaging-limit.ts`, roles `roles/`,
  units `systemd/`.

## Validate & commit

- `npm run gate` (typecheck + the full suite) must pass before any commit; behaviour changes get a
  failing test first (RED), then the fix (GREEN).
- Regenerate the tool-schema fixture deliberately: `UPDATE_TOOL_SCHEMAS=1 npx vitest run
  test/tool-schemas.test.ts`, then diff by hand.
- Stage explicit paths; never a wholesale `git add -A` of an unknown tree. Commit messages say what
  and why. No remote is configured; do not add one.
- If a repo guide (`AGENTS.md`/`CLAUDE.md`) is among the changed paths, run `guide-check repo .`
  before committing, when a checker is installed.

## Current state

The host and the five shipped roles are generalised for any server; the tests are green. Adoption
starts at `docs/ADOPTING.md`.
