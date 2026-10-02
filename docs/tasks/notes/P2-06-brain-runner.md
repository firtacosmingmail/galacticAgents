# P2-06 — Brain runner (mailbox, turns, seeding)

Branch `worktree-agent-a5c71a7355e60de87` (from `p2-wave2-services`). No migration: the mailbox lives in memory, and P2-16 handles requeueing after a restart.

## What was built

| File | What it does |
| --- | --- |
| `apps/server/src/brains/definition.ts` | The registration seam. `BrainDefinition = {role, systemPrompt, tools: BrainTool[], wakeRules?}`. `BrainTool.handler(input, ctx)` gets `BrainToolContext{brainId, role, projectId?, actor, commands: DomainCommands, queries: BrainQueries}`. Also `TURN_ENDING_TOOLS` and `CARRY_SUMMARY_TOOL`. |
| `apps/server/src/brains/wake.ts` | `WAKE_RULES`: the data-driven whitelist, one `{wakes, describe}` rule per event type, read through a `WakeScope`. `wakeLine(event, scope, rules?)` returns the line the prompt shows, or `undefined`. |
| `apps/server/src/brains/seed.ts` | `createBrainQueries` (read-only: agents, status records, supervised agents, project tasks, open questions), `createWakeScope` (supervises / runsTask / runsProject / ownsProposal / question), `renderSeed` (the "Current state" block). |
| `apps/server/src/brains/runner.ts` | `BrainRunner`: one per brain. It spawns the brain, feeds the mailbox, runs turns one at a time, filters the brain's own side effects, handles turn-ending tools and resets sessions. |
| `apps/server/src/brains/testing/scripted-brain.ts` | The minimal scripted fake LLM: `scriptedBrains(script)` returns a `FakeAdapter` whose brains (any role but steward) answer every turn prompt with `script({n, prompt, agentId})` steps. `callTool(name, input)` is a step. The `prompts` array records every turn. |
| `composeRuntime` | Adds `queries` and `startBrain(definition, placement, {coalesceMs?, reset?})`. |

Small additive changes to shared files:

- **`permission-gate.ts`**: new `serverTools` option. A call to one of the brain's own tools, named bare or as `mcp__galactic__<name>`, is allowed after the cap check. Before this change the Claude SDK adapter's PreToolUse hook classified a brain tool as an "unknown tool" and asked the user to approve every call.
- **`agent-runtime.ts`**: the gate gets `serverTools` from `req.tools`. `attachMailbox(agentId)`: after it, `send()` without `turn: true` only logs `message.sent`, and the mailbox delivers it. `send(..., {turn: true})` is the runner's own delivery path. `renewSession(agentId, prompt, reason)` opens a fresh adapter session on the same agent row: the old session is logged `agent.interrupted{reason}` and stopped, its stragglers are dropped, and then `agent.spawned` records the new `sessionRef`. `Live.spec` keeps the spawn request so the new session reuses it.
- **`fake-adapter.ts`**: a `tool_call` step that names one of `SpawnOptions.tools` now awaits that tool's handler and emits the result as `agent.output(kind: tool)`, the way the SDK's in-process MCP server does. New `scenarioFor(opts)` option, remembered by name for `resumeSession`.

No new event types, so the protocol, fixtures and web reducer are untouched.

## Decisions (proposed text to paste)

**TECHNOLOGY §5.2, after "One turn at a time per brain":**

> **Brain runner (P2-06).** `apps/server/src/brains/runner.ts` drives one brain. It spawns the brain through `DomainCommands.spawnAgent` with `tools` and `systemPrompt`, then calls `AgentRuntime.attachMailbox`. From then on, messages sent to the brain (the user's chat, a subordinate's report) are only logged as `message.sent`. The mailbox folds them into the next turn, and the runner logs `message.delivered` for each one once that turn has been delivered, so a restart does not redeliver them. A turn starts only when the brain is idle and ends at its `agent.idle`. The turn prompt is "Since your last turn: 1. … 2. …" followed by the seed block: supervised agents with status, the project's tasks, and the open clarification questions the brain holds or its agents asked. A woken idle brain waits `coalesceMs` (default 0, which means one `setImmediate`) before its turn starts, so events committed together become one turn. The wake whitelist is the table `WAKE_RULES` (`brains/wake.ts`), one rule per event type: `message.sent` (from the user or a supervised agent), `question.opened/answered/escalated/reassigned` (clarification only, when the brain holds or held the question or one of its agents asked it), `proposal.approved/edited/rejected/parked` (proposals the brain owns, which today means the Harmonizer's), `agent.finished/failed/stalled` of supervised agents, and `control.*` aimed at the brain, a supervised agent, or a task or project it runs. Permission questions, `agent.output`, `agent.tool_call` and the brain's own lifecycle events never wake it.
>
> **Own side effects.** Tool handlers receive a `DomainCommands` proxy. When a call returns, every event it appended is removed from the mailbox: domain commands publish before they return, and agent commands return the events they caused. A brain's own actions therefore never wake it, neither mid-turn nor after the turn. Events from anyone else that arrive during the same turn still wake it next turn.
>
> **Turn-ending tools.** `ask_user`, `escalate`, `propose`, `request_project_closure` (and any tool with `endsTurn`) return `{result, turnEnded: true, note}` to the model. Any later tool call in the same turn is refused with `{error: "turn_ended"}`. The turn itself is not interrupted: it ends at the model's next `agent.idle`. A refused command reaches the model as `{error: <DomainError code>, message}` and never fails the turn.
>
> **Session reset.** The policy is `{afterTurns?, summarize?: 'ask' | fn}`, plus `requestReset()` on demand. With `ask`, the brain gets one summary turn and calls `carry_summary` (a tool the runner adds to every brain). Then `AgentRuntime.renewSession` replaces the adapter session on the **same agent row**: the log shows `agent.interrupted{reason: "session reset"}` followed by `agent.spawned` with the new `sessionRef`. The new session's first prompt carries the summary, the events that waited, and a fresh seed. The agent id stays the same, so Stewards keep their `supervisorId`.

**TECHNOLOGY §3.1 (permission gate), one sentence:**

> A brain's own tools (`SpawnOptions.tools`) are server code checked by `DomainCommands`. The gate allows them by name, bare or as `mcp__galactic__<name>`, after the tool-call cap, and never consults the policy table for them.

No SPEC change.

## Seams for later tasks

- **P2-07 (harness):** grow `brains/testing/scripted-brain.ts`. The script already sees every turn prompt, and tool handlers run for real. Still missing: steps that depend on tool results, assertions on tool inputs and outputs, and canned brain definitions.
- **P2-08 / P2-10:** write a `BrainDefinition` (prompt plus `BrainTool[]` against `ctx.commands` and `ctx.queries`), then call `composed.startBrain(def, {runtime: 'claude-sdk', cwd | projectId, supervisorId})`. `list_supervised_agents` and `get_agent_status` are thin wrappers over `ctx.queries`. Mark user-facing tools `endsTurn`, or use one of the names in `TURN_ENDING_TOOLS`. To wake on something new (a plan card decision, a promotion), extend `WAKE_RULES` or pass `wakeRules`. `WakeScope.ownsProposal` is the hook for Waykeeper plan cards. The Harmonizer auto-start belongs in `index.ts`/compose.
- **P2-14:** control events are consumed as they are. A pause on a task wakes the brain that runs the task.
- **P2-16:** the mailbox is in memory. Recovery must restart a runner for each brain. `recoverAgent` does not yet pass `tools`/`systemPrompt` from the definition: it should resume through `renewSession`/`BrainRunner` instead, or accept them. It must also requeue the events after the brain's last delivered turn. Undelivered `message.sent` to a brain should go to the mailbox, not to the raw inbox. The runner's own turn messages are `message.sent` from `system` and are redelivered by the runtime as today.

## Deferred / known limits

- No persistence of mailbox or turn counters (P2-16).
- An ended brain's runner drops its mailbox.
- `renewSession` does not carry messages still queued in the old inbox. A brain's inbox is empty between turns.
- Identifying own events relies on the JSON equality of each event: two byte-identical events in the same turn window are treated alike.
- A turn-ending tool does not interrupt the model. The refusal is the enforcement. If the SDK keeps calling tools after the refusal, `interrupt` can be added later.
- Seeding reads `tables.*.all()` on every turn. That is fine at this scale, but should be indexed if it ever becomes a hot path.
- The panel's `POST /api/agents/:id/send` works unchanged: for a brain, the message is logged and then folded by the mailbox.
