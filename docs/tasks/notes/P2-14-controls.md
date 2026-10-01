# P2-14 — Control actions

## What was built

- `apps/server/src/domain/cascade.ts`:
  - `applyControlState(ctx, target, verb, by, {isLive})`: what stop / cancel / pause / resume do to a task's or project's state. `recordControl` calls it in the same transaction as the `control.*` event, so a refused action writes nothing and reaches no agent.
  - `agentsOf(tables, target)`: a task's Stewards; a project's Waykeeper(s) plus the Stewards of its tasks. Sub-projects are separate targets.
  - `agentEffect(action)`: which runtime call each live agent gets: pause → `pause`, resume → `resumeAgent`, stop / cancel / close → `stop`. Edit, archive, pin and reopen leave the agents alone.
  - `concernedSupervisors(tables, event, {isLive?}) → agentIds`: pure. It names the brains whose mailbox a `control.*` event belongs in (see below).
  - `retentionDue(tables)`: the retention seam for P2-13.
- `Commands.control(target, action, by)` (`domain/commands.ts`), for a task or project:
  1. reads the target's live agents (new optional `AgentControl.liveAgents()`; `AgentRuntime` already has it);
  2. records the event and the state effect in one transaction;
  3. applies the agent effect through the runtime to each live agent. The runtime logs `control.*{target: agent}` and the adapter's `agent.paused` / `agent.stopped` itself.
  If some agents refuse (for example, no session yet), the state change and the other agents' effects stand, and the call rejects with `conflict` naming the agents that refused. The result's events are this command's own: the domain events, plus the affected agents' events, but not what other agents logged meanwhile.
- REST: `POST /api/control` with body `ControlBody = {target, action}` (`packages/protocol/src/rest.ts`; `ControlActionBody` is a discriminated union, and edit accepts only `description` / `priority` / `name`). It answers `{ok, seq}`, 400 for a bad body, 404 for an unknown target, 409 for a refusal, and 401 without the token. The route is enabled when `AppOptions.commands` is passed, which `index.ts` does. Harmonizer tools call the same `DomainCommands.control`.
- Tests: `cascade.test.ts` (state table, `agentsOf`, `concernedSupervisors`, retention), new cases in `commands.test.ts` (real runtime, fake adapter, `scenario:long` at speed 1), a `/api/control` test in `agent-routes.test.ts`, and a `ControlBody` test in `rest.test.ts`.

## Decisions (proposed text, ready to paste)

**SPEC §7, decision 25. Control action states (2026-10-01, P2-14).** Explicit control actions set the state of a task or project, recorded with `by`. Agent-caused changes are left to derivation (P2-15).

| action | task | project |
|---|---|---|
| pause | `paused`; its Stewards are paused | `paused`, along with its running tasks (`approved`, `in progress`, `blocked on user`, `awaiting closure`, `interrupted`); its Waykeeper and Stewards are paused |
| resume | `in progress` if one of its agents is live, otherwise `approved` (its supervisor respawns a Steward); paused agents are resumed | the same, for the project and each of its paused tasks |
| stop | `paused`: the work is unfinished and its Stewards are stopped. The Waykeeper (woken by the event) or the user decides whether to restart it. A **stopped Steward does not finish its task** | `paused`, along with its running tasks; every agent of the project is stopped |
| cancel | `failed` by the user (a `proposed` task: `archived`, asteroid freed); its Stewards are stopped. Reopen brings it back | `failed` by the user, along with its unfinished tasks; every agent is stopped; refused while a sub-project is active. The body stays for the retention period, then the archival job archives the project and frees the body. A `proposed` project is archived at once |
| close | Stewards are stopped (finished work keeps no agent running) | Waykeeper and Stewards are stopped (decision 11) |
| edit / archive / pin / reopen | no agent effect | no agent effect (archive is refused while anything runs) |

Resuming a project also resumes tasks that were paused one by one before it. Resuming a stopped project only sets it back to `approved`. Respawning its Waykeeper is up to the Harmonizer, which `control.resume` wakes.

**TECHNOLOGY §5.2, addition.** A `control.*` event concerns the supervisors given by `concernedSupervisors(tables, event)`. The actor itself is never included:
- an agent target concerns its `supervisorId`;
- a task target concerns its Stewards' supervisors and its project's Waykeeper (the Harmonizer for a standalone task);
- a project target concerns its Waykeeper(s) and their supervisors, the parent project's Waykeeper, and the Harmonizer.

A cascaded action logs the target-level event first, then one `control.*{agent}` per affected agent. The supervisor's mailbox therefore sees both, in that order.

## Seams

- **P2-06 (mailbox):** call `concernedSupervisors(tables, event, {isLive})` from the `control.*` wake rules. It agrees with `WAKE_RULES`' `targets()` but works from the tables alone, without a `WakeScope`.
- **P2-13 (retention):** `retentionDue(tables)` lists `completed` / `failed`, unpinned projects, using `updatedAt` as "since". That is approximate: a later edit moves it, so P2-13 may want a precise `finishedAt`. The archival job then calls `commands.control({kind:'project'}, {action:'archive'}, {type:'system'})` or `archiveProject`, which frees the body (tested by `commands.test.ts` "cancelling a project …").
- **P2-15 (derivation):** every state set here goes through `setTaskState` / `setProjectState` with `by`. Under its contract, such a state holds until one of the item's agents is spawned or resumed. A resume with live agents resumes them, which hands control back to derivation.

## Deferred

- Pause, stop and cancel do not cascade to sub-projects. Cancel refuses while a sub-project is active, as close does.
- Respawning a Waykeeper or Steward after resume or reopen belongs to P2-10 / P2-11 / P2-16.
- A WS command channel for controls. The panel uses REST, like the other ops-console actions.
- Conformance: no new event types, so the replay-vs-snapshot walk is unchanged.
