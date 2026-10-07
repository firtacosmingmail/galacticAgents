# Phase 8 wave 1 review (P8-01, P8-02, P8-04)

Review of `phase-8...p8-wave1-drills-retention-budgets`, 2026-10-05, with the upgrade of a real
database first. No blockers. Fixes landed on `p8-wave1-review-fixes` and were merged into the
batch branch; gates green afterwards (protocol 92, server 1105 + 1 skipped, web 1654), `pnpm drills`
green (36 tests, 25 random kills), suites re-run once without flakes.

Integration before the review: P8-01 and P8-02 both added migration 0011 and the same settings
plumbing; merged as a union on `p8-01-integrate`, budgets renumbered to `0012_budgets.sql`, and the
migrations copy step now clears stale files from `dist`.

## Should-fix (all fixed)

1. **Startup VACUUM conversion** left a WAL as large as the database and could refill a full disk
   at every start. Now: only with ≥ 2.2× free space, WAL truncated after every attempt,
   `journal_size_limit` 64 MiB, gives up after 3 failures (`GALACTIC_VACUUM_RETRY=1` retries).
2. **Held agent events could be overtaken** by commands written directly, and `agent.spawned` was
   never held (a full disk at spawn time made the agent restart fresh instead of resuming). An
   `EventLog` before-command hook writes the held queue first; held events keep their own time;
   `agent.spawned` is held.
3. **SPEC 99 promised refusal, code queued user actions**, with no bound on the queue. User
   actions through the runtime are now refused while events are held; the queue is capped (10k
   events / 64 MiB, agent output dropped first); `storageState()` feeds P8-09. SPEC 99 and 102
   reworded.
4. **Raising a budget did not restart a refused Waykeeper.** A raised or removed budget on work
   with no running agent wakes the Harmonizer to spawn it.
5. **The Harmonizer could loosen a budget on its own.** Raising or removing through `control_work`
   needs the user's confirmation of that amount; setting or lowering stays free.

## Nits (fixed)

Budget fields out of the update command types; migrations refuse a database whose recorded names
differ from the files; never-started agents with a logged stop end as stopped; retention days are
whole numbers from 1; refused spawns logged once an hour per work; adapter contract says cost is
cumulative per session; decision numbers and SPEC §4.6/§5 brought up to date.

## Checked and OK

Migrations 0010–0012 order and idempotency; the one-time budget fold (transactional, no double
count); server and client spend agree; every spawn path checks the budget, no threshold race;
remote clients cannot raise budgets or change the new settings; retention never touches events or
pinned work and no brain is rebuilt from transcripts; transcript seq never reused; worktree re-add
only for git's `locked initializing`; no duplicate spawns on recovery.

## Left open

- P8-09 (storage health in the panel, 507 for refused actions), P8-10 (brains and the wall-clock
  cap — needs Cosmin's decision), P8-11 (a CLI forked just before a kill).
- SPEC §8: `synchronous=FULL` for power-loss durability.
- Budgets: pause at the budget as an option; budget push/desktop notifications.
