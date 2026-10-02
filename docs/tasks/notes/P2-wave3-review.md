# Phase 2, batch 3 (wave 3: P2-04, P2-07, P2-20) — review

Branch `p2-wave3-permissions-harness` against `phase-2`, 2026-10-01. Three parallel agents in worktrees, merged by the coordinator (one conflict: the runner tests, where P2-07's harness version already gave the Waykeeper a Harmonizer). A coordinator fix during the merge: a brain is woken when a question it asked resolves (P2-07's finding). An independent review then read the combined diff, reproduced with throwaway tests and ran the server suite three times (no flakes).

## Fixed on the branch

| # | Finding | Fix |
|---|---|---|
| 1 | The coordinator's own wake fix let a brain's own **permission** question (and a clarification its session was blocked on) into its mailbox — decision 7 broken, and an answer delivered twice (reproduced) | questions opened through the command surface carry `meta.source: "command"`; the asker is woken only for those, clarifications only; tests for both refusals |
| 2a | Two concurrent Harmonizer spawns both succeeded (reproduced) | the check also counts agents with a live runtime session, and a spawn reserves the slot until it settles; concurrent-spawn test |
| 2b | Restart recovery and `POST /api/agents/:id/recover` could resume a second Harmonizer | `recoverOne` refuses a Harmonizer while one runs; boot resumes only the newest interrupted Harmonizer (the others are reported as needing attention); restart test with two interrupted Harmonizers |
| 3 | `isRemoteRequest` counted a loopback proxy without `Origin` or identity (Tailscale Serve for a tagged node, Funnel, a dev proxy) as local (reproduced) | forwarding headers (`Forwarded`, `X-Forwarded-*`, `X-Real-IP`, other Tailscale headers) and a non-loopback `Host` make a request remote |
| 6 | The gate read the policy live but the workspace at spawn: after a workspace move, the old folder still counted as inside | the gate reads the project's workspace on every check; gate test |
| 7 | `decide()` reserves no tool call — fine for hook adapters, a hole for a future hook-less PTY/ACP adapter | documented in TECHNOLOGY §3.1 for whoever writes those adapters |

## Deferred

- **4** — the remote floor applies only to `POST /api/agents`; every other `permissionPolicy` write must be floored too: new task **P2-21** (wave 4).
- **5** — `moveTask` and attaching or detaching a sub-project leave the agent under the old supervisor/project until P2-12 does the hand-over: stated as transient in SPEC decision 32, added to P2-12's scope.
- **8** — `startHarmonizer()` without a script stays lenient on purpose: it is everyone's supervisor in tests about others and is legitimately woken by their events; a test that cares scripts it (strict). `settle()` only waits for brains started through the harness; a `once` rule counts as used even when its turn is cancelled.
- `permission.decided` keeps the whole redacted tool input (as `agent.tool_call` does); truncation can come with Phase 8 retention. The conformance walk does not emit `permission.decided` (a reducer no-op).
