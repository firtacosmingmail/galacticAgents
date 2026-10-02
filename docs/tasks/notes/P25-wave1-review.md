# Phase 2.5, batch 1 (wave 1: P25-01, P25-02) — review

Branch `p25-wave1-endpoints-shell` against `phase-2.5`, 2026-10-02. Two parallel agents in worktrees, both merged cleanly. An independent review (server and web suites twice each) confirmed the bearer guard on every new route, strict validation, a safe `config.json` write (temp + rename, 0600, token kept), a preflight that returns no email or org, gap- and duplicate-free paging, stable ids and redaction parity with the stream, a traversal-free deep-link fallback and no raw HTML. A fix agent closed its findings (each test fails without its fix):

| # | Finding | Fix |
|---|---|---|
| 1 | A settings write saved the raw projects root (e.g. a leading space) and the next start refused to boot (reproduced) | the cleaned value is saved; patch-then-reload test |
| 2 | The projects root accepted `~`, `/etc`, the data dir (the Harmonizer's cwd after a restart, next to the token) (reproduced) | the workspace path rules, shared (`unsafeFolder`, `canonical`) and applied on the symlink-free path |
| 3 | Remote clients could loosen every setting but the policy — caps to 64 / 10 000 / 100 000, retention to seconds, Stewards loading user settings (reproduced) | local-only settings until Phase 7: a remote (or unknown-origin) PATCH may change only `qualityTier` and a floored policy, else 403 `remote_settings` (SPEC decision 51) |
| 4 | Every session reset and every auto-resumed agent raised "work interrupted by a restart" | new event `recovery.needs_attention`; the notification keys on it only |
| 5 | A reconnect backfilled alerts for answered questions | closed questions skipped |
| 6 | Conversation paging re-sorted all of an agent's rows per page | migration 0007, partial indexes; a query-plan test (no temp B-tree, no scan) |
| 7 | Proposed decision 50 contradicted 37 silently | 50 states it refines 37's clearing rule for the global default |
| nits | `lastSeq` for the live transcript (and the transcript endpoint's `lastSeq` dropped buffered chunks); wrong-kind deep link URL; no "forget token" on the panel; notification cursor could move back; preflight env, refresh rate and a missing global `claude` | all fixed |

Decisions recorded: SPEC 50 (global default policy as a setting), 51 (settings are local-only until Phase 7; projects-root rules), 52 (what a conversation is), 53 (panel URLs and selection).
