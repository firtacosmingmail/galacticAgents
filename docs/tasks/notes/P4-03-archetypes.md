# P4-03 — Steward activity archetypes

Branch `p4-03-archetypes` (from `p4-wave2-state-activity-beacons`), 2026-10-03.

## What was built

| File | What it does | three.js? |
|---|---|---|
| `satellites/archetype.ts` | The derivation. `classifyActivity(text)` applies three rule tables to `currentActivity`, and the first match wins. `deriveArchetype(role, status)` is the stateless hook. `ArchetypeHold` adds hysteresis per agent and escalates runs of edits. | no |
| `satellites/satellite-model.ts` | One line: `archetype: deriveArchetype(agent.role, status)`, plus its import. | no |
| `satellites/activity/use-held-archetypes.ts` | `useHeldArchetypes(list)` runs the list through `ArchetypeHold` on the wall clock. A switch that becomes due while the world stays the same lands through a `setTimeout`, so it also works under the on-demand frame loop (reduced motion). | no |
| `satellites/activity/activity-model.ts` | The visuals as data. `ActivityLayer.build(frames, ctx)` writes two instance lists (position, axis, scale, colour). `solid` holds robots, platform struts and shuttle hulls. `glow` holds drones, sparks and the shuttle's trail. Also here: `footingOf(body)` (surface or platform), the per-tier counts (`ACTIVITY_QUALITY`), every size, colour and duration (`ACTIVITY_LOOK`) and `capacityFor(maxAnimated)`. | no |
| `satellites/activity/Activities.tsx` | Copies the two lists into two `InstancedMesh`es on `DECOR_LAYER` (`writeList`). The meshes are hidden when empty, so they cost no draw call then. | yes |

### Shared files touched (minimal)

- `satellites/satellite-model.ts`: the hook line and its import.
- `satellites/Satellites.tsx`:
  - `const held = useHeldArchetypes(list)`; the layout effect applies `held` instead of `list` (3 identifiers);
  - its `useFrame` now runs at `PLACE_SATELLITES`;
  - two imports.
- `scene/frame-order.ts`: `PLACE_SATELLITES = -0.5`, documented. The satellites' director now runs after the bodies (−1) and before every reader of the registry (0). Without this, the shuttles and drones would trail their satellite by one frame. Picking and the hover ring also see this frame's positions now.
- `scene/SolarScene.tsx`: `<Activities quality={quality} />` after `<Satellites …/>`, plus its import.
- `satellites/satellite-model.test.ts`: the fixture's activity ("Editing src/session.ts") now gives `transporting`, and there is one new hook test.
- `docs/TECHNOLOGY.md` §2.1: one new "Steward activity archetypes (P4-03)" bullet after the P4-01 satellites bullet.

After merging P4-02: every archetype piece is placed from the satellite's live frame (`position`, `target`, `bodyRadius`, `size`), never from an orbit clock of its own, so it follows P4-02's per-satellite orbit clock (paused satellites hold still, failed ones drift). Archetypes apply to working Stewards only: not to failed or paused agents, and not to the HQ station. The activity test frames gained `beamTint`.

Not touched: `look.ts` colours (P4-02), the machine, the director, the phase file's status lines, `docs/tasks/README.md`, `SPEC.md`.

## What arrives from the server

There is no summariser yet (TECHNOLOGY §4 item 5 is optional). `StatusRecord.currentActivity` is written by `status-store.ts`:

- `agent.tool_call` → `describeTool`: `"<Tool>: <detail>"` (the detail is the input's `command`, `file_path`, `pattern`, `path` or `url`, up to 120 characters), or `"<Tool>"` alone. This is the structured part, and it is used first.
- `agent.progress` → the summary: the fake adapter's "Editing src/index.ts", "Running tests", "step 3 of 20", "wrapping up", or the SDK adapter's "restarting claude after a crash (1/3)". A future summariser's sentences go through the same text rules.
- `agent.needs_input` → `"Permission: …"` / `"Question: …"`. The agent is then not `working`, so it has no archetype anyway.

## The derivation rules

Only a **working Steward** gets an archetype. Waykeepers scan, and the Harmonizer has none. The tables are tried in order. A `Tool: detail` line goes through the tool table, or through the command table when the tool is `Bash`. Anything else (a sentence, an unknown single word) goes through the text table.

| Table | Rule | Matches (examples) | Archetype |
|---|---|---|---|
| tool | read tool | `Read`, `Grep`, `Glob`, `LS`, `WebFetch`, `WebSearch`, `NotebookRead`, `BashOutput` | gathering |
| tool | edit tool | `Edit`, `MultiEdit`, `Write`, `NotebookEdit` (an **edit**: the file is counted) | transporting |
| tool | neutral tool | `TodoWrite`, `Task`, `Agent`, `ExitPlanMode`, `KillShell`, `SlashCommand`, `Skill` | none |
| tool | mcp read | `mcp__*get*`, `*list*`, `*search*`, `*fetch*`, `*query*`… | gathering |
| tool | mcp write | `mcp__*create*`, `*update*`, `*send*`, `*post*`, `*push*`, `*comment*`… | transporting |
| command | commit / push / PR | `git commit\|push\|merge\|tag`, `gh pr create\|merge`, `gh release` | transporting |
| command | look around (anchored at the start, after an optional `cd x &&`) | `git status\|diff\|log\|show\|blame`, `ls`, `cat`, `head`, `tail`, `grep`, `rg`, `find`, `tree`, `wc`, `jq`, `curl` | gathering |
| command | build / test / lint | `test`, `vitest`, `jest`, `pytest`, `build`, `tsc`, `typecheck`, `lint`, `eslint`, `prettier`, `make`, `gradle`, `mvn`, `cargo build\|test`, `go test`, `xcodebuild`, `install`, `ci`… | building |
| command | (other) | `sleep 5`, `node scripts/seed.mjs` | none |
| text | waiting | `Permission: …`, `Question: …` | none |
| text | many edits | "Editing 5 files", "Updating several files", "changed 12 files" | building |
| text | running builds / tests | "Running (the) (full) tests\|builds\|lint\|checks\|gates\|suite", "testing", "building", "compiling", "type-checking", "installing", "refactoring", "implementing", "scaffolding", "migrating" | building |
| text | committing / reporting | "commit", "push", "merge", "opening a PR", "delivering", "reporting", "sending", "handing off", "writing the summary\|report\|notes\|docs" | transporting |
| text | editing | "edit", "write", "create", "add", "fix", "patch", "update", "change", "rename" (an **edit**: the path-like word is counted) | transporting |
| text | reading / searching | "read", "search", "looking at\|for\|into", "explore", "investigate", "inspect", "analyse", "review", "scan", "fetch", "research", "understand" | gathering |
| text | (other) | "step 3 of 20", "wrapping up", "Thinking about…", "Finished" | none |

**History (`ArchetypeHold`)**, per agent:

- **Escalation.** Edits to **3 distinct files within 90 s** turn an edit's `transporting` into `building` ("editing many files"). The same file again counts once.
- **Hysteresis.**
  - A new archetype must stay the latest for **0.4 s** (confirm).
  - The archetype on screen stays at least **2 s** (dwell) before another replaces it.
  - Dropping to none waits **3 s** (release), so a `TodoWrite` between two edits keeps the shuttle.
  - An agent that stops `working` drops it at once.
- **Timing.** A stable change after the dwell lands in 0.4 s. The acceptance ("switching activity in the harness changes the archetype within a second") holds whenever the previous archetype has been on screen for 1.6 s or more. Right after a switch, the next one waits out the remainder of the 2 s dwell.

## The visuals

- **Gathering.** Drones (4 on high, 3 balanced, 2 mobile; glow, green) rise in a 1.8 s loop from points on the surface around the spot under the satellite, and dock with it.
- **Transporting.** A shuttle (solid, warm white, with 2 glowing trail pieces on high and balanced) runs a 4 s round trip on an arc between the Steward's satellite and its **Waykeeper's satellite when both orbit the same body**. Otherwise (a standalone task's asteroid, whose supervisor is the Harmonizer, or a Waykeeper in flight) it goes down to the surface under the satellite and back.
- **Building on a surface.** Robots (4/3/2; orange boxes standing on the surface) work at a **work site** fixed where the satellite was when building began, about 0.1 rad apart. They wander a little and hammer at 1.6 strokes/s, with sparks on bloom tiers. The satellite keeps orbiting and the site stays.
  - Surface (`footingOf`): rocky, Earth-like and cloudy planets (Mercury, Venus, Earth, Mars, and unknown names), every moon (Titan included), every asteroid.
- **Building on a gas or ice giant.** Jupiter, Saturn, Uranus and Neptune get an **orbital platform** under the satellite, at 0.86 of its distance and never inside the body. A mast plus a square of four struts is assembled strut by strut over a 6 s cycle, with a welding spark at the strut being built. It turns slowly.
- **Transitions.** Strength follows the actor's `view.blend` (0.6 s). The outgoing archetype shrinks out while the new one grows in, and both are drawn mid-blend. A satellite that loses the animation budget fades its archetype over 0.4 s. Presence (grow in, shrink out) scales everything.
- **The cap.** Only satellites with `frame.animated` draw an archetype, so the instance count is bounded by the tier's `maxAnimated` (16 / 12 / 6): capacity is `maxAnimated × 2 × (5 solid, 4 glow)`, fixed, never rebuilt per agent.
- **Reduced motion.** Everything is static, with the clock at 0: drones frozen along their paths, the shuttle docked near the satellite, robots still, the platform complete, no sparks. It appears at once.
- **Mobile.** Fewer drones and robots, no sparks, no trail. Glow is a soft additive speck without a composer (gain 0.55, against 1.2 with bloom).

## SPEC decision 73 (recorded; proposed as 72, renumbered because P4-02 took 72)

> | 73 | Steward activities | **What a Steward does shows as gathering, transporting or building** (2026-10-03, P4-03; §4.1, decisions 63, 68, 70, corner case 32): a working Steward's satellite shows what its agent is doing right now, read from its current activity. **Reading and searching** (reading files, searching the code, fetching pages, looking at the git history) is *gathering*: small drones rise from the body's surface to the satellite. **Producing output** (editing or writing files, committing, pushing, opening a pull request, reporting back) is *transporting*: a shuttle runs between the Steward and its Waykeeper's satellite (or down to the body when its Waykeeper is not there). **Building** (running builds, tests, linters or installs, or editing many files in a row) shows robots working on the surface at the spot under the satellite on a planet, moon or asteroid with a surface, and an orbital platform being assembled on a gas or ice giant. When the activity says nothing clear (planning, a to-do list, a sub-agent, a question) the satellite just orbits and scans. The animation does not flicker: a new activity shows within about half a second once it holds, the one on screen stays at least two seconds, and a brief unclear step does not interrupt it. Waykeepers do not show activities. The raw activity text stays in the panel and the hover card, so an animation that reads it wrong is visible (corner case 32). Only satellites within the animation cap show activities; with reduced motion they are still pictures. |

## Tests (Vitest, no WebGL)

There are 98 new tests:

- `archetype.test.ts` (83):
  - the derivation table: 74 real activity lines → archetype. They include `describeTool` output for every built-in tool, shell commands (git, pnpm, cargo, go, make, gradle, pytest), MCP tools, the protocol fixture, the fake adapter's summaries, the SDK adapter's restart line, the TECHNOLOGY §4 summariser example, questions and permissions;
  - rule names and edited files;
  - `deriveArchetype` per role and state;
  - the hold:
    - a stable switch in under 1 s after the dwell (the acceptance);
    - no flicker under 20 s of activities alternating every 0.2 s;
    - confirm plus dwell timing;
    - the release delay across an unclear step;
    - an immediate drop when work stops;
    - escalation at 3 distinct files and its expiry after 90 s;
    - same objects when nothing changed;
    - `nextDue`.
- `activity/activity-model.test.ts` (11):
  - `footingOf` for every catalogue giant, rocky planet, moon and asteroid;
  - drones between the surface and the satellite;
  - the shuttle reaching both the Steward and the Waykeeper over a cycle;
  - the shuttle down to the surface without a Waykeeper on the body;
  - robots on the surface near the ground track, the site fixed while the satellite moves;
  - the platform between the body and the satellite, fully assembled over a cycle;
  - nothing drawn for Waykeepers, hidden satellites or satellites over the cap;
  - the blend in and out, and the fade on budget loss;
  - reduced motion static (identical pieces at t = 3 s and t = 17.3 s);
  - the cap bounds the instances for 40 Stewards on every tier;
  - mobile draws fewer pieces.
- `activity/Activities.test.tsx` (3):
  - **the acceptance end to end** (store → `satelliteList` → `useHeldArchetypes` → director actor, fake R3F and fake clock): `Read` → gathering; after the dwell `Bash: pnpm test` → building in under 1 s; a commit waits out building's dwell, then transporting; waiting for input → orbiting at once;
  - `useHeldArchetypes` landing a due switch by timer while the list is unchanged;
  - `writeList` against a real three `InstancedMesh` (position, axis, scale, hidden when empty).
- `satellite-model.test.ts` (+1): the hook (a working Steward gets the archetype; Waykeepers and idle Stewards none).

## Performance

**Method.** Same approach as P4-01, with a throwaway harness that was not committed (a copy is in the agent's scratch folder).

- **Build and browser.** A production `vite build` of a page mounting the real `SolarScene`, served by `vite preview` on 127.0.0.1:6731, in headless Chrome (`--use-angle=metal`, Apple M3 Pro, 1440×900 at DPR 2), driven over CDP.
- **World.** The catalogue's bodies and 10 projects (Mercury, Mars, Jupiter, Saturn, Uranus, Neptune, Venus, Europa, Titan, Io). Each has a working Waykeeper and 4 Stewards: **40 Stewards, 50 satellites**.
- **Modes.**
  - `none`: no live agents;
  - `plain`: all 50 satellites with an unclear activity, so no archetype;
  - `archetypes`: the Stewards cycle `Read` / `Edit` / `Bash: pnpm test` / `Grep`, so gathering, transporting and building on rocky, cloudy and giant bodies.
- **Measuring.** Draw calls were counted by wrapping WebGL2's draw calls, per rAF tick. Each run had 6.5 s of settling (the camera flies at 1.5 s), then a 6 s window. The machine's load average was 5–11 during the runs.

| tier | view | draw calls per frame: none → plain → archetypes | fps vsync: none / plain / archetypes | fps no-vsync (high): none / plain / archetypes |
|---|---|---|---|---|
| high | system | 88 → 90 → **92** | 60 / 60 / 60 | 170 / 164 / 171 |
| high | Jupiter | 43 → 45 → **47** | 60 / 60 / 60 | 161 / 156 / 171 |
| mobile (capped at 30) | system | 72 → 74 → **76** per render (36 / 37 / 38 per 60 Hz tick) | 30 renders/s, steady | — |
| mobile (capped at 30) | Jupiter | 26 → 28 → **30** per render | 30 renders/s, steady | — |

**Reading it:**

- The archetypes cost **exactly 2 draw calls** (the two instanced meshes) on every tier and view, whatever the count, and none when no satellite is in an archetype.
- Instances are bounded by the cap: at most 160 solid + 128 glow on high, 60 + 48 on mobile, at 12 triangles (box) or 8 (octahedron) each, so ≤ 3k triangles.
- 60 fps vsync holds on high, and the mobile cap holds 30.
- No-vsync headroom differences are within run-to-run noise on a loaded machine. The archetype run was faster than `plain` in both views.
- CPU: `build` is allocation-free per frame once warmed up: scratch vectors and preallocated typed arrays.

**Looked at by eye** (headless screenshots, high tier):

- robots on Mars's limb near a Steward's ground track;
- a platform frame above Jupiter under a Steward's satellite;
- green drones around Jupiter and Mercury.

The shuttles are small and were hard to tell apart in stills; they need a look in motion.

## Deferred

- **The work site does not spin with its body.** Planets spin decoratively (40 s per turn) and the anchors carry no rotation, so robots slide slowly over the texture. They wander anyway, so it reads as moving about.
- **No asteroid-specific look.** Asteroids are "surface" and get robots like moons do. At asteroid scale the satellite's size floor makes them relatively large.
- **No archetype in the hover card or the legend.** The hover card keeps the raw activity (decision 70, corner case 32). P4-02's legend could add the three archetypes.
- **The summariser** (TECHNOLOGY §4 item 5) does not exist yet. When it does, its sentences go through `TEXT_RULES` unchanged. If it emits a structured `archetype` field, `classifyActivity` should prefer it.
- **The P4-06 harness** can drive this directly: `director.actor(id)` and `ArchetypeHold.shown(id)`, plus `classifyActivity(...).rule` to explain a choice.

## What Cosmin should look at

1. **The look in motion** (`pnpm dev`, a world with Stewards working; fly to a planet).
   - Are the drones, shuttle, robots and platform readable at the camera's body framing, and too big or too small next to the satellite? Sizes are fractions of the satellite's span (which has a pixel floor) in `ACTIVITY_LOOK`.
   - Colours: green drones, a warm-white shuttle, orange robots, a grey platform, yellow sparks.
2. **The rules table.** Is a single edit "transporting" (producing output) the right call? The alternative is "building" for every edit, which would make building the most common archetype. Is "implementing" (building) or "fixing" (transporting) worth moving? Both are in `TEXT_RULES`.
3. **The hold numbers** (0.4 s confirm, 2 s dwell, 3 s release, 3 files in 90 s) in `HOLD`, `MANY_EDITS` and `EDIT_WINDOW`.
4. **`PLACE_SATELLITES` (−0.5).** This is a new `useFrame` priority for the satellites' director. It runs after the bodies and before the readers, P4-05's beacons included if they read the registry.
