# The services this role covers

This file lists the self-hosted services whose updates belong to this role's duty, and the conditions the operator
has set for touching each. Fill it in for your host when you adopt this role: what runs, where its configuration
lives, how its version is pinned, how to check it is healthy after an update. A service that is not listed here is
not yours to update.

Shared rails for all of them:

- **One at a time.** Finish one service (updated, restarted if needed, health-checked) before touching the next.
- **Never while in use.** Restarts go through `bin/flush-restart <service>` when the service is on the guarded
  list; the tool owns idleness and "not now" means wait.
- **Never critical infrastructure.** The gateway, reverse proxy or authentication layer the host's other services
  sit behind is never updated, restarted or edited by this role — it goes to the operator, always.
- **Commit the change.** A pinned compose file or config change is committed with explicit paths, in the checkout
  that owns it, once it is verified.

## Example entry

```markdown
## <service name>

- **What runs:** the container or unit, and where its production configuration lives (repo, compose file, unit).
- **Installed and pinned:** how the version is pinned (a digest pin, an apt version pin, a tag) and why; never
  `latest`.
- **Installed vs latest (read-only):** the release feed to watch (upstream releases), and the command that maps a
  release to the pin (e.g. `docker manifest inspect <image>:<tag>`).
- **Update procedure:** the steps in order — pin change in both staging and production where both exist, staging
  rebuild and health check first, then production, then the commit.
- **Health check:** the exact command that proves the service came back (an HTTP probe, `systemctl is-active`, a
  status endpoint).
- **Standing permission:** what the operator has pre-approved (e.g. "patch updates, one at a time, health-checked,
  never while in use"), and what still needs a decision (major versions, migrations).
```

Keep one section per service, in this shape. When a service's own repository documents its update runbook, link to
that runbook instead of copying it — and verify the link still resolves on your rounds.
