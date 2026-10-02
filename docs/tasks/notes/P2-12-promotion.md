# P2-12 — Promotion and moves (notes)

Branch: the P2-12 worktree off `p2-wave5-flows`. The phase file, README, SPEC, TECHNOLOGY and PLAN were not edited (coordination rule); the texts below are ready to paste. No migration: everything new lives in existing JSON `meta` columns.

## What was built

| File | What it does |
| --- | --- |
| `domain/handover.ts` (new) | `handOverTask(ctx, taskId)` and `handOverProject(ctx, projectId)`: re-parent the agents of moved work **in the same command**. A moved task's Stewards get the task's project and that project's Waykeeper (the Harmonizer for a standalone task). A project whose `parentProjectId` changes gets its Waykeeper re-parented: to the parent's Waykeeper, or to the Harmonizer when detached. Every row moves, ended ones too. A row without a supervisor (Phase 1 ops console) stays outside the rules. The supervisor is the newest *living* candidate, else the newest row. With no candidate the command is refused and rolled back ("start it first"). |
| `domain/tasks.ts`, `domain/projects.ts` (small edits) | `moveTask` calls `handOverTask` after `moveAgents`. `updateProject` calls `handOverProject` when `parentProjectId` is in the changes. Both take an optional `HandOverOptions{isLiving}`. |
| `domain/commands.ts` (small edit) | `moveTask` and `updateProject` pass `isLiving` from the question routing (`handOver()`). |
| `domain/promotion.ts` (new) | Transactional steps: `transferTask` (a project task joins another project: `task.updated{projectId, bodyId}`, the Stewards fly, then the hand-over; no marker, because the old planet still hosts its project), `moveProject` (a sub-project leaving its planet is detached first, so its Waykeeper goes to the Harmonizer; then `moveHost`; refused while the project has sub-projects), `recordPromotion` (writes `meta.carriedOut` on the card and emits `promotion.carried_out`, once), `createPromotedProject(ctx, p, body)` (the card's new project, with `meta.proposalId` and `meta.promotedFrom`; created once; usable in P2-09's approval transaction), `promotionRoom` / `promotionBodyRequest` / `promotedParent` (which body a promotion gets: the same rule as P2-09's `roomFor`), `isPromotion`, `carriedOut`, `usableBody`, `nameOf`. |
| `brains/promotion.ts` (new) | `PromotionFlow`, the orchestration (see Decisions). `start()` subscribes to the log and carries out approved cards left unrecorded. Also `stop()`, `idle()` (tests), `carryOut(id)` (idempotent and shared while running) and `promotionActor(id)` = `{type: 'system', id: 'promotion:<card>'}`. |
| `index.ts` | Starts the flow after recovery. Its `startWaykeeper` is shared with the Harmonizer's deps. |
| `brains/wake.ts` | New rule `promotion.carried_out`: wakes the card's owner (`ownsProposal`) and the Waykeeper of `outcome.projectId`. The line reads "promotion X was carried out: task T moved from A to B (project P, Waykeeper W); its Stewards (…) were handed over and resumed", or "… could not be carried out: <reason>". |
| `brains/harmonizer/prompt.ts`, `brains/waykeeper/prompt.ts` | One sentence each: the server moves the work, the Steward is paused meanwhile, and the brain is told when the move is done. |
| Protocol | `PromotionRequest` and `proposalPromotion(p)`, which read both card shapes: the Harmonizer's `meta.request{type: 'promotion', target, fromBodyId, toProjectId?, name}` and the Waykeeper's `meta.promotion{taskId, fromProjectId, requestedBy}`. `PromotionOutcome{ok, target, fromBodyId?, toBodyId?, projectId?, waykeeperId?, stewardIds?, error?}`. Event `promotion.carried_out{proposalId, outcome}` with its fixture and the exhaustive classifier. |
| Web reducer | `promotion.carried_out` sets `proposal.meta.carriedOut` and `updatedAt`, the same as the server row. |
| Conformance walk | `moveTask` now hands over by itself (the explicit `updateAgent` is gone, and the result is asserted). New section: an asteroid Steward runs `long`, a promotion card pauses it, the approval makes the flow create a moon project on Io, spawn its Waykeeper, move the task and hand over the Steward. The walk then checks `promotion.carried_out`. The concurrency cap was raised to 8. |

### The flow, step by step

1. **Card created** (`proposal.created`, a task target, either card shape): every live Steward of the task is paused as `system:promotion:<card>` (SPEC §3.4). An agent that is already paused records nothing, so the card never resumes it later.
2. **Rejected:** Stewards whose last `control.pause` came from this card are resumed. If the card is **edited or parked**, they stay paused.
3. **Approved** (`carryOut`):
   - **A task becomes a new project:** the project is created with `meta.proposalId` (found again on a retry) and `meta.promotedFrom{kind: 'task', taskId, bodyId, projectId?}`. It goes on the card's body if that body is still free and of the right kind; otherwise the catalogue chooses (`createProject` without a `bodyId`). A Waykeeper's moon becomes a sub-project of the requesting project, unless the user moved the card to a moon of another planet.
   - **A task joins `toProjectId`:** that project is used as it is.
   - **The Waykeeper:** if the project has no living Waykeeper, one is started (`startWaykeeper`). Its supervisor is the living Harmonizer, or for a sub-project the parent's living Waykeeper (the requester first). Its runtime is that supervisor's.
   - **The move:** a standalone task uses `commands.moveTask`, which emits `body.moved{intoProjectId}`, sets the asteroid's marker and hands the Stewards over in the same command. A project task uses `transferTask`.
   - **A project target:** moves with `moveProject` to the card's body if it is still free, else to `chooseBody({kind})`.
   - **Finishing:** the Stewards this card paused are resumed, then `recordPromotion`.
   - **Failure:** any error records `ok: false` with the message, and the Stewards are still resumed. What was done before the failure stays.

## Decisions (proposed text, ready to paste)

**SPEC §7, decision N. Promotion and moves (2026-10-02, P2-12).**
> | N | Promotions and moves | **The server carries out the card** (2026-10-02, P2-12): a promotion card — the Harmonizer's (an asteroid task to a moon or planet, a moon project to a planet, a standalone task into an existing project) or a Waykeeper's (its task to a sub-project moon or a planet) — is carried out by the server on the user's approval, never by a brain's tools. While the card waits, the task's live Stewards are paused (a Steward the user had paused stays the user's); a rejection resumes them where they are, an edited or parked card keeps them waiting. On approval: the new project (on the card's body if still free, else the catalogue's choice; a Waykeeper's moon is a sub-project of its project, a Harmonizer's moon an independent project), its Waykeeper started when none runs (under the Harmonizer, or the parent project's Waykeeper), the task moved to the project's body with its Stewards handed over in the same commit, then resumed; the card records the outcome and its owner reports it. A card is carried out once; one approved before a crash is carried out at the next start. A failed step is recorded on the card and reported; the Stewards resume on their old body. The history link is the new project's `promotedFrom` and the `body.moved` event; a standalone task's asteroid keeps its "moved to …" marker for the retention period (decision 15). A project task leaves no marker (its planet still hosts its project). A project with sub-project moons does not move. |

**SPEC decision 32, replace the sentence "Until P2-12 does the hand-overs, … P2-12 closes it." with:**
> Moving work hands its agents over in the same commit (P2-12): a task that joins a project gives its Stewards that project and its Waykeeper; a sub-project detached from its planet gives its Waykeeper to the Harmonizer, one attached to a planet to that planet's Waykeeper. A move that would leave a Steward or Waykeeper without the prescribed supervisor is refused (start the Waykeeper first).

**SPEC §3.4 (append):** "The promotion is carried out by the server once the user approves; the brain that proposed it is told and reports it (decision N)."

**TECHNOLOGY §5 (brains), after the placement line:**
> *Promotions (P2-12, `brains/promotion.ts`).* `PromotionFlow` subscribes to the log: `proposal.created` of a task promotion pauses the task's live Stewards as `system:promotion:<card>`; `proposal.rejected` resumes the ones whose last pause was the card's; `proposal.approved` runs deterministic steps — `createProject` (with `meta.proposalId`, `meta.promotedFrom`), `startWaykeeper` when the project has no living Waykeeper, `moveTask` (standalone) or `transferTask` (project task), or `moveProject` for a project target — then resumes and records the outcome (`recordPromotion`: `Proposal.meta.carriedOut` + `promotion.carried_out`). Each step checks what is done, the record makes the card one-shot, `start()` carries out approved cards left unrecorded. Brains never move bodies: `promotion.carried_out` wakes the card's owner (the Harmonizer, or the requesting project's Waykeeper) and the Waykeeper of the work's project. `index.ts` starts the flow after recovery.

**TECHNOLOGY §6.2 (append to the hand-over / placement paragraph):**
> *Hand-overs (P2-12, `domain/handover.ts`).* `moveTask`, `transferTask` and an `updateProject` that changes `parentProjectId` re-parent the affected agents inside the same command (`agent.updated{supervisorId, projectId?}` after the flight's `agent.updated{bodyId}`): every row with a supervisor, ended ones included; the newest living candidate (`QuestionRouting.isLiving`), else the newest row; none → `conflict`, rolled back.

**TECHNOLOGY §7 vocabulary (add):**
> `promotion.carried_out{proposalId, outcome: PromotionOutcome{ok, target: Host, fromBodyId?, toBodyId?, projectId?, waykeeperId?, stewardIds?, error?}}`, folded into `Proposal.meta.carriedOut`; `proposalPromotion(proposal)` reads either promotion card shape (`meta.request.type = 'promotion'` or `meta.promotion`).

**IMPLEMENTATION_PLAN Phase 2:** no change. Phase 4 should note that a project task's promotion has no `body.moved`: its satellite flight comes from the Steward's `agent.updated{bodyId}`.

## Shared files touched (small, additive)

- `domain/tasks.ts`: one import, a `handOver` parameter on `moveTask` and a call to `handOverTask`.
- `domain/projects.ts`: one import, a `handOver` parameter on `updateProject` and a call to `handOverProject`.
- `domain/commands.ts`: a private `handOver()` passed to `moveTask` and `updateProject`.
- `brains/wake.ts`: one rule added.
- `brains/harmonizer/prompt.ts` and `brains/waykeeper/prompt.ts`: one sentence each.
- `index.ts`: wiring of the flow; `startWaykeeper` is shared with the Harmonizer's deps.
- `lib.ts`: exports `PromotionFlow`, `promotionActor`, `carriedOut` and `isPromotion`.
- Protocol: `domain.ts`, `events.ts` (union), `fixtures/events.ts`, `events.test.ts`.
- `apps/web/src/state/reduce.ts` and `conformance.test.ts`.
- `domain/placement.test.ts`: the hand-over test now expects `moveTask` to hand over by itself.
- `domain/proposals.ts`, `brains/harmonizer/tools.ts` and `brains/waykeeper/tools.ts` are **untouched**.

## For other tasks

- **P2-09 (proposal flow) — merge notes.** P2-09 runs approval on the server (`domain/approval.ts`). Its `carryOut` creates nothing for a promotion, and `decideProposal` parks a card that has no room (`roomFor`). So the flow starts after a successful approval, and a promotion behaves like a plain card. To make them line up exactly:
  1. **Body choice.** Pass `roomFor: (p) => roomFor(log, p, choose) ?? promotionRoom(log, p, choose)` to `PromotionFlow` in `index.ts`, so the flow takes its body the way approval does. Without it the flow uses `promotionRoom`, which follows the same rule (the named body while it is free and of the right kind, else `chooseBody`).
  2. **The new project in the approval's transaction** (optional, recommended). In `approval.ts carryOut`, for a promotion with a task target and no `toProjectId`, call `createPromotedProject(ctx, p, body)` (`domain/promotion.ts`) with the room's body. The flow then finds the project by `meta.proposalId` and does only the Waykeeper, the move and the hand-over.
  3. **Waykeeper promotion cards** (`meta.promotion`, no `meta.request`) are invisible to `bodyRequestOf` and never park. `promotionBodyRequest(ctx, p)` gives their request (a moon of the requesting project's planet, or a planet), so `bodyRequestOf` could fall back to it.
  4. A promotion card that is parked keeps its Steward paused until the card is approved or rejected. Un-parking needs nothing from P2-12.
  5. `foldProposalMeta`: the server's `recordPromotion` and the reducer both spread the meta and add `carriedOut`. If P2-09 wants every meta change to go through `foldProposalMeta`, add `carriedOut` to it.
- **P2-13 (retention):** the asteroid's marker is freed by `sweepMarkers`, so the scheduler only has to call it.
- **P2-16 (resume):** the flow carries out approved cards that were left unrecorded. A Steward paused by a *pending* card is not paused again after a restart (the pause is runtime state). It is paused again at approval, before the move.
- **P2-18 (console):** show `meta.carriedOut` on the card: the outcome, or the error.

## Deferred / known limits

- **Partial failure.** *(Superseded by the wave-5 review fixes.)* The approval now creates the new project (or moves the project target), so the body is reserved. No running supervisor or a refused Waykeeper spawn makes the card wait and retry (`RetryLater`, on agent lifecycle events and every minute, for 2 h); a Waykeeper started by the Harmonizer meanwhile is adopted; a final failure fails the empty project and frees its body. `start()` re-pauses the Stewards of undecided cards, and a paused agent's wall clock stops.
- **Workspaces.** The new project's workspace is the card's. A promoted asteroid Steward keeps working in its folder (scratch or related project), and if it has no worktree, its new Waykeeper closes it unmerged or sends it back. A project task promoted under an edited workspace keeps its worktree in the old repository.
- **Cost of `resumeStewards`.** It scans the whole log for the card's pauses. This is fine at the scale of a local app; an index on control events would make it cheap.
- **Moving a planet down.** A project target with sub-projects is refused at approval, not when the card is made.
- **Blockers.** A task's `blockedBy` may point into its old project after a transfer. Nothing enforces blockers across projects.

## Tests

- `domain/handover.test.ts` (5): `moveTask` hands over every Steward row; a living Waykeeper is preferred over a newer ended one; the move is refused with nothing written when there is no Waykeeper; detach to the Harmonizer and attach to the parent's Waykeeper; attach is refused when the parent has no Waykeeper.
- `domain/promotion.test.ts` (6): `transferTask` (events, no marker, idempotent; refusals); `moveProject` (detach and hand-over, then `body.moved`; a project with sub-projects is refused); both card shapes, and `recordPromotion` records once; `promotionRoom` and `createPromotedProject` (a sub-project moon on the requesting planet, a taken body replaced by the catalogue, created once).
- `brains/promotion.test.ts` (5, harness): **asteroid → moon with a mid-task Steward** (paused on the card, then project, Waykeeper, move, hand-over and resume; the Steward finishes under its new Waykeeper; the owner and the new Waykeeper are told; idempotent; **the asteroid is freed after the retention period**); **task moved into an existing project** (its running Waykeeper takes the Steward over in the move's commit, and no new Waykeeper is started); a Waykeeper's task becomes a sub-project moon under the Waykeeper that asked; a rejection resumes the Steward; a failure is recorded, and a card approved while no flow listened is carried out by the next `start()`.
- `brains/wake.test.ts`: the whitelist, plus the new rule's lines and scope.
- `domain/placement.test.ts`: the hand-over test now expects `moveTask` to do the hand-over.
- Conformance walk: a promotion, and `promotion.carried_out` is required.

Totals: protocol 50, server 673 (+1 skipped), web 31. Build, typecheck, lint and format:check all pass. The promotion, Harmonizer and Waykeeper tests passed 5 runs in a row.
