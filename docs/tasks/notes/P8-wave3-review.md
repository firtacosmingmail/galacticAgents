# Phase 8 wave 3 review (P8-07, P8-11, P8-12)

Review of `phase-8...p8-wave3-pids-push-acp`, 2026-10-06, security first. One blocker (P8-07).
Fixes landed on `p8-wave3-review-fixes` and were merged into the batch branch; gates green
afterwards (protocol 99, server 1282 + 2 skipped, web 1671), `pnpm drills` 38/38, `pnpm e2e` 8/8,
ACP conformance 23/23 four times.

The first gate run after the merge failed with 27 timeouts: the Mac's disk was full (1.8 GB free,
55 GB of it in 90 agent worktrees) and an agent's stalled `vitest` had run for three hours. The
stalled run was stopped by pid; Cosmin approved removing the clean worktrees (87 removed, 2 with
leftovers kept); the re-run was green.

## Blocker (fixed)

- **ACP `delete` was judged as an edit** (allowed by default) instead of a destructive command.
  It now maps to a quoted `rm -r`, judged destructive and outside-workspace like Bash.

## Should-fix (all fixed)

1. **Calls an ACP agent runs without asking** (decision 108, amended): permissive agent modes are
   refused at spawn unless `acp.allowPermissiveMode`; `acp.mode` is set on the session; a mode
   switch, or an unasked call the table would ask about, cancels the turn and opens a permission
   card (the Steward waits); an unasked call the table denies stops the Steward as failed. The
   settings page states the caveat.
2. **Mapping gaps:** search globs located, every path of a call judged, `cwd` kept on `execute`,
   pushes found in unreadable calls (also for unknown SDK/MCP tools), calls judged on `failed` and
   re-judged when their input changes.
3. **Credentials:** only routing variables pass to ACP agents by default; credentials must be named
   in `acp.passEnv`; `GALACTIC_*` refused.
4. **P8-07 stays open** (blocked): its acceptance needs a real ACP runtime, which also checks the
   input shapes the mapping relies on.
5. **Push:** a re-subscribed device leaves the gone list; key rotation clears only rows written
   before the new key and survives a restart.
6. **A launch refused on a full disk** says "the disk is full" (507).

## Nits (fixed)

`fake` refused as the Steward runtime outside dev; the settings list registered runtimes;
`GALACTIC_ACP_COMMAND` accepts a JSON array; leftover launch groups taken only when they are the
CLI's own; the tool-call cap counted once.

## Left open

- P8-07's real-runtime run (install claude-agent-acp, codex-acp or gemini; see `notes/P8-07-acp.md`).
- An ACP hold waits for the user with no timeout beyond the wall-clock cap.
- An old-key browser re-sending its subscription unchanged after a key rotation survives the clear
  (would need the key per row).
