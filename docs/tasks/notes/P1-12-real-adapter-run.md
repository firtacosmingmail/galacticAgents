# P1-12 — Conformance and resume against the real adapter (2026-10-01)

Run log of the Phase 1 acceptance against the `claude-sdk` adapter. Environment: Linux sandbox,
Node 22, `@anthropic-ai/claude-agent-sdk@0.3.285` (pinned; bundled CLI 2.1.x), a claude.ai OAuth
login (`claude auth status` → `oauth_token`, first party), default model. Nothing here runs in CI;
every command below is local-only and gated by `GALACTIC_REAL_CLAUDE=1` or is a script.

**Left for the dev machine:** repeat the three commands once under Cosmin's own subscription after
`pnpm install` (same login kind, so no surprise expected; decision 17 deserves the check).

## 1. Conformance suite — 11/11

```
GALACTIC_REAL_CLAUDE=1 pnpm --filter @galactic/server exec vitest run src/adapters/claude-sdk/claude-sdk.conformance.test.ts --reporter=verbose
```

```
✓ spawns, streams output and tool calls, ends the job with agent.idle          6.8 s
✓ asks a clarification question, waits, and continues with the answer           7.7 s
✓ requests a permission with the tool call attached; allow runs it              6.7 s
✓ pauses without events and resumes to completion                              39.0 s
✓ interrupt ends the turn with idle; queued messages are delivered in order,
  interrupts first                                                             10.3 s
✓ echoes a message sent while idle                                              4.5 s
✓ stop from every state > while working                                         6.3 s
✓ stop from every state > while waiting for an answer                           5.7 s
✓ stop from every state > while paused                                          7.1 s
✓ stop from every state > while idle                                            3.6 s
✓ resumes a session from its ref after the adapter went away                   12.7 s
Tests 11 passed (11) · Duration 111 s
```

The suite is the same one the fake adapter runs in CI (`adapters/conformance.ts`), with
`jobEnd: 'idle'` (a long-lived SDK session ends its job with `agent.idle`, TECHNOLOGY §3.1) and
`timeoutMs: 120_000`. The stall case is skipped for the real adapter (it would need five silent
minutes). Found on this run: the suite's `describe` now carries the target's timeout — Vitest's
5 s default had been masking the real runs until the first full re-run after P1-09.

## 2. Kill the server mid-task, restart, the agent resumes from `sessionRef`

```
pnpm --filter @galactic/server exec tsx scripts/sdk-restart-smoke.ts
```

Life 1 runs in a child process: it spawns an agent whose prompt says a codeword ("starting") and
then runs a 30-step shell loop; the parent kills the child with `SIGKILL` while the loop runs, so
nothing is flushed or interrupted. Life 2 in the parent opens the same database:

```
== life 1 (child process) ==
  life 1: agent.tool_call
  kill -9 life 1 while the agent runs its shell loop
  orphaned CLI pid 15510: still running (row status running)

== life 2 (this process) ==
  reconcile: {"dead":[],"orphans":["a-6d5485fa-…"]}
  status before recover: working
  life 2: #5 agent.interrupted
  life 2: #6 agent.spawned
  recover: {"resumed":["a-6d5485fa-…"],"needAttention":[]}
  life 2: #7 agent.tool_call
  life 2: #8 agent.idle
  state after resume: idle
  life 2: #9 message.sent            ← "what was the codeword?"
  life 2: #10 agent.idle
  transcript tail: [ 'finished', 'starting' ]
  same session remembered "starting": true
  life 2: #11 control.stop
  life 2: #12 agent.stopped
  agent events across both lives: agent.spawned agent.tool_call agent.interrupted agent.spawned
    agent.tool_call agent.idle message.sent agent.idle agent.stopped

live processes left: 0 | orphan still alive: false
```

So: `reconcile()` finds the orphaned CLI (pid still alive, its owner gone), kills it and logs
`agent.interrupted`; `recover()` reopens the session from the saved `sessionRef`
(`resumeSession`), the agent finishes its turn, and a follow-up message proves the transcript
survived (it remembers the codeword from life 1). A clean restart (SIGTERM → `shutdown()`) goes
through the same path with `agent.interrupted{pending: [...]}` and redelivery of whatever was
queued; `runtime/recovery.test.ts` covers both with the fake adapter.

## 3. Ops console click-through (P1-11, real adapter)

Playwright against `pnpm dev` (Vite + server, fake and `claude-sdk` adapters registered): spawn
from the form with a prompt that asks a question and then runs `rm -rf …`; the clarification
card appears (`Which option do you prefer?`), answered; the permission card appears with the tool
call (`Bash {"command":"rm -rf …"}`, action `destructive`), allowed; `idle`; pause → `paused`;
resume → `idle`; "Reply with exactly: ready" → transcript shows `ready`; stop → `stopped`;
cost shown ($0.14 for the run). No page errors. The same script passes with the fake `full`
scenario.

## Verdict

Phase 1 exit criteria hold against the real adapter: spawn, follow, answer both question kinds,
pause/resume, interrupt, stop, kill -9 + restart with resume, a tool-call cap stop (unit-tested
with the fake adapter; the gate's pre-flight is adapter-independent), and the fake adapter runs the
same suite in CI.
