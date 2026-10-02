# P2-09 — Proposal flow

Built in a worktree branched from `p2-wave5-flows`, in parallel with P2-11, P2-12 and P2-13. No migration: parking and the `initGit` consent live in `Proposal.meta`. One new event, `proposal.unparked`. `proposal.parked` and `proposal.edited` gained optional fields.

## What was built

| File | What it does |
| --- | --- |
| `packages/protocol/src/domain.ts` | `ParkOffer`, `ProposalParking` (`reason`, `waitingFor?`, `occupied?`, `offers?`), `proposalParking(p)`, and `foldProposalMeta(meta, {parked?, initGit?})`. The server and the web reducer both fold proposal `meta` through this one function, so the two cannot drift. |
| `packages/protocol/src/events.ts` | `proposal.parked` gains optional `waitingFor`, `occupied` and `offers`. `proposal.edited.changes` gains optional `initGit`. New `proposal.unparked {proposalId, proposedBody, reason}`. |
| `packages/protocol/src/commands.ts` | `ProposalDecision.edit.changes.initGit?: boolean`. |
| `apps/server/src/domain/parking.ts` (new) | `requestOf`, `bodyRequestOf` (whether a card needs a new planet or moon), `roomFor` (the body the card names while it is still free, otherwise `chooseBody`), `parkingFor` (the decision 16 payload), `park`, `parkIfNoRoom`, `unparkWaiting`. |
| `apps/server/src/domain/approval.ts` (new) | `ProposalOptions` (`ChooseOptions` plus `checkWorkspace`). `carryOut` creates what an approved card asks for, inside the approval transaction. |
| `apps/server/src/domain/proposals.ts` | `createProposal` parks a card at once when there is no room. `decideProposal`: approve parks the card instead of approving when there is no room (or refuses if it is already parked), then calls `carryOut`. Edit handles `initGit` and `checkWorkspace`, then re-parks if there is still no room. Every decision except a park drops `meta.parked`. Reject and edit run the un-park sweep. |
| `apps/server/src/domain/bodies.ts` | `release()` (archival, retention sweep, `freeBody`) calls `unparkWaiting` after `body.freed`. This is one line. |
| `apps/server/src/domain/commands.ts` | `CommandsOptions.checkWorkspace`. The proposal commands pass `{...choose, checkWorkspace}`. |
| `apps/server/src/runtime/compose.ts` | Wires `checkWorkspace` to `Workspaces.checkPath` when composed with workspaces. |
| `apps/server/src/workspace/workspaces.ts` | `prepareProject`: `initGit` defaults to `project.meta.initGit`. This is one line. |
| `apps/server/src/brains/wake.ts` | Wake rule `proposal.unparked`, for the Harmonizer, which owns the card. |
| `apps/server/src/brains/harmonizer/tools.ts` | `propose` returns `state` and `parked`. `create_project` and `create_task` return what the approval created; they are idempotent and no longer return `conflict`. `create_task` applies `priority` and `blockedBy`. `spawn_waykeeper` prepares an unprepared workspace (`prepareProject`) before it starts the Waykeeper. |
| `apps/server/src/brains/harmonizer/prompt.ts` | Covers approval (things are already created; start the agents), parked (tell the user and make the offers) and "pending again". |
| `apps/web/src/state/reduce.ts` | Folds `parked`, `unparked`, and `edited` with `initGit`, through `foldProposalMeta`. |

## Decisions (proposed text to paste)

**SPEC §7, decision N — The proposal flow (2026-10-02, P2-09).**

- **Approval creates the work.** Approving a work card creates what it asks for in the same step, as the user left the card: a project on the planet or moon the card names, or a task. If that body was taken meanwhile, the catalogue picks another free body. If no body is free, the card is parked instead of approved. The Harmonizer then only starts the agents. The body is therefore assigned together with the approval, and nothing the model does can differ from the card.
- **Parking is the server's call.** Parking applies to a card that needs a new planet or moon: a new project, a standalone task the user resized up, or a promotion. When no such body is free, the card is parked at creation, at an edit or at approval. The parked card lists the occupied bodies with their occupants and states, and offers:
  - for a planet: downsize to a moon, downsize to asteroids, or close a completed project early;
  - for a moon: asteroids, or close early;
  - for a sub-project: stay a task on the planet, or close early.

  A task added to a project, an asteroid and a Waykeeper's plan never park.
- **Un-parking is automatic.** It happens in the same step that frees a body: archival, the retention sweep, or an explicit free. It also happens when a pending card is rejected or edited and stops proposing its body.
  - The oldest waiting card gets the freed body. The card returns to `pending` and now proposes that body. The Harmonizer tells the user, who still approves the card.
  - A freed body goes to one card only. A body that a pending card already proposes counts as taken for this purpose.
  - Creation and edits do not look at other cards. Two pending cards may name the same free planet: the user chooses which to approve, and the second approval parks.
- **Other un-parking paths.** An edit by the user un-parks a card (`edited`). If the edited card still needs a body none is free of, it stays parked. A card the user parks by hand is never un-parked by the server.
- **Workspace consent (decision 27).** The card's "initialise git" toggle is the user's alone; a brain cannot set it. It is recorded on the project when the card is approved. The workspace is prepared before the project's Waykeeper starts. An existing non-git folder becomes a repository only if the user gave that consent; otherwise its Stewards run one at a time.
- **Workspace checks.** A workspace the user types on the card is checked when it is entered, against the rules of decision 27.

**TECHNOLOGY §5.3, after the Harmonizer paragraph:**

> *Proposal flow (P2-09, `domain/parking.ts`, `domain/approval.ts`).*
> - A card needs a body when `bodyRequestOf(p)` says so: a non-plan, non-asteroid card whose `meta.request` is `new_project`, `standalone_task` (resized up) or `promotion` without `toProjectId`. Cards without `meta.request` are left alone.
> - `parkIfNoRoom` runs in `createProposal` and after an edit. It writes `meta.parked = ProposalParking` and emits `proposal.parked` carrying the same fields.
> - `decideProposal(approve)` checks `roomFor`. With no room it parks the card, or throws `conflict` if the card is already parked. Otherwise it emits `proposal.approved` and calls `carryOut`, which emits `project.created` + `body.assigned`, or `task.created` (+ `body.created` for an asteroid). The project gets `meta.proposalId` and, with consent, `meta.initGit`. Standalone tasks keep `meta.workspace` / `meta.relatedProjectId`, as P2-08 did.
> - `release()` calls `unparkWaiting`, so `body.freed` and `proposal.unparked` commit together. Reject and edit run it too.
> - Every decision except a park drops `meta.parked`; `foldProposalMeta` (protocol) is the single fold used by the server and by clients.
> - `Commands` takes `checkWorkspace` (compose wires `Workspaces.checkPath`). `prepareProject` reads `meta.initGit`.
> - The Harmonizer's `create_project` / `create_task` return the rows that the approval created. `spawn_waykeeper` calls `prepareProject` when `meta.workspace` is missing.

**TECHNOLOGY §6 (fields):** `Proposal.meta.parked` (`ProposalParking`, present only while the card is parked), `Proposal.meta.initGit` and `Project.meta.initGit` (the decision 27 consent). The new event is `proposal.unparked`.

**IMPLEMENTATION_PLAN Phase 2:** no change needed.

## Shared files touched (small, additive)

`packages/protocol/src/{domain,events,commands}.ts` with the fixture and the exhaustive event-kind test; `domain/proposals.ts` (signatures gained `opts`; the `decideProposal` switch was rewritten); `domain/commands.ts` (one option, two call sites); `domain/bodies.ts` (one line in `release`); `runtime/compose.ts` (one option); `workspace/workspaces.ts` (one line); `brains/wake.ts` (one rule); `brains/harmonizer/tools.ts` (propose result, create tools made idempotent, a prepare in `spawn_waykeeper`); `brains/harmonizer/prompt.ts`; `apps/web/src/state/reduce.ts`. Two P2-08 tests changed: a second `create_project` now returns the same project, and the Waykeeper-wake test approves the second card after the Waykeeper started.

## Notes for the merge

- **P2-12 (promotion).** A promotion card to a planet or moon now parks when there is no room, and is approved only when `roomFor` finds a body. `carryOut` does nothing for promotions. P2-12's move should take the body from `roomFor(ctx, card)`, or from the card's `proposedBody.bodyId` after an un-park, rather than calling `chooseBody` on its own.
- **P2-13 (closure).** Any body freed through `release()` un-parks a waiting card, with no extra wiring. A freeing path that bypasses `release()` would need to call `unparkWaiting`.
- **P2-18 (console).** The card UI reads `meta.parked` (occupied, offers) and offers the `initGit` toggle through `decideProposal(edit, {initGit})`. There is still no REST/WS route for proposal decisions.

## Deferred

- `unparkWaiting` inside `release()` has no `isRunning`. For an independent moon card, decision 10's "planet without a Waykeeper" preference therefore counts every unfinished project's Waykeeper as present. It is deterministic, slightly conservative.
- A card created before P2-09 that is already approved but not carried out still goes through the Harmonizer's old create path. That path is kept as a fallback in `create_project` / `create_task`.
- The workspace of an approved project is prepared lazily, by `spawn_waykeeper` or by the Waykeeper's `placeSteward`, never in the approval transaction, because git work is I/O. A folder therefore exists only once someone works in it.
- The `meta.bodyChoice` that P2-08's `propose` writes is now informational. The parking payload is authoritative.

## Tests

- `domain/proposal-flow.test.ts`, 16 tests:
  - created → approved, creating the project on the named body;
  - edited for size, body, workspace (`checkWorkspace`) and `initGit` (an agent is refused; withdrawing consent works);
  - rejected → revised → approved;
  - a standalone task, and a project card downsized to an asteroid;
  - a task for a project, which never parks;
  - parked at creation, with the occupied list and the offers; approving it while parked is refused;
  - **resumes automatically when a planet is freed by archival (acceptance)**;
  - the oldest card wins a freed planet;
  - un-park through `freeBody` and through rejection of the card that held the planet;
  - an edit un-parks a downsized card, while an edit that still needs a planet re-parks;
  - an approval parks the card when its planet went meanwhile; another free planet is used when one exists;
  - a card parked by hand never un-parks;
  - a sub-project parks without a free moon and resumes when its planet's moon frees;
  - cards without a request, asteroid frees and plan cards are left alone.
- `brains/harmonizer/proposal-flow.test.ts`, 2 harness tests:
  - the Harmonizer proposes, the card is parked, the user archives a project, and the Harmonizer is woken with "is pending again"; approval, then `create_project` and `spawn_waykeeper` on the freed planet;
  - `spawn_waykeeper` prepares the workspace: an existing folder with consent is git-initialised; one without consent stays non-git and is serialised.
- `apps/web/src/state/conformance-proposals.test.ts`: replay vs snapshot at every commit over the flow.

Totals: protocol 50; server 675 (674 passed, 1 skipped); web 32.
