# Phase 8 wave 4 review (P8-06, P8-08)

Review of `phase-8...p8-wave4-pty-desktop`, 2026-10-06, security first. No blockers (terminal agents
run only where the table allows what it cannot classify). Fixes landed on `p8-wave4-review-fixes`
and were merged into the batch branch; gates green afterwards (protocol 100, desktop 28, server
1342 + 4 skipped, web 1679), `pnpm drills` and `pnpm e2e` green, PTY conformance 3×.

Two implementation agents and the fix agent were stopped once each by the stream watchdog and
resumed from their worktrees; nothing was lost.

## Should-fix (all fixed)

1. **Control characters reached the terminal** (^C, ^U, ESC sequences) through prompts, messages,
   answers and the user's line. Stripped on every typed path; refused at the route.
2. **Lines over 1024 bytes were lost** by cooked-mode CLIs (macOS MAX_CANON). Long prompts go
   through a 0600 file the agent is told to read, or `{promptFile}` in `pty.args`.
3. **Typing into an idle agent** left it shown idle; it now opens a turn and tells the runtime.
4. **Questions failed open** to a supervisor. Every detected question is permission-kind (user
   only) unless a configured `clarificationPatterns` regex matched; aider-style prompts recognised.
5. **Tightening the table** left a running terminal agent looking busy forever; it is now stopped
   with the reason, and answers re-check the gate. SPEC 112 reworded.
6. **Typed secrets were logged in the clear**; redacted now, and the input warns it is logged.

## Nits (fixed)

The phone may restart a terminal agent from its first prompt (SPEC 90/114); a push in the command
line gets its own refusal reason; spinner redraws coalesced; the terminal view keeps the last
512 KB and opens links only after a confirmation; the desktop shell probes the login shell off the
main thread with `-lc` and a killed timeout, rate-limits `open`, and never auto-starts while an
import or restore holds the lock; notification overlap with a browser tab documented.

## Left open

- P8-07: a real ACP runtime run.
- P8-06 by hand: the window and menu bar on screen, a real notification and its permission prompt,
  Start at Login, ⌘Q and reopening from the Dock.
- P8-08: tune the default patterns and timings against a real CLI.
