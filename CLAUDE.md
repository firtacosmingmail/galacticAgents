# GalacticAgents

Local application that manages the AI coding agents running on the user's computer through a 3D solar-system interface. Earth is the headquarters; planets, moons and asteroids host projects and tasks by size; agents are satellites doing visible work. Single developer (Cosmin), part-time, local git repo for now.

## Read these first

| Doc                           | What it is                                                                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/SPEC.md`                | **What** the product does. Source of truth. §7 holds every product decision (1–20); §8 the open questions.                                   |
| `docs/TECHNOLOGY.md`          | **With what**: stack, adapter layer, brain runtime, persistence, protocol, security. §7 defines the shared vocabulary (`packages/protocol`). |
| `docs/IMPLEMENTATION_PLAN.md` | **In which order**: phases 0–8 with exit criteria, plus the corner-case list.                                                                |
| `docs/tasks/README.md`        | The task board: phase table, ID scheme, statuses.                                                                                            |
| `docs/tasks/PHASE_*.md`       | One file per phase: purpose, references, design notes, execution order, tasks.                                                               |

When the docs disagree, `SPEC.md` wins on product behaviour and `TECHNOLOGY.md` on technical design; fix the other doc in the same commit.

## The system in one paragraph

A Node/TypeScript **Mission Control server** spawns and supervises agents through a runtime-agnostic `AgentAdapter` interface (day one: a Claude Agent SDK adapter with subscription login; later ACP and PTY adapters). Three agent roles: one **Harmonizer** (the user's single contact; sizes requests into planet/moon/asteroid proposals; supervises asteroid Stewards), one **Waykeeper** per project (plans tasks once, spawns **Stewards** in git worktrees, merges and closes tasks, answers or escalates questions), and Stewards (one per task; the user never chats with them except to answer an open clarification question). The Harmonizer and Waykeepers are themselves agents run through the same adapter, driven by an event **mailbox** (one turn at a time, non-blocking user-facing tools). Everything persists in SQLite with one rule: domain mutation + event insert in one transaction; the status store and task/project states are projections over the event log. The web UI (React + React Three Fiber on WebGL) consumes a resumable WebSocket stream (`hello{token, lastEventId}` → snapshot/events → `{seq, event}`), first as a plain side panel, later as the solar-system scene, later still as a PWA over Tailscale.

## Key decisions to keep in mind (details in `SPEC.md` §7)

- Work requests need one confirmation card; conversational requests never do; a Waykeeper's plan is one card.
- Questions have a `kind`: **permission** (resolved by the per-project policy table or the user, never by an LLM) and **clarification** (a supervisor may answer from context, always logged).
- Project tasks live on the project's body; only standalone tasks are asteroids; moving work makes its satellite fly.
- Moons host either sub-projects (part of the planet's project) or independent small projects (visibly their own).
- Waykeepers close tasks; the user closes projects after the Harmonizer relays "anything else?".
- Restart = stop then auto-resume from saved sessions; the Harmonizer reports what was recovered.
- Hard caps (time, tool calls, concurrency, spawns) from Phase 1; dollar budgets in Phase 8.
- WebGL only; Agent SDK adapter first; `--bare` opt-in only; three-package monorepo.

## Repository layout (target)

```
apps/server/      Fastify + ws + SQLite + agent runtime; src/adapters, src/brains, src/domain
apps/web/         Vite + React 19 + R3F (WebGL), later PWA
packages/protocol zod schemas, event model, AgentAdapter + DomainCommands interfaces
docs/             SPEC, TECHNOLOGY, IMPLEMENTATION_PLAN, tasks/
```

Rules: nothing outside `apps/server/src/adapters` imports a runtime SDK; nothing redeclares a type that belongs in `packages/protocol`; speculative fields go in a `meta` JSON column, not the schema.

## Ticket flow

Tasks are managed in `docs/tasks/`. Every unit of work is a task with an ID like `P1-03` (Phase 2.5 uses `P25-nn`).

1. **Pick.** Open the phase file for the current phase. Choose the next task following the _Execution order_ table: a task may start only when everything in its _Depends on_ list is `done`; tasks in the same wave may run in parallel (e.g. as separate agents or worktrees). Prefer the lowest-numbered eligible task unless the phase file says otherwise.
2. **Claim.** In the phase file, set the task's **Status** to `in progress`, update the **Current task** and **Task status** lines at the top of the file (when several tasks run in parallel, list them all), and update the phase row in `docs/tasks/README.md`. Commit: `P1-03: start <title>`.
3. **Prepare.** Read the _References_ listed in the phase file for that task (the SPEC/TECHNOLOGY/PLAN sections), the _Design notes_ of the phase, and any `docs/tasks/notes/` file the task points at.
4. **Implement.** Work in small commits prefixed with the task ID (`P1-03: add graceful stop sequence`). Tests accompany code (Vitest); the acceptance criteria in the task are the definition of done. If the task reveals a product or technical decision, record it: product → `SPEC.md` §7 (new numbered decision) or §8 (open question); technical → `TECHNOLOGY.md`; then reflect it in `IMPLEMENTATION_PLAN.md` if the plan changes. Never leave the three docs inconsistent.
5. **Discover.** New work found on the way becomes a new task appended to the phase file (next free number, "(added <date>)"), never an unbounded extension of the current one.
6. **Finish.** Set **Status** to `done (<YYYY-MM-DD>)`, update the phase status count, set **Current task** to the next task (or `—` if the phase is complete), update `docs/tasks/README.md`, and write the notes file if the task requires one. Commit: `P1-03: done — <one line>`.
7. **Phase exit.** When every task is done, verify the phase's _Exit criteria_ explicitly, record the result in the phase file (`Phase status: done (<date>)`), and move **Current task** of the next phase to its first wave.

Statuses: `todo` → `in progress` → `done (<date>)`; also `blocked (<reason>)` and `dropped (<reason>)`.

## Git conventions

- Local repository on `main`; no remote for now. Commit directly to `main` with task-prefixed messages; use a branch (`p1-03-short-slug`) only for risky or parallel work, and merge it back when the task is done.
- Commit messages: `<task-id>: <imperative summary>`; docs-only changes without a task use `docs: <summary>`.
- Never commit secrets, `.env`, SQLite files or `node_modules` (see `.gitignore`).

## Working agreements for agents working in this repo

- Follow the ticket flow above; do not start implementation without claiming a task.
- Keep `docs/tasks/README.md` and the phase file headers truthful at every commit — they are the status board.
- Respect the adapter boundary and the protocol package; add a migration for any schema change.
- Prefer the fake adapter and the scripted fake LLM for tests; real Claude runs are local-only and tagged.
- When unsure about product behaviour, look for a decision in `SPEC.md` §7 before asking; if none exists, add an open question to §8 and choose the most conservative behaviour meanwhile.
