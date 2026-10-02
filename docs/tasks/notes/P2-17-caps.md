# P2-17: Additional caps

Built on a worktree branched from `p2-wave5-flows`. This task adds **no migration** and **no protocol change**.

## What was built

| Where | What |
| --- | --- |
| `runtime/caps.ts` | `CapsEnforcer` gains the hierarchy's spawn caps. `SpawnCaps` sets `maxStewardsPerWaykeeper`, `maxSpawnsPerHour` and `maxSpawnsPerHourPerBrain`, and `DEFAULT_SPAWN_CAPS` holds their defaults (3 / 30 / 20). `DEFAULT_MAX_CONCURRENT_AGENTS` is 4, the value used before. `CapsConfig` is the type the runtime, the composition root and the config share. `canSpawn(check)` now receives the new agent's `role`, `supervisorId` and `supervisorRole`, plus `again` for a resume or renewal. `noteSpawn(by, at?)` records a spawn in a sliding one-hour window. `spawnsInLastHour(by?)` reads that window. `track()` now also records role and supervisor. With the `agentOf` option, a cap reads the agent's current row, so a Steward that moved counts under its new supervisor. |
| `runtime/agent-runtime.ts` | `spawn` passes `spawnCheck(role, supervisorId)` to `canSpawn` and calls `noteSpawn` once the row exists. `resume` and `renewSession` check with `again: true`, so they are subject to the concurrency and Stewards caps but not to the rate caps. On construction, every agent row whose `createdAt` falls inside the last hour is counted, so the hourly window survives a restart. |
| `runtime/compose.ts`, `index.ts` | `caps?: CapsConfig`. `index.ts` passes `config.caps`. |
| `config/config.ts` | The config file accepts `caps: {maxConcurrentAgents?, maxStewardsPerWaykeeper?, maxSpawnsPerHour?, maxSpawnsPerHourPerBrain?}` (positive integers). The env vars `GALACTIC_MAX_CONCURRENT_AGENTS`, `GALACTIC_MAX_STEWARDS_PER_WAYKEEPER`, `GALACTIC_MAX_SPAWNS_PER_HOUR` and `GALACTIC_MAX_SPAWNS_PER_HOUR_PER_BRAIN` override the file. `ServerConfig.caps` always has all four fields. An invalid value fails startup with the cap's name. |
| Refusal path | No new code. `AgentRuntime.spawn` returns `{ok: false, reason}`, `Commands.spawnAgent` throws `DomainError('conflict', reason)`, and the brain runner hands that to the model as a tool error. Every route meets the caps: `spawn_steward`, `spawn_waykeeper`, asteroid Stewards, the panel's `POST /api/agents` and tests. Nothing is written for a refused spawn: no row, no body and no event. |

The refusal messages name the cap, the count, the limit and when the cap frees:

- `concurrency cap: 4 of 4 agents already running (the Harmonizer and Waykeepers not counted); a slot frees when one of them ends`
- `Stewards-per-Waykeeper cap: Waykeeper a-… already supervises 3 of 3 live Stewards; a slot frees when one of them finishes, fails or is stopped`
- `spawn-rate cap: a-… spawned 20 of 20 agents in the last hour; frees at 2026-10-02T11:00:00.000Z (in 50 min)`
- `spawn-rate cap: 30 of 30 agents spawned in the last hour (all brains and the panel); frees at … (in … min)`

### Tests

- `runtime/caps.test.ts`: five new unit tests. They cover brains outside the concurrency cap, the per-Waykeeper cap (a Waykeeper's limit does not apply to another Waykeeper or to the Harmonizer's asteroid Stewards), `agentOf` placement, the global and per-brain sliding hour with its "frees at" time, the exemption for `again`, the Harmonizer exemption, and past spawns counted only inside the window.
- `domain/spawn-caps.test.ts`: four tests through `Commands.spawnAgent` on a composed runtime. (1) A refused Steward writes nothing, and a stopped Steward frees its slot. (2) With a full house of Stewards a new Waykeeper still starts. (3) The per-brain rate cap applies even after the brain's Stewards have ended. (4) The global window survives a restart on a file database.
- `brains/waykeeper/caps.test.ts`: the **acceptance** test with the P2-07 harness. A real Waykeeper definition plans three tasks, spawns two Stewards, and its third `spawn_steward` comes back `{ok: false, error: 'conflict'}` with the cap message. The Waykeeper says so: the refusal and its report appear in its `BrainTranscript` and in its persisted `transcript_chunks`. It also calls `report_status`, and the report reaches the Harmonizer's turn prompt. No agent row exists for the third task.
- `config/config.test.ts`: one new test (defaults, file, env, invalid values).
- Two existing exact-string assertions on the concurrency message were loosened or updated (`agent-runtime.test.ts`, `caps.test.ts`).

## Decisions

1. **Brains do not count against `maxConcurrentAgents`.** This answers the open question in `P2-20-placement.md`. The cap bounds Stewards, the workers. The Harmonizer and the Waykeepers are bounded structurally instead: one Harmonizer, and one live Waykeeper per project, which the user approved. Brains spend most of their time idle between turns. So a full house of Stewards can never keep the Harmonizer or a Waykeeper from starting, resuming or renewing its session. The **Harmonizer is never refused** by any spawn cap. If it were, the user's only contact could be locked out.
2. **Stewards per Waykeeper counts live Stewards whose current supervisor is that Waykeeper.** "Live" means tracked by the enforcer, from spawn until the agent's terminal event; paused agents count. It does not apply to the Harmonizer's asteroid Stewards, which only the global caps bound, or to sub-project Waykeepers under a Waykeeper.
3. **Spawns per hour counts new agent rows in a sliding hour, both globally and per spawning brain** (the new agent's `supervisorId`). A spawn without a supervisor (the Harmonizer, a panel spawn) counts only globally. Resumes after a restart and session renewals are the same agent again, so they are neither counted nor refused. The Harmonizer's own spawn is counted but never refused. Waykeepers spawned by the Harmonizer count against the Harmonizer's per-brain budget.
4. **The window survives a restart by reading the `agents` rows' `createdAt`.** Each `agent.created` folds into exactly one row, and the rows are already in memory, so this costs nothing compared with scanning the log. Per-brain counts follow the brain's agent id: a brain resumed under the same id keeps its count, and a replacement Harmonizer with a new id starts its own count. The global count holds either way.
5. **A refused spawn is a `conflict` `DomainError`.** No new error code was added, so the protocol is unchanged. The message carries the details. The Waykeeper prompt already tells it to report refusals ("a spawn the server refused, a cap") with `report_status`, and the tool description says the same, so no prompt changes were needed.
6. **Defaults**: concurrency 4 (unchanged), 3 Stewards per Waykeeper, 30 spawns per hour globally, 20 per brain.

### Proposed SPEC text (§7, a new row; number it at merge)

> | N | Cost safety | **Spawn caps in the hierarchy** (2026-10-02, P2-17): the concurrent-agents cap counts Stewards only. The Harmonizer and the Waykeepers are bounded by the hierarchy (one Harmonizer; one live Waykeeper per project), so a full house of Stewards never keeps a brain from running, and the Harmonizer is never refused by any spawn cap. A Waykeeper has at most N live Stewards (default 3). New agents per sliding hour are capped globally (default 30) and per spawning brain (default 20). A resumed or renewed session is not a new spawn. The hourly window survives a restart (counted from the agents created in the last hour). A refused spawn is a tool error naming the cap, the count, the limit and when it frees, which the brain reports to its supervisor. All four caps are configurable (config file `caps`, `GALACTIC_MAX_*` env vars). |

SPEC line 188 (onboarding) could add "Stewards per Waykeeper, spawns per hour" to its list of caps.

### Proposed TECHNOLOGY text (§5.4, replace the paragraph)

> Enforced by the process supervisor, not by prompts, from Phase 1: per-agent wall-clock and tool-call caps; a global maximum of concurrent agents; a per-Waykeeper maximum of Stewards; a maximum of spawns per hour. Hitting a per-agent cap stops the agent with a `failed(reason: cap)` event that its supervisor sees and reports. Dollar budgets per project (warn / refuse) come in Phase 8.
>
> **Spawn caps (P2-17).** `CapsEnforcer.canSpawn({role, supervisorId, supervisorRole, again})` runs in `AgentRuntime.spawn`, below `Commands.spawnAgent`, so every path meets the caps (brain tools, panel, REST). A refusal writes nothing and comes back as `DomainError('conflict', reason)`, with the cap, the count, the limit and when it frees. `maxConcurrentAgents` counts non-brain agents only, and the Harmonizer is never refused. `maxStewardsPerWaykeeper` counts the live Stewards whose current row names that Waykeeper as supervisor. `maxSpawnsPerHour` / `maxSpawnsPerHourPerBrain` use a sliding hour over new agent rows, keyed per brain by the new agent's `supervisorId`. Resume and `renewSession` check with `again` (no rate check). On startup the window is seeded from the `agents` rows created in the last hour. Configuration goes in `config.json` `caps` or the `GALACTIC_MAX_CONCURRENT_AGENTS`, `GALACTIC_MAX_STEWARDS_PER_WAYKEEPER`, `GALACTIC_MAX_SPAWNS_PER_HOUR` and `GALACTIC_MAX_SPAWNS_PER_HOUR_PER_BRAIN` env vars. Defaults are 4 / 3 / 30 / 20.

## Shared files touched (all small and additive)

- `runtime/caps.ts`: new types, `canSpawn(check)` (the argument is optional, so old calls behave as before for non-brains), `noteSpawn` and `spawnsInLastHour`, plus a third `track` parameter.
- `runtime/agent-runtime.ts`: the caps construction plus restart seeding, the `spawnCheck` helper, and the three `canSpawn` call sites plus `track`.
- `runtime/compose.ts`: the `caps` option type. `index.ts`: passes `config.caps`.
- `config/config.ts`: the `caps` schema, the env vars and `ServerConfig.caps`. `test/harness.ts`: `testConfig` gets `caps`.
- `domain/commands.ts` and `brains/*/tools.ts` are **not** touched.

## Deferred / findings

- **The worktree outlives a refused `spawn_steward`.** `placeSteward` creates the worktree before `spawnAgent` is refused, so the worktree and branch stay on disk. A later spawn for the same task reuses the path. A cheap pre-check (`runtime.caps.canSpawn` before `placeSteward`) would avoid it, but P2-11 (the Steward lifecycle) owns that tool, so it is left to P2-11 or a follow-up.
- **Nothing wakes the Waykeeper to retry when a slot frees.** It is woken by the ended Steward's `agent.finished/failed`, and the prompt tells it to start the waiting task then. There is no queued spawn.
- **The ops console does not show the caps** (`/api/runtimes` still exposes only `maxConcurrentAgents`). Exposing `spawnCaps` and the window counts fits P2-18.
- Onboarding (SPEC line 188) does not ask for the new caps yet.
- Dollar budgets remain Phase 8.
