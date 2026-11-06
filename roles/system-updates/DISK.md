# Disk keeper — reference for the system updates role

Two duties, split by risk: a list of **pure caches** you only *suggest* for delegation, and a **weekly sweep** that
measures and delegates — nothing is deleted by you; the operator's word covers what a delegated session may remove.

## 1. The rules that bound both duties

- **Never scan from `/` without `-xdev`**, and never let a scan reach a FUSE or network mount (a cloud-drive mount
  can hang the host — the preamble's "Host safety"). `du -x` / `find -xdev` stay on the root filesystem.
- **Never delete anything yourself.** The allow-list below is a suggestion list. The sweep's "needs a decision"
  group is reported and delegated, never acted on. "It looks stale" is not permission.
- Bounded and timed: every `du`/`find` in the sweep gets `--max-depth` and `timeout 300`; heavy runs in their own
  capped scope (the preamble pattern: `systemd-run --scope --quiet --collect -p MemoryMax=4G -- nice -n 10 …`).
- Record the measured sizes and what you suggested in `LOG.md` (one line) and keep the current numbers in
  `STATE.md`.

## 2. The allow-list — suggested easy cleanups

You do not run these commands yourself. You measure each target's size, put the command in the delegation item,
and delete nothing. The table is the list of pure, regenerable caches that are safe to suggest; the rules in §1
still bind whoever executes it. Every command below only touches a regenerable cache and is safe to run twice (the
second run frees ~0). For container runtimes, never volumes is the rule.

| Cache | Command (exact) |
|---|---|
| apt package cache | `apt-get clean` |
| journald logs | `journalctl --vacuum-size=300M` (record whether a `SystemMaxUse` cap is configured; without one the journal grows unbounded) |
| container build cache | `docker builder prune -f` (never `--all`) |
| container dangling images | `docker image prune -f` (never `-a`, never volumes) |
| `/tmp` old files | the loop in §4 |
| npm cache | `npm cache clean --force` |
| pip cache | `pip cache purge` |
| other tool caches | add yours here, one row per cache, with the exact command |

## 3. Measuring

```bash
du -xsh --max-depth=1 /var/cache/apt/archives /home/you/.npm /home/you/.cache 2>/dev/null
docker system df 2>/dev/null
df -h /
```

Record the date with the numbers. A cache that suddenly grows across runs is a finding, not just a bigger number.

## 4. The weekly sweep

On the first run of the week (or whenever STATE.md has no sweep date):

1. Measure §3, plus a bounded `du -x` at depth 2–3 over the big state directories (`/var`, `/root`/home, the
   container roots).
2. Suggest the §2 allow-list as **one** delegation item: one `system` task, the exact commands, the measured
   sizes, and the rules (§1) in the brief.
3. Report anything that needs a decision — a large unknown directory, a log with no rotation, a cache owned by a
   service — as its own item; never guess whose it is.
4. Write the sweep date in STATE.md; keep the last numbers there.

## 5. Free space

Every run reads `df -h /` (and any mount that matters). Report when free space drops below the threshold this
file sets — a sensible default is 20 % — and treat a drop of more than a few percent between runs as its own
finding, whatever the absolute level.
