# Host updates — reference for the system updates role

This file is the role's ground truth for **your** host, and the role maintains it. Fill it in once when you adopt
this role: what you own, the package sources, the invocations that work here, the reboot signals, the known
problems. Re-verify anything you are about to act on; where the host moves and this file says otherwise, the
mismatch is a finding to report — not something to paper over.

## 1. What you own, and what the runtime keeper owns

Yours: the operating system and its software — the system package manager (apt on a Debian-family host), and any
language or app package managers the runtime keeper does not claim.

Not yours (the runtime keeper): the coding-agent CLIs, the SDKs embedded in servers, the servers and launchers
built on them, and their model catalogues. When a system upgrade touches that world, report it; do not decide for
the keeper. CLIs that sit on the boundary — an agent CLI that arrived through the system package manager, say —
are listed here explicitly, with who owns each.

## 2. The package sources

List the configured sources and what each brings, so a surprise package can be traced to its source:

| Source file | Brings |
|---|---|
| (fill in from `/etc/apt/sources.list.d/` or your distribution's equivalent) | |

Note any local apt configuration that changes behaviour (pins, PDiffs, language settings) — each one is the kind
of detail a future run cannot rediscover quickly.

## 3. Seeing the state

```bash
apt list --upgradable                      # what the cached indexes say (works without a refresh)
apt-cache policy <pkg>                     # installed vs candidate, and the pocket / phasing
apt-get -s upgrade                         # exactly what an upgrade would do; changes nothing
```

Distribution-specific behaviours worth recording once: phased rollouts (a package "held back" with no hold set is
usually phasing, not a problem), packages that need a newer dependency (the simulation says "not upgraded" — name
the blocker), and any suite you deliberately do not pull from.

## 4. Applying updates

```bash
DEBIAN_FRONTEND=noninteractive apt-get -y -o Dpkg::Options::="--force-confdef" \
  -o Dpkg::Options::="--force-confold" upgrade
```

- Non-interactive, keeping existing config files: a hand-edited config silently replaced is a finding the next run
  cannot see.
- `needrestart` (or your distribution's equivalent) in list-only mode: the role decides restarts, never the
  package manager's automatic restart, which would cut live sessions mid-turn.
- A half-applied upgrade is a problem to report with the exact dpkg/apt error — never a blind retry.

## 5. The restart duty

After updates and every run:

1. Read the restart-needed list (`NEEDRESTART_MODE=l needrestart -b`, or `/var/run/reboot-required` and its pkgs).
2. **Guarded services** (the units in `STANDING_ROLES_GUARDED_SERVICES`): only through `bin/flush-restart
   <service>` — it owns idleness, and "not now" means wait, not "find another way".
3. **Plain system daemons** one at a time, checking each comes back (`systemctl is-active <unit>`); a daemon that
   failed to come back is an immediate report.
4. **Reboot-required packages** (kernel, libc, the init system): never — hold, and remind the operator every few
   days until the reboot happens (STATE.md carries the since-when).

## 6. Known problems

Keep here the recurring oddities of this host: a package that always simulates strangely, a service that needs a
manual step after upgrade, a source that flakes. Each with the command that shows it and the workaround that was
agreed — or "unresolved", which is what makes it a standing finding.
