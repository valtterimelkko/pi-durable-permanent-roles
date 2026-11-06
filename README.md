# pi-durable-permanent-roles

Permanent role agents on Pi Durable: a small Node host that runs a handful of long-lived
upkeep roles — runtime keeper, system updates, docs currency, read-only message watchers — each
in its own durable conversation, with hard safety limits in code, a morning digest, and small
seams where you plug in your own memory, presence and messaging systems.

## Project story

When Pi Durable reached its 1.0 release, I got quite excited. I had been a long-term user of the Pi coding agent, and Pi Durable was the piece I had been missing: an always-on agent, much like the bots people run (Grok Bot, Hermes Agent and the like), but one whose behaviour I fully control.

Permanent roles were not a new idea for me. Little by little I had been working out how permanent roles could live on the VPS I use for all my AI agent workflows. I wanted agents that keep the system tidy within a set of boundary rules, and I wanted more control than any of the bot ecosystems offered. Pi Durable turned out to be the perfect tool for that.

Now I have a system that keeps the server quite clean. The roles keep the disk tidy, keep packages and software up to date, check that no repository is left with uncommitted changes, and keep repository documentation current. When they notice something harder, they can raise a card for me, which I can hand to another agent (that part is optional).

They also keep my phone clean. My Android phone is an old one, so the agent does not run on the phone: it runs on the server and just has a door to the phone.

Thank you to the Pi Durable team for all the hard work.

*(The integration seams and configuration names in this public copy were generalised so the same
host can run on any VPS; docs/ADOPTING.md is the adoption guide. The phone half of the story is
[pi-durable-phone-steward](https://github.com/valtterimelkko/pi-durable-phone-steward).)*

## What it does

- One Node process, one SQLite file: a Pi Durable harness with one durable conversation per role.
  Restarts resume every conversation; nothing a role did is lost.
- Schedules in the host's configured time zone: each role wakes at its slots, and a missed slot is
  caught up late, once, the same day.
- Watches and reference files: the host runs a role's small check commands on an interval, and
  submits one input whenever a watched command's output drifts or a reference file changes.
- Hard limits in code: no reboots, no scans from `/`, no direct service restarts (a flush-restart
  tool restarts services only when they are idle), docs-only commits through one tool, and a
  read-only messaging limit built from each role's own never-run table.
- Reports and a digest: every run ends with `report_run`; the host joins the reports into a daily
  digest (one notification, one JSON file, one markdown file) and raises a needs-you card when
  something needs a decision.
- Integration seams (off by default): presence cards, memory recall and capture, an inbox carrier
  for messages addressed to a role, and peer-channel answers — each an interface with a stub that
  works with no external system, and a documented CLI protocol to connect your own tools.

## Use cases

- **Disk upkeep** — measure, suggest, and delegate cleanups; never delete anything itself.
- **Package and software updates** — apply what is safe, hold what needs a reboot, restart services
  only when they are provably idle.
- **Uncommitted-work checks** — flag every repository left dirty, never act on it.
- **Docs currency** — surgical documentation fixes committed through the docs-only tool.
- **Runtime upkeep for agent CLIs** — keep the coding-agent CLIs and SDKs current, in dependency
  order, with a changelog every time.
- **Read-only message watching** — work chat/mail and personal mail, watched and summarised, never
  written to; the write commands are refused in code from the role's own table.
- **Raising cards for harder work** — a role that finds something bigger than its mandate raises a
  delegation item instead of improvising.

## How it fits with Pi Durable

Pi Durable (the `@earendil-works/pi-durable` package) is the durable agent runtime: conversations,
tasks and documents that survive a restart in one SQLite file. This repository is the host around
it: the roles, their schedules and watches, the limits, the digest, and the seams to the rest of
your systems. You bring the model credentials the way Pi itself reads them (`~/.pi/agent`).

## Quick start

```bash
npm ci
npm test                                              # the whole suite, no external systems touched
STANDING_ROLES_STATE_DIR=$PWD/.state node src/main.ts # schedules off; roles load, nothing runs yet
```

`.state/` is gitignored; without the variable the state directory defaults to `/var/lib/pi-roles`,
which needs root. The shipped units assume `HOME=/root` — edit their environment lines to match
your user. Then read **docs/ADOPTING.md**: set the model in `roles/defaults.json`, fill in the role
templates, and turn roles on one at a time (every role ships disabled, and the example unit ships
schedules off).

## Documentation

- **docs/ADOPTING.md** — requirements, every configuration value, the integration seams, and a
  ready-to-paste prompt for your own coding agent.
- **docs/ARCHITECTURE.md** — components, data flow, state on disk, durability and restarts.
- **docs/SAFETY.md** — the honest safety model: what the limits stop, and what they do not.
- **docs/ROLES.md** — each shipped role: purpose, checks, schedules, how to switch it off.
- **docs/WRITING-A-ROLE.md** — how to add a role, with `roles/example` as the worked example.

## Status

Personal project, shared as is. It runs one small VPS happily; expect to fill in the role folders
for your own host.

## Licence

MIT — see [LICENSE](LICENSE).
