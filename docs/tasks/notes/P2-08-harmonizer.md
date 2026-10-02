# P2-08 — Harmonizer brain

Built in a worktree branched from `p2-wave4-brains`, in parallel with P2-10 (Waykeeper) and P2-21 (remote floor). No migration and no new event types.

## What was built

| File | What it does |
| --- | --- |
| `apps/server/src/brains/harmonizer/prompt.ts` | `HARMONIZER_SYSTEM_PROMPT`. It covers the Harmonizer's role, conversational versus work requests (decision 3: one card, or none), the related-work check before sizing, the sizing rules (planet, moon, asteroid, a task on the project's body), the moon rules (decision 10), no free planet (decisions 1 and 16), what to do after each proposal decision, supervision, questions (decisions 7 and 12), the closure relay "Anything else on <project>?" (decision 11) and escalation etiquette. |
| `.../harmonizer/tools.ts` | `harmonizerTools(deps)`: `find_related_work`, `size_request`, `propose`, `create_project`, `create_task`, `assign_body`, `spawn_waykeeper`, `spawn_steward`, `propose_promotion`, `close_task`, `ask_user`, `free_planets`, `free_moons`. Each has a JSON schema and a handler that calls `DomainCommands` and `BrainQueries`. |
| `.../harmonizer/agent-tools.ts` | `SUPERVISOR_TOOLS`: `stop_agent`, `pause_agent`, `resume_agent`, `get_agent_status`, `list_supervised_agents`, `answer_question`, `report_status`. These duplicate P2-10's set (see below). |
| `.../harmonizer/related.ts` | `findRelated(request, {projects, tasks})`. A deterministic word-overlap search: stopwords are dropped and plurals trimmed. It searches project names, workspace folder names, and task descriptions (both a project's tasks and standalone tasks). Archived work is skipped unless asked for. |
| `.../harmonizer/input.ts` | Readers for untrusted tool input (a bad field is refused as `invalid`), `isLiving`, and JSON-schema helpers. |
| `.../harmonizer/index.ts` | `harmonizerBrain(deps)` returns the `BrainDefinition`. `startHarmonizer(host, opts)` is the boot start. `harmonizerRuntime(setting, dev)` picks the runtime. |
| `.../harmonizer/harmonizer.test.ts` | 11 tests on the P2-07 harness (see Tests). |
| `apps/server/src/index.ts` | The Harmonizer starts after `listen` (see Decisions). |

### Rules the tools enforce, whatever the model does

- **Decision 3.** `create_project` and `create_task` need the id of an **approved** proposal that the Harmonizer made. The proposal must carry `meta.request`. Before approval the tools refuse with `invalid_transition`. A second creation for the same proposal is refused with `conflict`: the row's `meta.proposalId` is checked.
  - The proposal's current `kind` decides the action. An approved card that the user resized on the card to an asteroid becomes a standalone task; a standalone card that the user resized to a moon becomes a project.
- **One card per turn.** `propose` and `propose_promotion` end the turn: `propose` through `TURN_ENDING_TOOLS`, `propose_promotion` and `ask_user` through `endsTurn`. A second card in the same turn is refused with `turn_ended`.
- **Decision 7.** `answer_question` refuses a permission question with `invalid` before it calls the command. Permission questions never reach the mailbox in the first place: the existing `WAKE_RULES` handle that.
- **Asteroid-only work.** `spawn_steward` and `close_task` refuse a project task, because those belong to its Waykeeper.
- **No duplicate agents.**
  - `spawn_steward` refuses a task that already has a living Steward, and a task in a finished state.
  - `spawn_waykeeper` refuses a project that already has a living Waykeeper.
  - A sub-project's Waykeeper gets the parent project's Waykeeper as its supervisor. Placement matches the supervisor by role and project, as decision 32 says.
- **Closing.** `close_task` goes through `commands.control(task, close)`, so a Steward that is still running is stopped (decision 28).
- **No self-control.** `stop_agent`, `pause_agent` and `resume_agent` refuse the brain itself.

## Decisions (proposed text to paste)

**SPEC §7, decision N. The Harmonizer's tools (2026-10-02, P2-08).**

- **A work request is one card.** It produces exactly one proposal, which records what it asks for: a new project, a standalone task, a task added to an existing project, or a promotion. Nothing is created and no agent is spawned until the user approves the card. The server refuses the Harmonizer's create tools before approval, so the rule does not depend on the model. After approval, the Harmonizer carries out the card *as the user left it*: an edited size changes what is created.
- **A standalone task's folder.** The card shows the workspace of the task's related project, or a new scratch folder `<projects root>/scratch/<slug>`. The user may change it on the card. Its Steward works there. If a task has no recorded folder, it gets `<projects root>/scratch/<task-id>`.
- **Boot.** The Harmonizer starts with the server, on the `claude-sdk` runtime, or on the fake adapter in dev mode. `GALACTIC_HARMONIZER=off|fake|claude-sdk` overrides the choice. If a Harmonizer is already running, for example one that startup recovery resumed, no second one is started.

**TECHNOLOGY §5.3, after the tools table:**

> *Harmonizer (P2-08, `brains/harmonizer/`).* `harmonizerBrain(deps)` is the prompt plus the tools above. The deps are `projectsRoot`, `checkPath` (`Workspaces.checkPath`), `startWaykeeper` (the Waykeeper brain starter wired by the server) and `stewardPrompt`.
> - `find_related_work` is a deterministic word-overlap search over projects, their tasks and standalone tasks.
> - `size_request` informs the decision and changes nothing. For the size the model judges, it returns the body `chooseBody` would give, a suggested name and workspace (`<projectsRoot>/<slug>`, or `scratch/<slug>` for an asteroid), the related work, and the free planets and moons. When the model passes no size, a keyword hint fills in.
> - `propose` stores what the card asks for in `Proposal.meta.request`: `{type: new_project | standalone_task | project_task | promotion, name, …}`. On "no free planet/moon" it also stores the `BodyChoice` in `meta.bodyChoice`, so P2-09 can park the card.
> - `ProposedBody.name` is the work's name. The body is named by `bodyId`.
> - A task added to a project is proposed with the project's body kind and `bodyId`.
> - `create_project` and `create_task` need an approved proposal and record `meta.proposalId` on the row. A standalone task also records `meta.workspace`. `CreateProjectInput`, `CreateTaskInput` and `CreateProposalInput` gained an optional `meta`.
> - The tools write no permission policy, so the P2-21 floor does not apply to them. A future policy input must pass the turn's origin.
>
> `index.ts` calls `startHarmonizer` after `listen`. It has `cwd = projectsRoot`, and it skips the start when `runtime.liveAgents()` already holds a Harmonizer. Tests build the app through `buildApp`/`startTestApp`, never `index.ts`, so no test gets a Harmonizer it did not ask for.

**IMPLEMENTATION_PLAN Phase 2:** no change needed.

## Duplicates to consolidate at merge (P2-10 owns `brains/common-tools.ts`)

`agent-tools.ts` duplicates `stop_agent`, `pause_agent`, `resume_agent`, `get_agent_status`, `list_supervised_agents`, `answer_question` and `report_status`. Their behaviour:

- The control tools take any agent by id, except the brain itself. The Harmonizer commands everyone (SPEC §2.1). If P2-10 restricts them to supervised agents, keep the Harmonizer's wider version, or add a scope option.
- `answer_question` refuses `kind: permission` up front with `invalid`.
- `report_status` is read-only here: `{projectId? | taskId? | agentId?}`, or the whole system (projects, standalone tasks, live or interrupted agents, pending proposals, open-question counts), so the Harmonizer can answer a status question (SPEC §4.3). If P2-10's `report_status` means "report upward to my supervisor", the two are different tools under one name. The Harmonizer's should then become `get_status`, or the report should take a `to`.
- `agentLine` and `statusReport` are exported for reuse.

The harness already has a `harmonizerDefinition` in `testing/canned.ts` (a minimal test supervisor). The real definition is `harmonizerBrain`, so the names do not collide.

## Shared files touched (all small and additive)

- `packages/protocol/src/commands.ts`: optional `meta?: Meta` on `CreateProjectInput`, `CreateTaskInput` and `CreateProposalInput`.
- `domain/projects.ts`, `domain/tasks.ts` and `domain/proposals.ts`: each copies `input.meta` onto the row (one line each).
- `brains/definition.ts` and `brains/seed.ts`: `BrainQueries` gained `agents()`, `projects()`, `tasks()`, `task(id)`, `body(id)`, `proposal(id)`, `proposals()`, `question(id)` and `allOpenQuestions()`.
- `index.ts`: the boot start. `lib.ts`: exports.
- `runner.ts`, `wake.ts`, `compose.ts` and `app.ts`: unchanged.

## Seams for wave 5

- **P2-09 (proposal flow).**
  - `meta.request` says what an approval sets in motion.
  - `meta.bodyChoice` holds the occupied planets when parking.
  - The Harmonizer already reacts to `proposal.approved` by calling `create_project` + `spawn_waykeeper` or `create_task` + `spawn_steward`. If P2-09 moves this to the server, those tools stay as the manual path, and their `meta.proposalId` check keeps the work from being done twice.
  - Workspace preparation (`Workspaces.prepareProject`, git init on the card's say-so) is not called by `create_project`. Add it there or in P2-09's approval step.
- **P2-10 → the server.**
  - `HarmonizerDeps.startWaykeeper({projectId, supervisorId, runtime})` should return `composed.startBrain(waykeeperDefinition(...), {runtime, projectId, supervisorId})`. `index.ts` does not pass it yet, so `spawn_waykeeper` is refused with "no Waykeeper brain is available on this server" until the merge wires it.
  - A Waykeeper started from a tool is not in `h.brains`, so `settle()` does not wait for it. The tests start it through `h.startBrain` inside the dep, which avoids that.
- **P2-11 (Steward lifecycle).** `HarmonizerDeps.stewardPrompt(task, {workspace, instructions?})` replaces `defaultStewardPrompt`. Asteroid Stewards are spawned under the Harmonizer, with `cwd` = the card's folder.
- **P2-12 (promotion).**
  - `propose_promotion` creates the card with `meta.request = {type: 'promotion', target: {kind, id}, fromBodyId, toProjectId?}` and moves nothing.
  - `toProjectId` covers "an asteroid task joins an existing project".
- **P2-13 (closure).**
  - The prompt tells the Harmonizer to relay a closure report with `ask_user("Anything else on <project>?")`.
  - The question context has no `projectId` (`QuestionContext` has no `meta`). P2-13 may want `ask_user({about: {projectId}})`, which would need a context field.
- **P2-16 (resume).**
  - After a restart, recovery resumes the old Harmonizer through the adapter **without its runner, tools or system prompt**, and `startHarmonizer` then leaves it alone (decision 32). Until P2-16 restarts the runner for it, a resumed Harmonizer is a plain session. Seen in a dev-mode smoke run: "Recovered: 1 agents resumed … Harmonizer already running".
  - P2-16 should resume the Harmonizer through `BrainRunner`/`renewSession`, with `harmonizerBrain(deps)`.

## Deferred / known limits

- `find_related_work` is lexical, not semantic. The model judges relevance.
- `size_request`'s keyword hint is only a fallback for a missing `kind`.
- Brains count against `maxConcurrentAgents`: the Harmonizer takes one slot from boot (P2-17).
- The Harmonizer's working directory is the projects root, which `index.ts` creates if missing.
- `spawn_steward` validates the folder through `checkPath` and creates it (`mkdir -p`). The folder is not git-initialised: an asteroid task has no worktree.

## Tests

`brains/harmonizer/harmonizer.test.ts` holds 11 tests, all on the harness with the fake adapter:

1. A status question: `report_status` is called, and there is no proposal and no agent.
2. "Start a new project: build a CLI that converts CSV to Parquet":
   - `find_related_work` → `size_request` → one `propose` (planet, Mars, `<root>/parquet-cli`);
   - a second card in the turn is refused (`turn_ended`);
   - no project and no agent exist.
3. An approved project card: `create_project` before approval is refused (`invalid_transition`). After approval: `create_project` (twice → `conflict`), then `spawn_waykeeper` (twice → `conflict`). The Waykeeper sits under the Harmonizer on the project.
4. An asteroid task:
   - card → approval → `create_task` → `spawn_steward` (`scenario:asks`) in `<root>/scratch/rename-logs`;
   - the Steward's clarification is held by the Harmonizer, which answers it (`answeredBy` = the Harmonizer);
   - the Steward finishes → `close_task` → `completed`.
5. A permission question (`scenario:permission`):
   - it is held by the user and is never a mailbox line;
   - the Harmonizer has exactly the turns it was scripted for;
   - `answer_question` on it is refused (`invalid`);
   - the user answers and the Steward finishes.
6. Related work → a `project_task` card on the project's body. Approved → `create_task` in the project; `spawn_steward` and `close_task` on it are refused.
7. `propose_promotion` creates a card and moves nothing.
8. Boot start: one Harmonizer on Earth; a second call reports it as running.
9. The boot runtime choice.
10. `findRelated` ranking.
11. `hintKind`.

Totals: protocol 48; server 624 (623 passed, 1 skipped); web 31. The Harmonizer file passed 5 consecutive runs.
