# P4-04 — Body transitions: fly, land, colonise, moved marker

Branch `p4-04-transitions` (from `p4-wave3-transitions`). Code in `apps/web/src/scene/satellites/` (list rule, director) and the new `apps/web/src/scene/colonies/`. No server, protocol or schema change: moves, promotions, completion and archival already arrive as events, and the client reducer already folds them.

## What was built

### Flights on moves and promotions

How a move reaches the scene (unchanged, checked end to end in `transitions.test.ts` with the server's real event shapes through the client reducer):

- **A standalone task joins a project** (`moveTask`): `task.updated {projectId, bodyId}`, `body.moved {host: task, fromBodyId: asteroid, toBodyId: planet, intoProjectId}`, `agent.updated {bodyId}`. The asteroid loses its host, gets the "moved to …" marker and stops being drawn (`taskAsteroids` draws only hosted asteroids, decision 63).
- **A project task promoted to another project** (`transferTask`): `task.updated {projectId, bodyId}`, `agent.updated`.
- **A moon project promoted to a planet** (`moveProject` → `moveHost`): `body.moved {host: project}`, `project.updated {bodyId}`, then `task.updated` for each of its tasks on the old body, `agent.updated` for its Waykeeper and Stewards, and `promotion.carried_out`.

In each case the satellite's work body (`workBody`: the task's or project's `bodyId`) changes, and the director starts the 3 s flight in `setSpecs`, when the world changes, not at the next drawn frame. That covers every satellite of the work: a task's Stewards; a project's Waykeeper and the Stewards of its tasks.

What changed is **where a flight starts** (`director.ts`, `placeFlight`). The origin is captured on the flight's first frame, trying these in order:
1. where the satellite was drawn on the last frame, if that is at most `STALE_ORIGIN` (2 s) old (the usual case). This already covers an old body that stops being drawn in the same render that starts the flight (the asteroid folds into the belt): the satellite was drawn on the frame before;
2. its orbit around the old body's live anchor (the satellite was hidden on the last frame, or its last drawn position is stale after a long gap without frames, such as a hidden tab: the old body has moved on since);
3. **the ghost** (new): `Entry.lastDrawn`, the position where the satellite was last drawn on the old body. It only runs after a frame where the satellite itself was hidden, when the old body is not drawn now either;
4. only then the destination.

A second fix: a frame where the destination has no anchor no longer throws the captured origin away. The flight stays keyed by its start time, so it carries on from the same take-off point once the destination is drawn. Before this fix, a flight whose destination was missing for a frame lost its take-off point: it re-took it from the old body's orbit, or, if the old body was gone too, from the destination, which meant no visible flight at all.

Unchanged, as asked: flights always complete, even off-camera (absolute times on the motion clock). They always animate and count against the cap. Under reduced motion they are instant.

Not built: the optional faint trail from the old body to the new one (see Deferred).

### Landing (completed work's satellite)

`SCENE_SATELLITES = { keepFailed: true, keepLanded: true, harmonizer: true }`. The rule (`hasLanded`) was widened beyond the P4-01 hook ("a `finished` Steward whose task is `completed`") because the hook would almost never fire. A Waykeeper closes a task while its Steward is idle, and `control.close` **stops** the work's live agents, so the Steward's record says `stopped`, not `finished`. Also, the server drops ended status records after 24 h while retention lasts 7 days. The rule now:

- **Who lands:** a Steward whose task is `completed`, or a Waykeeper whose project is `completed`, when:
  - it is not live (whether it finished, was stopped by the close, was interrupted, or failed);
  - it is the newest agent of its role on that work (`isSuperseded`: one landed satellite per task or project, not one per attempt);
  - it ran (it has a status record or a `sessionRef`: a Steward created and never started leaves nothing to land).
- **Its look:** the spec says `state: 'finished'` whatever the record says. That gives the `finished` look from `STATE_LOOK`: the role's colour, steady, 0.6. It has no activity and no archetype. It needs no status record, so it outlives the server's 24 h pruning.
- **Precedence:** landing is checked before the `keepFailed` rule. A failed Steward whose task was closed anyway (`close_task unmerged`) lands with its completed work instead of vanishing. A failed agent on open work keeps P4-02's failure look, unchanged.
- **The sequence:** the landing takes 1.6 s, always animated, from the orbit angle it had (its orbit clock holds). Then it is `landed` at 1.03 R: dim, no beam, no animation budget. It stays until the work is archived (it shrinks out over 0.4 s) or reopened (it is no longer `completed`; the agent is not live, so it goes).
- **No orbit slot:** landed satellites hold no orbit slot. `orbitSlots` runs over the live satellites only. A satellite that lands keeps the orbit it came down from; one that appears already landed (a reload) gets a slot among its body's landed satellites, which only spreads them over the surface. Without this, a project body collecting finished Stewards would push every new live Steward onto ever higher shells.
- **Hover card:** a landed satellite says "work completed", with where = "landed · <body>".

### Colonised mark

`colonies/colony-model.ts` (pure) and `colonies/Colonies.tsx`.

- **Rule:** a body is colonised while its **host** is `completed`: a completed project's planet or moon, or a completed standalone task's asteroid.
  - **Project body with many tasks:** the mark is about the body's own work. A project task that completes lands its Steward on the project's body but does not colonise it. The planet is colonised only when the user closes the project (decision 11), and then its Waykeeper lands too. A planet with ten finished tasks and one running is still a project in progress, and its label says so.
  - The mark goes when the host is gone or no longer completed: archival or the retention sweep (`body.freed` clears the host), a reopen, or a move (which leaves only a marker).
- **Visual:** settlement lights. There are 5 clusters × 4 small warm-white lights (`#ffe6b8`, deliberately not the waiting amber `#ffb547`), seeded by the body id, within ±0.9 rad latitude. All colonies share **one** `THREE.Points` (review fix): 2.5 px, not attenuated (it reads at the system view and up close), depth-tested so lights on the far side hide behind the body, on `DECOR_LAYER` (the outline pass skips it). Its world positions are rewritten every frame at `READ_BODIES` from each anchor (`writeColony`): 1.012 R on a planet or moon; on an asteroid, through the rock mesh's own matrix (its squash and rotation) at 1.1 of its local radius. Each light's opacity follows the Sun's angle: full on the night side, 0.35 on the lit side (dimmed, not hidden, so the mark still reads at the system view). Nothing animates, so reduced motion changes nothing. The on-demand loop is asked for a frame when the list or the anchors change.
- Labels keep their completed state ("✓ completed", dimmed): unchanged.

### "Moved to …" markers

Unchanged and covered by tests. A planet's or moon's label says "moved to <body>" until `body.freed` (decision 66). An asteroid whose task moved folds into the belt (decision 63). Archival and the retention sweep clear the marker.

## SPEC decision 77 (recorded; decision 68 reworded)

> | 77 | Landing and colonised bodies | **Completed work lands and settles** (2026-10-04, P4-04; §3.4, §4.1, decisions 4, 9, 11, 15, 63, 66, 68, 72): when a task is completed its Steward's satellite lands on the task's body, whether the Steward had finished or was stopped by the close (or had failed and the task was closed anyway); only the newest Steward of the task lands. When the user closes a project its Waykeeper's satellite lands on the project's body too. A landed satellite comes down from its orbit in under two seconds, then sits on the surface, dim and still, in its role's colour, and says "work completed" when hovered; it does not take an orbit, so the satellites still working there keep theirs. It stays as long as the work is kept (decision 4's retention) and goes when the work is archived or reopened. A body is marked **colonised** — a few clusters of small warm lights on its surface — while its own work is completed: a completed project's planet or moon, a completed standalone task's asteroid. A project task that completes lands on its project's body but does not colonise it; the body is colonised when the project is closed. When work moves (a task joining a project, a promotion), its satellites fly from wherever they were last seen, even when the old body stops being drawn (an asteroid whose task left folds into the belt); the old planet or moon keeps its "moved to …" label until it is freed. |

Decision 68 would then need one sentence reworded. In place of "a finished Steward's satellite lands on its completed task's body and stays there during retention (decision 4, P4-04); until those tasks land, both disappear when the agent ends", it would say: "completed work's satellite lands on its body and stays there during retention (decision 77)". Its "An agent that has not started yet, or has stopped or been interrupted, has none" would gain "unless its work was completed (decision 77)".

## Tests (Vitest, no WebGL)

- `satellites/transitions.test.ts` (new, 7): the client reducer folds the server's real event shapes, each parsed by `EventEnvelope`. Anchors come from the same world (asteroids only while `taskAsteroids` draws them). The cases:
  - **Task joins a project (the acceptance):**
    - the satellite is `flying` at the event;
    - on the first frame it is still at the asteroid;
    - after 0.9 s it is clearly on its way;
    - after 3 s it is on Kepler's orbit;
    - the asteroid has no label and no colony.
  - **Ghost origin:** the old asteroid is gone and the destination is missing for one frame; the flight still starts where the satellite was last seen (more than 50 units from the planet).
  - **Reduced motion:** the move is instant.
  - **Completion lands on the project body:**
    - landing at mid-time is above the surface and animated;
    - `landed` at 1.03 R, not animated, no beam;
    - the project body is not colonised;
    - it is still landed after the status record is dropped;
    - archived → gone after `PRESENCE`.
  - **Standalone task completed:** the asteroid is colonised; archive + `body.freed` → no colony, no satellite.
  - **Project closed:** the Steward and the Waykeeper are both landed on Kepler, Kepler is colonised, and its label stays `completed`.
  - **Promotion (moon → planet):** the Waykeeper flies to Jupiter and orbits it after 3 s; the moon's label is "moved to Jupiter"; `body.freed` clears it.
- `satellites/satellite-model.test.ts` (+6):
  - `keepLanded` is on in the scene;
  - finished, stopped, interrupted and failed Stewards of a completed task all land with the `finished` look (a live one does not);
  - archived or reopened → no landed satellite;
  - one per task (the newest);
  - it survives without a status record when the agent ran, and is absent when it never ran;
  - a Waykeeper of a completed project lands (archived → gone);
  - the failed rules are unchanged.
- `satellites/director.test.ts` (+3):
  - landing starts exactly where the satellite was, holds no slot (a new arrival takes slot 1, not an outer shell), and reaches `landed` at the surface;
  - four already-landed satellites spread over the surface;
  - a flight keeps its origin across a frame without the destination.
- `colonies/colony-model.test.ts` (6):
  - nothing while work runs;
  - a completed project colonises, a completed task on it does not;
  - a completed standalone task colonises its asteroid;
  - a reopen, `body.freed` or a move clears it;
  - `sameColonies`;
  - the lights are unit vectors, deterministic per seed and within the band.
- `colonies/Colonies.test.tsx` (1, fake R3F as in `Satellites.test.tsx`, under StrictMode): no lights while the project runs; one `colony:b-luna` once it completes, with a frame asked; the frame loop does not crash without anchors; the lights go when the project reopens.
- `picking/satellite-card.test.ts` (+1): a landed satellite says "work completed · landed · Mars".

Gates (repo root):
- `pnpm build && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` all green;
- 67 protocol, 910 server (+1 skipped), 989 web tests;
- three.js is still out of the panel's first chunk (`index-*.js`: no `WebGLRenderer`, no `PointsMaterial`; both only in the `SolarScene` chunk).

## Performance

- **Colonised bodies:** +1 draw call for all of them together (20 vertices per colony, no texture, three's built-in points shader with vertex colours). Per drawn frame the positions and colours are rewritten (20 × 7 floats per colony) and re-uploaded; there is no per-frame allocation.
- **Landed satellites:** they use the existing paths (mesh pair or instanced). They take no animation budget and no beam, and their orbit clock is held. At most 6 per body are drawn (`LANDED_PER_BODY`), and the list is linear in the agents (`newestAgents`).
- **Ghost origin:** one 3-tuple per satellite, updated in place each drawn frame.
- **Not measured in a browser** for this task: no headless run was done. The costs are bounded as above. The first frame-rate check is in "What Cosmin should try".

## Deferred

- **The optional trail** (a faint arc from the old body to the new one for a few seconds after a move). It was left out because the flight itself is the trail (3 s on an arc); a trail would be a line per recent move on `DECOR_LAYER`. It would be a small follow-up if the flight alone reads too briefly from far away.
- **Colony lights do not turn with the planet's spin** (an asteroid's do: they follow its rock's matrix) (they are placed on the anchor, not parented to the spinning mesh). This is invisible at today's spin rates. Parenting them to the body group would fix it if it shows.
- **Gas giants get the same surface lights** (P4-03's "orbital platforms" idea could replace them there).

## Shared files touched

- `apps/web/src/scene/satellites/satellite-model.ts`: `SCENE_SATELLITES.keepLanded`, `hasLanded` widened, `showsSatellite` order, and `satelliteList` (landed specs without a record, `finished` look).
- `apps/web/src/scene/satellites/director.ts`: landed satellites hold no slots, the ghost origin (`lastDrawn`), and the flight origin kept across a hidden frame.
- `apps/web/src/scene/picking/satellite-card.ts`: "work completed" for landed satellites.
- `apps/web/src/scene/SolarScene.tsx`: mounts `<Colonies />` after the belt.
- `docs/TECHNOLOGY.md` §2.1: the Satellites and state-look bullets now say `keepLanded` is on, plus a new "Body transitions" bullet.
- New: `apps/web/src/scene/colonies/` (model, component, tests), `apps/web/src/scene/satellites/transitions.test.ts`, this note.

## What Cosmin should try

1. **Move a task into a project:** in the panel, move a running standalone task into a project. Its Steward's satellite should leave the asteroid (which goes back into the belt) and fly to the planet within a second, arriving in about 3 s. Also try it with the camera on another planet: the satellite is already there when you look.
2. **Close a task:** let a Waykeeper close one of its tasks. The Steward's satellite should come down onto the planet over about 1.5 s and stay there, dim. The planet should not get lights yet. Hovering the satellite should say "work completed".
3. **Close the project:** close the project ("anything else?" → no). The Waykeeper should land too, and the planet should get small warm lights. Archive the project: the satellites shrink away and the lights go.
4. **A standalone task:** complete one. Its asteroid should get the lights and the satellite should land on it.
5. **Promote a moon project to a planet:** the Waykeeper should fly over, and the moon should say "moved to <planet>" until it is freed.
6. **Reduced motion** (System Settings → Accessibility → Display → Reduce motion): moves and landings should be instant, and the lights still.
7. **Decide on decision 77** above. Open questions in it:
   - whether a failed Steward of a task closed anyway should land (chosen: yes);
   - whether many landed Stewards on a big project's planet are too busy (they sit on the surface, dim; since the review only the newest 6 per body are drawn).

## Review fixes (2026-10-04, branch `p4-04-fixes`)

1. **Landed satellites no longer flood picking** (`picking/scene-pick.ts`, `Picking.tsx`). A frame in `landed` mode is not a pick candidate and does not count in "+n" / "what's here", except for a direct hit at its drawn size (no `MIN_TARGET_PX` floor) while its body is at least `CLEAR_TARGET_PX` on screen. Clicking a completed project's planet therefore does what clicking the body does: it selects the Waykeeper (decision 65). Tests (`scene-pick.test.ts`, +3), each on a completed planet with 30 landed satellites:
   - a system-view click gives the body, with no list and `others: 0`;
   - a close-up click on the surface between them gives the body, even 2 px from a landed satellite;
   - a direct close-up hit gives that agent;
   - the same hit on a speck of a body is not a candidate.
2. **Bound and cost** (`satellite-model.ts`):
   - `newestAgents(world)` maps (role, work) to the newest agent that **ran** (it has a status record or a `sessionRef`). It is built once per `satelliteList` and passed to `showsSatellite`, `hasLanded` and `isSuperseded`, so there is no longer an O(agents) scan per agent. Called alone, those three still build the index themselves.
   - A newer agent that never ran supersedes nothing. This also applies to `keepFailed`: a respawned Steward hides the failed one once it has a status record (`starting`), not as soon as its row exists.
   - `LANDED_PER_BODY = 6`: only the newest six landed satellites per body are drawn.
   - Tests (+2):
     - 300 landed agents: the agent rows are read fewer than 3 000 times (a per-agent scan would read about 90 000), and the six newest are drawn; another body keeps its own;
     - a newer Steward that never ran does not hide the older landed one.
3. **Promotion with landed satellites** (`machine.ts`, `director.ts`). When the body moves, a landed satellite is re-created **landed** on the new body: no flight and no second landing. It grows in there over `PRESENCE` (0.4 s), with no orbit blend sliding it across the surface. This is the quieter option: a fade-out on the old body would show a moon still dotted with work that has left it. The machine gains the `landed → landed` edge. A move that also reopens the work still flies, as before. Tests:
   - `machine.test.ts`: the old "a move after landing flies" test now expects `landed` on the new body;
   - `transitions.test.ts` (+1): a moon project with two landed Stewards is promoted to Jupiter. Over the Waykeeper's whole flight the Stewards are `landed` on Jupiter at 1.03 R, never `flying` or `landing`, and never animated.

Nits:
- **Ghost-origin wording** corrected in `director.ts` and in TECHNOLOGY §2.1. The ghost path runs only after a frame where the satellite itself was hidden. A fold in the same render already uses the last drawn position.
- **Stale origin:** a last drawn position older than `STALE_ORIGIN` (2 s) is not used. The flight starts from the satellite's orbit around the old body's live anchor (`director.test.ts` +1, which also checks that a fresh position is still used).
- **One draw call for all colonies:** done (above). `Colonies.test.tsx` checks that there is one `colonies` Points for two colonised bodies; `colony-model.test.ts` (+3) covers `writeColony` (offsets, positions, the night/day opacity and the asteroid lift).
- **Sun-angle fade:** done, because it was trivial once positions are written on the CPU: per-vertex RGBA, using the Sun's anchor (or the origin).
- **`asteroidLift`:** the numbers showed that lights floated visibly. The rock is jittered ±14 % per corner and squashed 0.75–1.15 per axis, so a 1.18 R sphere floated up to about half a radius over the squashed sides (≈ 0.5 units on a 1.1-unit asteroid, visible up close). The lights now follow the rock's own matrix (named mesh `asteroid-rock`), at 1.1. What is left is the corner jitter: a light over a dip floats by at most about 0.25 of the local radius, and one inside a bulge hides behind it.

Gates after the fixes (repo root): `pnpm build && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` all green; 67 protocol, 910 server (+1 skipped), 999 web tests; three.js still out of the panel's first chunk (`index-*.js`: no `WebGLRenderer`, no `PointsMaterial`).
