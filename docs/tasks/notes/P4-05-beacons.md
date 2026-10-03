# P4-05: Question beacon

Branch `p4-05-beacons`, cut from `p4-wave2-state-activity-beacons` with P4-02 merged in. Built 2026-10-03.

## What was built

The code is in `apps/web/src/scene/beacons/`. Only `Beacons.tsx` imports three.js. The other files have no three.js imports, and those that picking or the overlay import end up in the panel's first chunk. The build confirms three.js stayed out of that chunk: `WebGLRenderer` and `CanvasTexture` appear only in the `SolarScene` chunk.

| File | What |
| --- | --- |
| `beacon-model.ts` | `beaconList(world)` returns one beacon per body that has at least one question with status `open` held by the user (`holder.type === 'user'`). These are the inbox's "Waiting for you" questions (decision 58). `questionBody` decides the body: a Steward's task body (for a project task, that is the project's planet), a Waykeeper's project body, or the Harmonizer's headquarters (Earth). If those are missing it falls back to the agent's `bodyId`, then to the question's `context.origin` (task, project, body) when the agent is not loaded. A beacon's `kind` is `permission` if any of its questions is a permission, otherwise `clarification`. Each beacon carries the `count` and the question ids in inbox order (permissions first, then clarifications, oldest first). The file also has `beaconFor`, `sameBeacons`, and `beaconCard`, which supplies the hover card's text. |
| `beacon-look.ts` | Layout in screen pixels at the body's depth. The glyph sits 64 px above the body's top edge (`liftPx`), which clears the label sitting right above the body (P3-07). The glyph is 34 px and its click target is 18 px in radius. Close up, the glyph is clamped 22 px below the top of the viewport. The halo pulse uses `PULSE.blink` (1.6 s, P4-02) and is in phase with the blink of a waiting satellite. Under reduced motion it uses `STEADY_PULSE`. `glyphSpec` picks a padlock diamond for a permission and a "?" disc for a clarification, with a badge showing "2"…"9", then "9+". |
| `glyph-draw.ts` | Draws the glyph and the pillar on a 2D canvas at runtime. There are no image assets. |
| `Beacons.tsx` | Draws each beacon as a camera-facing group scaled to world units per pixel. Each has an additive amber pillar, a halo ring and the glyph. No depth test, `renderOrder` 20–22, on `DECOR_LAYER`. Glyph textures are cached per kind and badge. It writes each glyph's world centre to `registry.ts` every frame for picking. It was mounted **after `CameraRig`** (see "Found on the way"); since the wave-2 review the rig runs at `PLACE_CAMERA` (−0.25), so the mount order no longer matters. Off-screen beacons are hidden (`glyphInView`) and every beacon shares one plane and one ring (`BeaconShapes`). |
| `registry.ts` | Holds the live `BeaconFrame`s. `beaconUnder(ray)` returns the glyph whose centre is within 18 px of the pointer on screen, preferring the nearest. `beaconsDrawn()` tells picking whether any beacon is drawn. |
| `activate.ts` | `activateBeacon(bodyId)` opens the body's first question in the inbox and closes any open popover. It does not change the selection and does not fly the camera. |
| `BeaconHoverCard.tsx`, `beacons.css` | The hover card reads "Permission: <text…>" or "Question: <text…>", then the agent asking ("Steward · Wire the login"), then "+n more on Jupiter · click to open in the inbox". It uses the hover position channel, so React does not re-render as the pointer moves. It follows the store: answering the question elsewhere updates or removes the card. The CSS also gives the revealed inbox card an amber outline for 1.6 s. |
| `panel/inbox-reveal.ts` | `revealInbox` moved here from `TopBar.tsx` unchanged; TopBar imports it and re-exports `INBOX_ID`. New `revealQuestion(id)` finds `[data-question-id]` inside `#pnl-inbox` and scrolls it into view (`block: 'nearest'`). It then focuses it with `tabindex="-1"`, so focus does not land on "allow", and adds the highlight. It retries for up to about 30 frames, then falls back to revealing the inbox itself. The inbox is never hidden (decisions 69 and 71), so nothing else needs to be expanded. At ≤ 1100 px the column scrolls with the scene, and `scrollIntoView` handles that too. |

**Picking integration** (`picking/Picking.tsx`, `store.ts`, `PickingOverlay.tsx`; the changes are small):
- The beacon test runs first in both hover and click. A beacon wins over the satellite kept by the hover grace, over satellites, over bodies and over labels, because it is drawn over everything.
- A new `Hover` kind `{ kind: 'beacon', bodyId }` was added (its unused `others` was dropped after the wave-2 review). `hoveredBody` returns the beacon's body, so that body gets the faint hover ring.
- The per-frame repick also runs while beacons are drawn, because beacons ride orbiting bodies.

**Legend** (P4-02's `scene/legend/`): added a "Question beacon" row (an amber "?" swatch: "a pillar above a body: a question waits for you (a padlock: a permission); click it to open it in the inbox").

## Decisions taken here (conservative; please confirm)

1. **The Harmonizer's own questions put a beacon on Earth.** This keeps the rule "every question the user holds lights a beacon somewhere". Earth is where the Harmonizer lives (decision 65: clicking Earth selects it). Without it, a permission request from the Harmonizer would block the user while the scene shows nothing. Earth carries no label (decision 66), so the beacon is the only cue there.
2. **One beacon per body.** It shows the most urgent kind there (permission beats clarification, the inbox's order) plus a count. The alternative was one beacon per question, which would stack several pillars on one body.
3. **Clicking a beacon opens the question and changes nothing else.** There is no selection change and no camera flight. Each card has its own "open agent" link (decision 58). Selecting the asking agent would also move the docked conversation, which would be the surprise the brief warns against.
4. **Beacons are drawn over everything and are never hidden by a body or the Sun.** A body behind the Sun still shows its beacon. A blocked question matters more than occlusion, and labels do hide behind bodies, so the beacon is the cue that always remains.
5. **The beacon is a pillar plus a glyph above the body, never another dot.** Since P4-02, the waiting satellite itself is the amber blinking dot. The halo pulses on the same 1.6 s clock and in phase with it, so the scene has one rhythm for "waiting for you". Under reduced motion everything is steady.

## SPEC decision 74 (recorded)

> **Question beacons** (2026-10-03, P4-05; §2.6, §4.1, decisions 55, 58, 65, 66, 70, 72): every body with a question that waits for the user — open and held by the user, the inbox's "Waiting for you" questions — carries a beacon: an amber light pillar rising from the body with a glyph on top, a padlock diamond for a permission and a "?" disc for a clarification, with a count when several wait there (one beacon per body; a permission shows over a clarification). A question belongs to the body of the agent's work: a Steward's task's body (a project task's is its project's), a Waykeeper's project's body, and Earth for the Harmonizer's own. The beacon appears as soon as a question reaches the user (asked of them or escalated to them) and goes out as soon as it is answered, withdrawn or passed back to an agent. It keeps the same size on screen at every zoom, is never hidden by a body, and pulses with the waiting satellites' blink (steady with reduced motion). Hovering it shows the question ("Permission: …" / "Question: …"), who asks and how many more wait there; clicking it scrolls the inbox to that question and highlights it, without changing the selection or moving the camera. A beacon under the pointer wins over the satellites, the body and the label under it.

TECHNOLOGY §2.1: a "Question beacons" bullet was added after the Satellites bullet, in this branch.

## Found on the way

- **Frame order.** Callbacks of one `useFrame` priority run in mount order. With `<Beacons />` mounted before `<CameraRig />`, the frame where the rig first placed the camera laid the beacons out using the old camera pose. On the phone tier with reduced motion (an on-demand loop, so no later frame), they stayed off screen until something invalidated. Fixed by mounting after the rig. Satellites are mounted before the rig, so their pixel sizes may also lag one frame. That is negligible for them, but anything else laid out in camera pixels should be mounted after the rig. Wave-2 review: the camera rig now runs at `PLACE_CAMERA` (−0.25), between the satellites (−0.5) and the readers (0), documented in `frame-order.ts`, so no reader depends on its mount order (tested in `frame-order.test.tsx` with a reader mounted before the rig).

## Tests (Vitest, no WebGL)

- `beacon-model.test.ts` (11): which body (asteroid Steward, project-task Steward → planet, Waykeeper, Harmonizer → Earth, moved task, origin fallback, unknown → none); user-held and open only; one beacon per body with the permission kind, the count and the inbox order; **lifecycle through the client reducer**: opened and held by an agent (none) → escalated to the user (on) → a permission on the same body (kind changes, count 2) → answered → reassigned away (off) → opened → cancelled (off); `sameBeacons`; `beaconCard` (text, asker, "+n", one line).
- `beacon-look.test.ts` (11): the lift and the top clamp; pulse animation and periodicity; **in step with the satellite blink** (same period, both peak and bottom out together); **steady under reduced motion**; glyph spec per kind and badge; the glyph and pillar drawing against a recording 2D context; `beaconUnder` (hit, nearest, outside the target, hidden, behind the camera).
- `Beacons.test.tsx` (6, R3F mocked): a group per beacon with the right glyph (also under StrictMode); placement above the anchor at screen size and hidden without an anchor; hidden behind the camera; **reduced motion keeps the halo steady over time, motion pulses it**; lifecycle (an answer and an escalation re-render the set and invalidate); nothing published after unmount.
- `beacons-ui.test.tsx` (6, jsdom): **click → inbox reveal** (the permission card is focused, scrolled into view and highlighted, then the highlight clears; the selection is unchanged; the popover closes); no beacon → nothing; waits for the inbox, then falls back to the inbox; a card mounted a frame later is found; the hover card's content; the card follows answers made elsewhere and disappears.
- `Picking.test.tsx` (+2): a beacon wins over the moon under it on hover; a click on a beacon reveals the question, selects nothing and flies nowhere.
- `Legend.test.tsx`: asserts the beacon row.
- Gates from the repo root, after merging P4-02: build, typecheck, lint, format:check and test all green. protocol 67, server 845 (+1 skipped), web 912 after merging P4-03 too (36 new for P4-05).

### Smoke check in a real browser (throwaway harness, deleted, not committed)

The harness used Vite on port 6847 and headless Chrome (SwiftShader) on CDP port 9347. It showed the catalogue's planets, Jupiter hosting a project with a Waykeeper and a project-task Steward, and an asteroid task. It had three open user-held questions: a permission and a clarification on Jupiter, and a clarification on the asteroid.
- **Look at the system view:** high tier at 1280 px, mobile tier at 700 px, and reduced motion. The "?" pillar shows over the asteroid and the padlock diamond with a "2" badge over Jupiter. Both sit above their "blocked on you" labels without overlapping them.
- **Hover:** hovering Jupiter's glyph showed "Permission: May I run rm -rf build…", "Steward · Wire the login" and "+1 more on Jupiter · click to open in the inbox". Jupiter got the faint ring.
- **Click:** focus went to the inbox card `q-1`, which scrolled into view with an amber ring. The selection stayed `harmonizer` and no camera flight was requested.
- **Lifecycle:** after answering the permission, Jupiter showed a clarification beacon. After answering the clarification, Jupiter's beacon was gone, within the next render. Opening a Harmonizer permission lit Earth.
- **Close-up of Jupiter:** the beacon stays above the label and keeps its size.
- **Console:** no errors from the beacons.

This check found the frame-order bug above (the mobile tier with reduced motion showed no beacons until the first interaction). It also found two smaller problems, both fixed: the hover card was clipped to one line by `.pick-hover`'s `nowrap`, and the badge was too small.

## Performance

- Each beacon on screen costs 3 draw calls, all on `DECOR_LAYER`, so the outline depth pass skips them. With 2 beacons that is +6 draws; a beacon off screen costs none (wave-2 review: `glyphInView` hides it). Instancing all of them into 3 draw calls (a glyph atlas with a per-instance UV offset) was weighed and left out — a handful of beacons at most, against a custom shader and the per-beacon render order. The per-frame work is a projection and a few vector operations per beacon, with no allocations: the scratch vectors, the layout and the pulse are module-level scratch objects (`beaconLayout` and `beaconPulse` write into them) and the frames are reused.
- **Wave-2 review: status flushes.** The first cut's list depended on the status records (only to find the current Harmonizer for headquarters), so it was rebuilt, republished and re-rendered on every status flush (≈ 10 a second), and the rebuilt frames started hidden, so the hover flickered. Now `useBeaconList` reads the questions, the work rows, the bodies and `beaconHq` (a string), keeps the previous list while `sameBeacons`, and `carryFrames` carries `visible`, `center` and `perPx` over by body; the hover card selects the same fields instead of the whole world. Tested: a status flush neither republishes nor re-renders the beacons or the card; a rebuilt list keeps a beacon's placement.
- Picking adds one `beaconUnder` pass, O(beacons), before the existing picks. While beacons are drawn the hover is re-picked each frame. That is already the case whenever any satellite is drawn.
- Textures: one 128² canvas per kind and badge actually shown, plus one 16×128 pillar.
- Reduced motion: no pulse, and nothing asks for frames. The on-demand loop renders only on changes (a list change or an anchor change invalidates).
- No fps measurement: headless SwiftShader numbers are meaningless. Nothing here scales with anything but the number of bodies with waiting questions.

## Deferred

- **Keyboard:** a beacon is not a keyboard target. The keyboard path is the top bar's "N waiting" button and the inbox itself. `Enter` on a focused body still selects its agent.
- **Touch:** a tap on the glyph (36 px target) opens the question. There is no hover on touch. Not tried on a real phone.
- **Beacon under the legend:** the legend (top-right, P4-02) takes pointer events, so a beacon drawn under it cannot be hovered or clicked until the legend is collapsed. The hover card draws above the legend (`--scene-z-hover` 30 > chrome 20), so it is never hidden by it.
- **Many beacons:** there is no de-clutter between beacons of nearby bodies. At the system view, Earth's and an inner asteroid's beacons can overlap, and the click goes to the glyph nearest the pointer. If this becomes common, offset or merge them like labels.
- The bloom and ACES tone mapping dim the amber a little against the DOM label pill. That is acceptable, but Cosmin may want it brighter.

## Shared files touched

- `apps/web/src/scene/SolarScene.tsx`: one import and `<Beacons />` mounted right after `<CameraRig />`, with a comment. (After merging P4-03: the order is Satellites, Activities, CameraRig, Beacons, Picking; beacons run at the default frame priority 0, after bodies (−1) and satellites (`PLACE_SATELLITES`, −0.5).)
- `apps/web/src/scene/picking/Picking.tsx`: `aim()` was factored out of `pick()`. The beacon check is first in `hoverNow` and in `onUp` (`at` is computed earlier there). The repick condition gained `beaconsDrawn()`, plus one doc paragraph.
- `apps/web/src/scene/picking/store.ts`: the `BeaconHover` type, a `sameHover` branch and a `hoveredBody` doc.
- `apps/web/src/scene/picking/PickingOverlay.tsx`: renders `BeaconHoverCard`.
- `apps/web/src/scene/picking/Picking.test.tsx`: 2 tests.
- `apps/web/src/panel/TopBar.tsx`: `revealInbox` and `INBOX_ID` moved to `panel/inbox-reveal.ts`, now imported and re-exported.
- `apps/web/src/panel/cards/QuestionCard.tsx`: `data-question-id={q.id}` on the card.
- `apps/web/src/scene/legend/Legend.tsx`, `legend.css`, `Legend.test.tsx`: the beacon row.
- `docs/TECHNOLOGY.md` §2.1: the bullet. A merge conflict with P4-02's bullet was resolved by keeping both.
- Not touched: the phase file, `docs/tasks/README.md`, `SPEC.md`.

## What Cosmin should look at

1. Run `pnpm dev` with a Steward blocked on a permission, for example in a project with `ask` for Bash. The padlock beacon rises over the project's planet, and the satellite blinks amber in the same rhythm as the halo.
2. Hover the glyph to read the card, then click it. The inbox scrolls to that card with an amber ring, and the conversation and the camera stay put.
3. Answer the question in the inbox. The beacon goes out at once. Escalate a clarification, by asking a Steward something its Waykeeper can't answer, and watch it light up.
4. Decide on the Earth beacon for the Harmonizer's own questions, and on "never hidden by a body".
5. Turn on reduced motion in the system settings. The beacon stays and is steady.
