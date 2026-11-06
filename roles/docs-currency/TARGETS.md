# Docs-currency targets

The repositories this role keeps documented. Fill it in for your host. Every entry names its status, so the role
never has to guess which repositories are fair game:

- `fix` — in use and fair to commit docs fixes into (the role's whole duty applies).
- `watch` — read for drift and flag only (critical, or owned by another workflow).
- anything not listed — not the role's to touch, at all.

| Repository (absolute path) | Status | Notes (what its docs live in, quirks) |
|---|---|---|
| /srv/example-app | fix | README + docs/; guides are byte-locked AGENTS/CLAUDE |
| /srv/example-lib | watch | published package; docs fixes go through its own review |

Add and remove rows as repositories come and go. When a repository's own guide defines which sections an agent may
edit, note that in the Notes column — the role reads it before committing there.
