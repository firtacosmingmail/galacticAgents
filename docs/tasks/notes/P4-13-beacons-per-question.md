# P4-13: A beacon per question, clicking it goes to the asker; no made-up planets

Branch `p4-13-beacons`, cut from `p4-wave2-state-activity-beacons`. Built 2026-10-04.

Cosmin's answers on P4-05's open choices: the Harmonizer's own questions put a beacon on Earth (kept as it was); one beacon per **question**, not per body; clicking a beacon selects the asking agent and flies the camera to it, as well as opening the question in the inbox. He also asked that bodies outside the catalogue (the early dev buttons' "Demo planet n") stop being drawn once nothing is on them.

## What was built

### One beacon per question (`apps/web/src/scene/beacons/`)

| File | Change |
| --- | --- |
| `beacon-model.ts` | `beaconList(world)` returns one `BeaconSpec { questionId, bodyId, kind, slot, slots, more }` per open user-held question, keyed by the question id. The body rule (`questionBody`) is unchanged. Bodies are listed in id order. On each body the beacons are in the inbox's order (permissions first, then clarifications, each oldest first), and that order gives each one its `slot` in the body's row. `beaconFor` and `beaconCard` now take a question id, and `sameBeacons` compares question, body, kind and place. |
| `beacon-look.ts` | `BEACON.spacingPx = 40`. `rowOffsetPx(slot, slots)` centres the row above the body. `beaconLayout(…, slot, slots)` adds `glyphX`, and `glyphInView` takes it into account. `glyphSpec(kind, more)` gives a "+n" badge (capped at "+99") instead of the count. |
| `Beacons.tsx` | A beacon is keyed and named by its question (`beacon:<questionId>`). The glyph and halo sit at `(glyphX, glyphY)`. The pillar runs from the body's top on its vertical to under the glyph, slanted (`rotation.z = −atan2(glyphX, rise)`, length `hypot`), so the pillars of one body **fan out**. For a single beacon nothing changes: the pillar stays straight up. The glyph's world centre for picking adds screen-right × `glyphX`. `carryFrames` carries a placement over by question id. |
| `registry.ts` | `BeaconFrame` gains `questionId` (with `bodyId`). `placeBeacon(questionId, …)` writes it, and `beaconUnder(ray)` returns the hit frame instead of a body id. |
| `activate.ts` | `activateBeacon(questionId)` (see "Click" below). |
| `BeaconHoverCard.tsx` | Takes `questionId` and shows **that** question only: its kind and text, who asks, "+n more on Jupiter" only on the last beacon of a full row, and the hint "click to go there and open it in the inbox". |
| `glyph-draw.ts` | A smaller font for a three-character badge ("+12"). |

**The row.** Several beacons on one body stand side by side at the same height, 40 px between centres. The task suggested 28 px, but the glyph is 34 px wide and the click target 36 px across, so at 28 px the glyphs would overlap and one target would cover part of its neighbour. 40 px keeps each beacon its own target with a 4 px gap. The order is the inbox's (permissions first, then oldest first), so the leftmost beacon is the one the inbox lists first. The same questions always give the same places, so positions are stable from frame to frame and when the list is rebuilt. When a question is answered, its beacon goes out and the others close up the row, re-centred.

**The cap: decided as 6.** At most `MAX_BEACONS_PER_BODY = 6` beacons stand on one body, a row 240 px wide. Past that, the sixth carries a "+n" badge for the questions without a beacon of their own (the inbox lists them after it), and its hover card says "+n more on <body>". Clicking it opens its own question. Below the cap no beacon has a badge, so the old count badge is gone.

**Picking.** `Hover` gains `questionId` (`{ kind: 'beacon', questionId, bodyId }`), and `sameHover` compares it. The body still gets the faint hover ring. A beacon still wins over satellites, bodies and labels (`Picking.tsx`). Only the hover and click call sites changed.

### Click: go to the asker

`activateBeacon(questionId)`:
1. closes any open popover;
2. does nothing more if the question no longer waits for the user (answered or reassigned between the hover and the click) or is unknown;
3. **flies the camera to the beacon's body** (`useCameraStore.flyTo(questionBody(…))`): the task's or project's body, or Earth for the Harmonizer. This is the same body the beacon stands on;
4. **selects the asker** with the satellites' mapping (`satelliteSelection`: `waykeeper:<id>`, `steward:<id>`, or `harmonizer` for the Harmonizer's own questions), through `selectFromScene`, so the panel → scene sync does not fly a second time. A selection change also brings the panel's main route back. When the asker is not loaded (the question was placed by its recorded origin), the selection stays where it is, the camera still flies, and the route goes back to the panel's main view if needed;
5. **opens the question in the inbox** with `revealQuestion(questionId)`, unchanged. Once P4-12 lands, `revealQuestion` also brings a hidden inbox back.

The legend's beacon row now reads: "a pillar above a body: a question waits for you, one per question (a padlock: a permission); click it to go to the agent asking and open it in the inbox".

### No made-up planets (`apps/web/src/scene/bodies/layout.ts`)

`buildRenderList` now draws a planet or moon outside the catalogue only while something is on it:
- `inCatalogue(body)`: the body has a usable `meta.orbit` (migration 0005 gives one to every catalogue planet and moon; `/dev/seed`'s "Demo planet n" has none);
- `occupied(body)`: it hosts work or shows a "moved to …" marker;
- `drawn(body, moons)`: in the catalogue, or occupied, or a made-up planet with a drawn moon (otherwise the moon would have nowhere to go).

The render list is the only source of the planet and moon anchors (`anchorSpecs`), so a free made-up body has no anchor. That means no pick sphere, no place in the camera's next/previous order, no `flyTo`, no satellite or beacon placement. It also has no label, because labels show only on hosted or "moved to" bodies and need an anchor anyway. A hosted Demo planet is drawn as before, past Neptune with the default look. Once it is freed it disappears; if work lands on it again, it comes back. Catalogue bodies are always drawn, free or not. The server and the navigation are untouched: P4-12 covers removing closed demo projects from the navigation.

## SPEC text (recorded: decision 74 rewritten, decision 63 amended)

**Amend decision 74 (Question beacons)**. Replace "with a count when several wait there (one beacon per body; a permission shows over a clarification)" and the clicking sentence, so that it reads:

> **Question beacons** (2026-10-03, P4-05; amended 2026-10-04, P4-13; §2.6, §4.1, decisions 53, 55, 58, 65, 66, 70, 72): every question that waits for the user — open and held by the user, the inbox's "Waiting for you" questions — carries its own beacon above the body of the agent's work: an amber light pillar rising from the body with a glyph on top, a padlock diamond for a permission and a "?" disc for a clarification. A question belongs to the body of the agent's work: a Steward's task's body (a project task's is its project's), a Waykeeper's project's body, and Earth for the Harmonizer's own. Several questions on one body stand side by side in a row above it, in the inbox's order (permissions first, then the oldest), their pillars fanning out from the body; past six, the last carries "+n" for the rest. Each beacon appears as soon as its question reaches the user (asked of them or escalated to them) and goes out as soon as that question is answered, withdrawn or passed back to an agent; the others on the body close up. It keeps the same size on screen at every zoom, is never hidden by a body, and pulses with the waiting satellites' blink (steady with reduced motion). Hovering a beacon shows its question ("Permission: …" / "Question: …") and who asks; clicking it selects the agent asking (its Waykeeper or Steward, or the Harmonizer for its own), flies the camera to its body, and scrolls the inbox to that question and highlights it. A beacon under the pointer wins over the satellites, the body and the label under it. On narrow screens, where the scene, navigation and side column share one scrolling column, opening the question scrolls the scene out of view.

**Amend decision 63 (Scene scale and motion)**. After "Only asteroids hosting a task are drawn and labelled individually; a freed asteroid, or one whose task moved away, is just part of the belt (P3-03).", add:

> The scene draws the catalogue's planets and moons always; a planet or moon that is not in the catalogue (one made by the early development tools, such as "Demo planet 1") is drawn only while it hosts work or shows a "moved to …" marker, and disappears once it is free (P4-13).

## Tests (Vitest, no WebGL)

- `beacon-model.test.ts` (14): the body rules, unchanged; **one beacon per question in a row, in the inbox's order** (slots 0–2 of 3 on Jupiter); **two questions on one body → two beacons with distinct, stable places**, the same from questions given in reverse; **past six, the last carries "+3"** and a question with no beacon of its own has no card; **lifecycle through the client reducer, per question**: escalated (on, 0/1) → a permission on the same body (2 beacons, the permission first) → **answering it puts out only it** (the clarification back to 0/1) → reassigned away (off) → opened and cancelled; `sameBeacons` (also compares `slots`); `beaconCard` per question (that question only, `more` 0).
- `beacon-look.test.ts` (+4, 18 in all): a lone beacon at x 0; a row centred, `spacingPx` apart and at the same height (`spacingPx` > target diameter and glyph); a row beacon off screen hidden while its neighbour is drawn; `beaconUnder` hits each beacon of a row on its own and the gap between them hits neither; the "+n" badge drawn and capped at "+99".
- `Beacons.test.tsx` (+1, 11 in all): **two questions on one body**: two groups (`beacon:q-1`, `beacon:q-2`) with their own glyphs and no badge, placed ±20 px from the centre line at the same height; **the pillars lean towards their own glyphs** (the fan); the same places on the next frame; **answering one leaves only the other, re-centred over the body**. The lifecycle test now ends with a row of two on the asteroid.
- `beacons-ui.test.tsx` (9): **click → selection + `flyTo` + `revealQuestion`**: the clarification second in Jupiter's row selects `steward:a-st-in`, flies to `b-jupiter`, and focuses, scrolls and highlights its own card, not the body's first; the Harmonizer's question selects `harmonizer` and flies to `b-earth`; an asker not loaded leaves the selection, flies to the origin's body; a question that no longer waits (or an unknown one) does nothing; the hover card shows that question only; answering another question leaves the card, answering its own removes it.
- `Picking.test.tsx` (3 replacing 2): each beacon of a row is its own hover target (`{ kind: 'beacon', questionId, bodyId }`) over the moon under it; **a click selects the asker, requests a focus flight to its body and focuses its card** (Waykeeper, then Steward); the Harmonizer's beacon on Earth → `harmonizer` and a flight to `b-earth`.
- `bodies-model.test.ts` (+3): a world with "Demo planet" bodies: **a free one is not in the render list**; one hosting a project, one with a "moved to" marker, and a free one with a hosted made-up moon are drawn; a free made-up moon on Mars is not; none of the undrawn have an anchor (`anchorSpecs`) while every catalogue planet and moon has one; freeing a demo planet removes it and hosting one brings it back.

Gates from the repo root: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check` and `pnpm test` all green: protocol 67, server 846 (+1 skipped), web 948. After the build, three.js (`WebGLRenderer`, `CanvasTexture`) still appears only in the `SolarScene` chunk, not in the panel's `index` chunk.

No browser check was run (it was optional). The row and fan geometry are covered by the `Beacons.test.tsx` placement and pillar-lean assertions.

## Shared files touched

- `apps/web/src/scene/picking/Picking.tsx`: the beacon hover carries `questionId` and the click calls `activateBeacon(questionId)`, plus the doc paragraph.
- `apps/web/src/scene/picking/store.ts`: `BeaconHover.questionId`, `sameHover`.
- `apps/web/src/scene/picking/PickingOverlay.tsx`: `<BeaconHoverCard questionId=…>`.
- `apps/web/src/scene/picking/Picking.test.tsx`: the beacon block.
- `apps/web/src/scene/legend/Legend.tsx`: the beacon row's hint.
- `apps/web/src/scene/bodies/layout.ts`, `bodies-model.test.ts`.
- `docs/TECHNOLOGY.md` §2.1: the "Bodies and scale" and "Question beacons" bullets.
- `docs/tasks/notes/P4-05-beacons.md`: the activate row, decisions 2 and 3, and "what to look at" now point to P4-13.
- Not touched: `apps/web/src/panel/` (P4-12's), the phase file, `docs/tasks/README.md`, `SPEC.md`.

## What Cosmin should look at

1. Two questions on one planet (for example a Steward's permission and its Waykeeper's clarification): two beacons side by side, padlock on the left, with pillars fanning out from the planet.
2. Hover each one: each card names its own question and asker. Click the right one: the Waykeeper is selected, the camera flies to the planet, and the inbox opens that card.
3. Answer one in the inbox: only its beacon goes out, and the other moves back to the centre.
4. A Harmonizer question: the beacon on Earth; clicking it goes back to the Harmonizer and flies to Earth.
5. A leftover "Demo planet": it is gone from the scene while free and still drawn while it hosts a project. Close or archive the project in the navigation (P4-12); once its body is freed, it disappears.
6. Decide the cap of 6 and the 40 px spacing.
