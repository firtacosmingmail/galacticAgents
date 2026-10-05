# P6-06 and P6-07: Earth's detail view (HQ in view, stray objects, shadow, framing)

Branch `p6-06-07-detail-view`, made from `p6-wave3-overlay-hq-view`, 2026-10-05. The technical summary is in `TECHNOLOGY.md` §2.1, in three places: the "Planet detail view" bullet (framing and fading decorations), the "Earth as headquarters" bullet (viewing slot) and the "High-detail visuals" bullet (moon shadows). Nothing here touches `detail/parts.ts` or anything of P6-04's overlay.

## P6-07: root causes (checked in the browser, not guessed)

Setup: headless Chrome with Earth's detail view settled. I listed every visible mesh outside the sub-scene (`scene.traverseVisible`) and then hid candidates one at a time by setting `material.visible = false`, because the per-frame loops reset `object.visible`. Screenshots: `before-sq-earth-detail.png`, then `before-sq-no-highlight.png`, then `before-sq-no-highlight-no-belt.png`.

| Artefact | What draws it | Why |
|---|---|---|
| Thick light-blue band outside the atmosphere | **The selection highlight ring** (`picking/Picking.tsx` `HighlightRing`, `#7fb2ff`, opacity 0.9). The Harmonizer selection selects Earth (decision 65). | The ring faces the camera at the body's centre, at ≈ 1.15 R, and is drawn over everything. Up close it reads as a band just outside the limb. P6-01 filtered rings only for bodies *out of* scope; the shown body is in scope. Hiding it removed the band. |
| Belt rocks around Earth | **`belt-rocks`** (the background instanced mesh). | The backdrop dome is at least `BACKDROP_MIN_RADII` = 40 framed radii. For Earth in the readable layout that is 68 units around a planet at 33 units, and the belt starts at 51.6 units. So the belt is *inside* the dome, and P6-01's rule correctly keeps drawing it (`shellOutsideDome` is false). Hiding it removed the rocks. |
| Faint straight lines across the view (seen in the listing) | Neighbours' **Sun-centred orbit lines** (Mercury, Venus, Mars). | Same cause: the lines pass inside the dome. |
| Large dark disc on the surface and clouds | **The Moon's eclipse shadow** (P3-10 eclipse patch; the detail view's planet receiver had the Moon as caster). | The readable layout puts the Moon 2.2 Earth radii out instead of 60. The shadow is about as large as the Moon itself (penumbra capped at 0.25 r), so seen obliquely it covers about a third of the disc. |
| Earth overfills a square canvas | `DETAIL_FRAME_RADII` = 2.4. | From 2.4 R the disc subtends asin(1/2.4) = 24.6°, but the vertical half field is 22.5°. |

Also inside Earth's dome: the planet meshes of Mercury and Venus (44–48 units away). They did not show in any frame I checked. They are left as they are; see "Left undone".

## P6-07: fixes

- **Decorations fade with the cross-fade** (`detail/dome.ts`). They do not pop, and the system view is unchanged:
  - `orbitLineFactor(own, mix, aboutSun)`: every Sun-centred orbit line fades out in any detail view. Moon lines are unchanged, since they belong to the planet's system.
  - `ownRingFactor`: the hover and selection rings around the *shown* body fade out. Rings around its moons and satellites stay.
  - `beltFactor`, applied through `useBeltFade` (`dome-binding.ts`): in a planet's or moon's view, the background rocks and the other task asteroids are dimmed to the backdrop's black (material colour, emissive and halo opacity scaled by 1 − mix). They are then not drawn at all (`material.visible = false`, which never fights the culling hook's `object.visible`). An asteroid's view keeps them, because it lives in the belt. Dimming to black was chosen over making the materials transparent: toggling `transparent` changes three's `OPAQUE` define and recompiles the program.
- **Moon shadow: turned off in the detail view**, the smaller of the two changes. `detailEclipseReceivers(planet)` empties the planet's own casters, so a planet's moons cast no shadow on its surface or clouds in its detail view. The planet still shades its moons and its rings, and the system view keeps the moons' shadows. "True proportions" would not have helped Earth: the readable Moon is already true-sized relative to Earth (0.265 against 0.273). What is wrong is its distance. A true-geometry shadow would have meant new shader inputs. This is recorded in **SPEC decision 87** (one sentence appended). Side effect: Jupiter's Io and Ganymede spots no longer show *in Jupiter's detail view* (they still do in the system view).
- **Framing**: `DETAIL_FRAME_RADII` 2.4 → **2.85**, with `DETAIL_DISC_REACH` = 1.08 R (the disc plus the widest glow; Titan's haze is 1.08). With the camera's 45° vertical field, the vertical half field is the narrower one at any aspect ≥ 1, so one distance fits every aspect from 1:1 to 2.2:1: asin(1.08/2.85) = 22.3° < 22.5°. It is still inside `ENTER_RADII` (3), so a landed flight is well within the view's thresholds. `EXIT_RADII` (4.5) is 1.65 radii away, so the P6-01 B1 blocker (a framing past the exit) cannot recur. B1's test (every catalogue body, both scales, portrait) still lands and stays. Portrait canvases (< 1:1) still overfill sideways: fitting them would need more than 3 radii.

## P6-06: design (the simplest option that meets the acceptance)

Options considered, from the task:
1. **Frame Earth wider.** To fit the 1.8 R orbit plus the station in a square canvas the camera would need about 5.2 R, which is past `EXIT_RADII`. Not possible without moving the thresholds.
2. **Turn the camera toward the station on an HQ click.** This does not make it "visible most of the time".
3. **A camera-facing slot in the detail view only.** Chosen, because it is the only option that meets the acceptance.

**Measured baseline**, after the P6-07 framing and before this change: one 40 s sample (one full orbit at 4 Hz), counting the station's centre on screen and not behind Earth. In a square canvas (1.07:1) it was visible 9 % of the time; in a 2.1:1 canvas, 57 %.

**The slot** (`detail/earth-hq/hq-slot.ts`, three-free):
- Where: on the line of sight through the canvas point NDC (0.7, 0.55), right of and above centre and clear of the Legend button.
  - In wide canvases, at the depth of Earth's centre, so the station floats beside the globe at its normal size.
  - In narrow canvases, where that point would be closer than 1.35 R to Earth's centre (glow 1.035 + half the station 0.21 + a gap), the slot moves nearer the camera, to where the line of sight first comes within 1.35 R. The station then floats in front of the upper-right limb.
  - Its size is scaled to what it would look like at Earth's depth (factor ≤ 1; ≈ 0.58 in a square canvas), so it never looms over the globe.
  - If the camera is closer than about 2.2 R, so that the point would be less than 0.9 R in front of it, there is no slot and the station keeps its orbit.
- **Applied to the Harmonizer's satellite frame itself** (position and size). `overrideHqPose` / `applyHqPose` live in `satellites/hq/hq-model.ts`, and `Satellites.tsx` calls `applyHqPose` right after `director.update`, before `writeHq` and every reader. So picking, the hover card and ring, **the click (select the Harmonizer and open its chat)** and the beam's apex all follow, with no second pick target. The dark resting station (no Harmonizer running) takes the same slot (`restInSlot`).
- **Motion**:
  - The station swings from its orbit to the slot with the cross-fade, and back when leaving.
  - It follows the slot with a 0.35 s lag, so after the user turns the view it drifts back into place rather than looking pasted on. Under reduced motion it snaps.
  - Both moves use `swing` (a great-circle turn plus a linear change of height about Earth's centre), so it never passes through the globe. My first version used straight lerps and dipped to 0.89 R, inside Earth, while leaving; caught in the browser.
  - While the view fades out the slot is no longer followed, because the camera is flying away.
- The camera it reads is the previous frame's (the director runs before the camera rig, `frame-order.ts`). The lag hides this; under reduced motion it is one frame late during a drag.

**After** (20 s samples): visible **100 %** of samples at 1.07:1, 1.7:1 and 2.1:1. The span-to-distance ratio is 0.138 at 1.07:1, 0.131 at 1.7:1 and 0.124 at 2.1:1, about the same everywhere. Through the full enter and exit the distance from Earth's centre stayed ≥ 1.40 R. **The click works**: hovering the station showed the "Harmonizer · idle" card and the ring; clicking selected the Harmonizer, restored the minimised dock on Chat, and stayed in the detail view.

### SPEC decision 89 (added to §7 at the wave's merge; the original proposal below)

> **Decision 89 — The HQ in Earth's detail view** (2026-10-05, P6-06; decisions 84, 85): in Earth's detail view the HQ station leaves its orbit and holds a place in view, up and to the right of Earth: beside the globe in a wide view, in front of its limb in a narrow one, at the size it would have beside Earth. It flies there as the view opens and back to its orbit as it closes, and when the user turns the view it drifts back to its place after a moment (at once with reduced motion). Hovering and clicking it work as everywhere: a click selects the Harmonizer and opens its chat. With no Harmonizer running, the dark station rests in the same place. Zoomed in very close to Earth, the station keeps its orbit.

Decision 85 could gain a pointer: "(where it stays in view: decision 89)".

## Tests (Vitest)

Web suite: 110 test files, 1454 tests (1433 before; 21 new tests and 2 new files, details below). Gates on the branch: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, all green (protocol 70, server 976 + 1 skipped, web 1454).

- `detail/mode.test.ts`: the framing fits disc and glow at aspects 1, 1.07, 4:3, 16:9, 2 and 2.2, and the old 2.4 did not; it stays inside `ENTER_RADII` and more than 1.5 radii from `EXIT_RADII`.
- `detail/dome.test.ts` (4):
  - Sun-centred lines fade out; moon lines do not.
  - The own ring fades out; other rings do not.
  - The belt factor per view kind.
  - A geometry regression that documents the root cause: Earth's dome in the readable layout holds the belt and Mars's orbit.
- `detail/detail-body.test.ts`: `detailEclipseReceivers` drops only the planet's casters, for every catalogue planet. The system keeps the Moon's shadow on Earth, Earth still shades the Moon, and Saturn still shades its rings.
- `detail/belt-fade.test.tsx` (new, 2): `useBeltFade` with a mocked frame loop. The belt fades to 0 through a planet's fade in and back through the fade out, stays at 1 in an asteroid's view, and goes to 0 in a moon's.
- `picking/Picking.test.tsx`: the selected body's ring is at 0.9 → 0.45 half-way through the fade → hidden, and comes back on the fade out; a hovered moon's ring is unaffected.
- `detail/earth-hq/hq-slot.test.ts` (new, 10):
  - At every aspect from 1:1 to 2.2:1 the slot is at its pixel, clear of Earth, not hidden by it, and the station's whole span is inside the canvas.
  - Wide: size factor 1. Square: the factor is between 0.4 and 0.7, at exactly the clearance.
  - No slot when too close.
  - It holds the slot for every orbit angle.
  - Cross-fade blend and lag (≈ 63 % after one follow time), and snapping under reduced motion.
  - `swing` keeps its height linear and never dips below the shorter radius.
  - Enter and exit stay clear of Earth with the orbit on the far side.
  - The override moves only the Harmonizer's drawn frame, while installed, and a stale removal does not remove a newer override.
- `detail/earth-hq/earth-hq-ui.test.tsx`: the mounted part moves a Harmonizer frame into the slot (position and size) and stops after unmounting.
- `detail/earth-hq/earth-hq.test.ts`: the resting station takes a given slot place and size factor.

## Browser check

Own processes only, all stopped afterwards; Cosmin's 5173/4321 were not touched. The dev server (`GALACTIC_DEV=1 GALACTIC_HARMONIZER=fake`, `GALACTIC_HOME` in scratch) ran on 127.0.0.1:7793, Vite on 7713, and headless Chrome (`--use-angle=metal`, M3 Pro) on CDP 9483 with a scratch profile, at DPR 2. Vite was restarted after each code change: HMR gives the app `mode.ts?t=…` while the driver's dynamic import gets `mode.ts`, two store instances, and the view never settled.

Screenshots are in `…/scratchpad/shots-p606/`:

| File | What it shows |
|---|---|
| `before-sq-earth-detail.png` | Before (2.4 framing, square canvas): Earth overfills the canvas, belt rocks at the top corners, light-blue band at the limb. |
| `before-sq-no-highlight.png` / `before-sq-no-highlight-no-belt.png` | Diagnosis: the band goes with the highlight ring's material, the rocks with `belt-rocks`. |
| `p607-after-sq-earth-detail.png` | After P6-07 (square): the whole disc with its glow and a margin, no band, no rocks, no stray lines. |
| `p607-after-wide-earth-detail.png` | After P6-07 (2.1:1): disc, Moon and the station on its orbit; nothing stray. |
| `p606-before-sq.png` / `p606-before-wide.png` | P6-07 framing, station on its orbit (9 % / 57 % visible). |
| `p606-after-sq.png`, `p606-after-17.png`, `p606-after-wide.png` | After P6-06 at 1.07:1, 1.7:1 and 2.1:1: the station in its slot, in front of the upper-right limb (square) or beside the globe (wider), whole, not clipped. |
| `p606-hover.png` | Hovering the station: the Harmonizer's card and ring. |
| `p606-after-click.png` | After the click: the Harmonizer selected, the dock restored on Chat, still in Earth's detail view. |
| `p606-after-exit.png` | Back in the system view: the station on its orbit. |

The Moon's shadow could not be caught on camera, because the Moon was not between the Sun and Earth during the check. Its removal is covered by the receiver test: Earth's receiver has no casters in the detail view.

## Left undone / for later

- **Neighbour planets inside the dome** (Mercury and Venus for Earth in the readable layout) are still drawn. They are small discs and were not seen in any frame. Fading them would need a per-planet material fade like the belt's. A follow-up if they show.
- **Portrait canvases** (< 1:1) still overfill sideways; they cannot be fitted below `ENTER_RADII`.
- **Jupiter's moon spots** are gone in Jupiter's detail view (see the moon shadow fix). If wanted back, a "true geometry" shadow (umbra = r − d·α☉ with the true distance) could replace the off switch.
- With **reduced motion** the slot snaps each frame from the previous frame's camera, so it is one frame late during a drag. Not visible at 60 fps.
- The slot's NDC (0.7, 0.55) is a constant. If P6-04's overlay places markers there, the two may overlap. Worth a look when merging.

## Review fixes (2026-10-05, branch `p6-wave3-review-fixes`)

- **P6-06 — the Moon could overlap the station at wide aspects.** In the readable layout the Moon orbits at 2.21 R with radius 0.26 R, so it comes no nearer Earth's centre than 1.94 R; the slot at Earth's depth was ≈ 1.78 R from it at 2:1 and ≈ 1.93 R at 2.2:1, and the station's half-span is 0.21 R. `HQ_SLOT.maxReach` = 1.7 R: when the slot at Earth's depth would be farther, `hqSlot` pulls its x in (its height kept; exact in one step for the detail camera, which looks at Earth's centre, iterated up to four times otherwise). From about 2:1 up the station sits a little nearer the globe than NDC 0.7. Test: aspects 1:1 to 3.2:1, the slot within the reach and the station's span inside the Moon's inner edge, computed from the layout (`moonDistance`, `moonLook`, `planetLook`), so a layout change that breaks the clearance fails the test.
- **P6-06 — per-frame allocations.** `hqSlot` writes its line of sight into a module scratch tuple, `swing` works in scalars, `HqSlotter` keeps scratch tuples for the orbit and goal offsets, `slotCamera` uses a module function instead of a closure, and `restInSlot` passes scratch tuples.
- **P6-07 — `useBeltFade`** worked out the shown body's kind (a world lookup and `planetLook`) in every caller, i.e. once per task asteroid per frame. `beltFactorNow` caches it until the shown body or the world's bodies change. Test: three callers get the same factor; a change of the bodies is seen.
- **Docs:** `hq-slot.ts`, `EarthHq.tsx` and TECHNOLOGY's viewing-slot text cite SPEC decision 89 instead of the proposed text; TECHNOLOGY describes `maxReach`.
