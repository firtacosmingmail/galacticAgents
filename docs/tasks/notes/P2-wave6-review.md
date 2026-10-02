# Phase 2, batch 6 (wave 6: P2-16, P2-18) — review

Branch `p2-wave6-resume-console` against `phase-2`, 2026-10-02. Two parallel agents in worktrees, both merged cleanly. P2-18 found a runner race (a brain's first-turn tool call before its agent id was known), handed to P2-16 and fixed there; the coordinator then removed P2-18's retry workaround from the exit-run test, which passes without it. An independent review (server suite three times, web three times, a full build) confirmed: every new route is behind the bearer guard and zod-validated, proposals are decided only as the user, no route bypasses the P2-21 floor, no HTML injection (agent text is rendered as escaped React text), no test-harness code in the web bundle, a resumed Steward keeps its session history, replay-vs-snapshot unaffected. A fix agent closed its findings on the branch:

| # | Finding | Fix |
|---|---|---|
| 1 | A resume that fails after the handle came back (the real SDK reports a lost session only when the CLI exits) left zero Harmonizers, ended Waykeepers for good, and lost their requeued messages | a resumed session that ends before its first idle is a failed resume: a brain falls back to a fresh session on the same row, a Steward stays interrupted; folded messages count as delivered only when the first turn ends; `keepHarmonizer` replaces a Harmonizer that ends (not one the user stopped; at most 3 restarts in 10 min); the fake adapter can now fail a resume asynchronously |
| 2 | "Resume session" could create a second Steward per task or Waykeeper per project; recovery's window let supervisors spawn replacements | `refuseReopen` refuses both; agents recovery is about to reopen are reserved (seen as `starting`) |
| 3 | Questions of a Harmonizer that never comes back stayed open forever | withdrawn at the new Harmonizer's start, which is told what was asked |
| 4 | Chat history not refilled after a reconnect snapshot | a `snapshots` counter in the store triggers the refetch |
| 5 | `GET /api/agents/:id/messages` read the whole log per call | migration 0006 indexes `events(type, agentId)`; `EventLog.latestOf` reads the last 200 |
| 6 | The mailbox rebuild dropped other agents' lifecycle events from the brain's own last turn; a second crash could fold events twice | kept unless they share a command with the brain's own act; `agent.spawned.foldedUpTo` watermark |
| 7 | Docs said a Steward whose session cannot be resumed starts over with its prompt (wrong: it stays interrupted); SPEC §5 still described pre-P2-16 behaviour; a held tool-asked question moved to the user on restart | docs corrected (SPEC §5, decisions 44, 45; TECHNOLOGY §4, §6.3); an interrupted holder keeps the tool-asked questions it holds |
| 8 | REST message text redacted, streamed text raw | REST matches the stream (user-written text is deliberately unredacted, TECHNOLOGY §8) |
| 9 | The answer route echoed non-domain error text in a 409 | 500 `{error: 'internal'}`, logged; 404 messages redacted |

A recovery test that failed once in a full run (two Harmonizers created in the same millisecond) now breaks the tie by creation order.

## Deferred / for P2-19's real run

- An event without an actor outside the kept categories (e.g. another brain's `task.created` during this brain's own turn) is still dropped from the requeue.
- The tests cover the hierarchy in one process with the fake adapter: the real run must check the console over the real WebSocket across a `kill -9`, a resumed real-Claude Steward continuing from the short "the server restarted, continue" notice, a real lost-session fallback, and readability with several projects.
