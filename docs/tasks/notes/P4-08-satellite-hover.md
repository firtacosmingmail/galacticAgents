# P4-08 — Satellite hover card

Branch `p4-08-hover` (from `p4-wave1-satellite`), 2026-10-03.

Cosmin: "I can see the satellite. I would want to be able to see information about them when I hover them with the mouse. Information like what agents they are and small info on what they are doing, like a title."

## What was built

Everything lives in `apps/web/src/scene/picking/`. Only `Picking.tsx` imports three.js. It runs inside the canvas, as before.

| File | What |
| --- | --- |
| `scene-pick.ts` (new) | `pickScene(ray, bodySpheres, satelliteSpheres, pxScale)`: `pickBodies` plus the satellites. It uses the same ray-vs-sphere maths, with each satellite's sphere taken from its live frame (`position`, half its `size`) and a **minimum 6 px target**. Satellites get no cluster slop: they move, and a list that flickered with them would be noise. The rule is below. Result: `{ bodies, satellites, candidates: PickTarget[], choice }`, where `PickTarget = {kind:'body', bodyId} \| {kind:'satellite', agentId}`. |
| `satellite-card.ts` (new) | The card as data, with no React and no three.js. `satelliteCard(world, agentId, {bodyId, mode})` gives `{ name, state, activity, where }`. `satelliteSelection(world, agentId)` gives the selection a click makes, or `undefined` for an unknown agent. `oneLine(text, max)` puts text on one line and cuts it at a word. |
| `SatelliteHoverCard.tsx` (new) | The card element. It takes the hover label's place, so the overlay still has one element that takes no pointer events. Content and position update separately (see "Live updates"). |
| `store.ts` | `Hover` is now `BodyHover \| SatelliteHover`. `SatelliteHover` carries `{kind:'satellite', agentId, mode, satelliteBodyId, others, x, y}`. `BodyHover`'s `kind` is optional, so existing call sites are unchanged. Also: `hoveredBody` / `hoveredSatellite`; `showHere(at, bodyIds, agentIds?)` (the "what's here" popover gets `satellites`); `activateSatellite(agentId)`, which selects the agent and flies to the satellite's body (falling back to the agent's work body). |
| `Picking.tsx` | Picks through `pickScene`. Hovering a satellite sets a `SatelliteHover` at the satellite's projected point on screen (whole pixels), not at the pointer. A click on a satellite calls `activateSatellite`, and a list click passes the satellites on. `labelUnder` now also yields to a satellite under the pointer. The frame loop re-picks when the camera moved **or while any satellite is drawn**, at most once per frame as before. `invalidate()` is called only when the hover really changed, so the `demand` loop (reduced motion) still rests. `HighlightRing` takes `agentId` too: the hovered satellite gets a faint white ring, at least 10 px. |
| `PickingOverlay.tsx` | Renders `SatelliteHoverCard` for a satellite hover. The "what's here" list shows satellites (by agent name) before bodies; choosing one calls `activateSatellite`. |
| `picking.css` | The card's look: a compact version of the label frame, the panel's state pill made smaller, the activity clamped to two lines, and a muted "where" line. |
| `hover-grace.ts` (review fix) | The hover grace as pure maths: `startGrace(agentId, pointer)`, `keepsGrace(grace, pointer, seen, idleMs)`. See "Hover grace". |
| `fixtures.ts` | `satelliteFrame(...)` for tests. |
| `satellites/registry.ts` | Picking reads the frames. `satelliteFrames()` returns the registry's own array (rebuilt on publish), so per-frame readers do not copy. |
| `anchors.ts`, `camera/store.ts` (review fix) | `anchorList()` returns the registry's own array (rebuilt on register / unregister); `anchorPosition(anchor, out?)` writes into a reused buffer. |

### The picking rule (`pickScene`)

1. A satellite counts only when the pointer's ray passes through its target (its drawn sphere, at least 6 px) **and its line of sight is not cut by a body's drawn sphere**. A satellite behind its planet is hidden by the planet. The occlusion test runs camera → satellite centre against each body's real radius, not against the pointer's ray. Otherwise a satellite beside a speck of a planet would be "hidden" whenever the ray grazed the planet's 2 px disc.
2. A satellite under the pointer **wins over bodies that are clear targets** (≥ 12 px on screen, such as the planet it orbits seen up close) **and over labels**. When several satellites are under the pointer, the one nearest the pointer on screen wins.
3. When **a speck of a body is under the pointer too** (the system view, where a planet is a few pixels wide with its satellites inside them), nothing is guessed. The hover names **the body** with "+n" (`hoverTarget`: the first body candidate), not a satellite: the satellites reorder around the pointer every frame and the hover flickered between them. A click opens the "what's here" list with satellites first, in a stable order (role — Harmonizer, Waykeeper, Steward — then agent id, never per-frame screen distance), then bodies (corner case 24).
4. With no satellite under the pointer, the bodies' rule applies unchanged.

### The card

```
[working]  Steward · Fix the date test that fails around midn…
Running the whole test suite after rewriting the date parser, then
checking coverage for…
scanning · Jupiter  +1
```

- **Name:** the panel's own `agentLabel`, so the words match the agent cards and navigation: "Waykeeper · <project name>" and "Steward · <task description shortened to 48 characters>". The Harmonizer's HQ station (P4-02) will read "Harmonizer".
- **State:** the panel's `StatePill` (`pill state-<state>` from `app.css`), with the same words and colours as the agent cards, made smaller.
- **Title:** `StatusRecord.currentActivity` (TECHNOLOGY §4: the latest summariser sentence or tool reading). Whitespace and newlines collapse to one line, which is cut at the last word boundary before 90 characters and ends in "…". CSS also clamps it to two lines at 300 px. Without an activity, the card says what the agent cards say: "no activity yet", or "not running" once the agent has ended (a satellite shrinking out).
- **Where:** the body's name, and the satellite's mode when it is not plain orbiting: "scanning · Jupiter", "flying to Saturn", "landing · 7 Iris" (later P4-03/04 modes come for free). "+n" comes last when other things are under the pointer.

### Live updates

- **Content:** the card reads `useAppStore`'s world, so a state or activity change shows on the next render while hovering. A change of mode or "+n" reaches it through the hover in the picking store.
- **Position:** while satellites are drawn (or one is hovered) and the pointer rests on the canvas, the hover is re-picked once per frame, inside R3F's frame right after the satellites' director has written this frame's positions (`Satellites` is mounted before `Picking`, same priority). The first version re-picked in a `requestAnimationFrame` scheduled from the frame, so the card lagged the drawn satellite by one frame; that lag is gone. The hover's position is not in the picking store's state: it goes through `moveHover` / `onHoverMove` (a plain module value and its listeners), whole pixels, and the card and the body label write their `transform` from it. The store's `hover` changes only when what is hovered changes (the agent, its mode, "+n"), so `PickingOverlay` does not re-render at frame rate. The card sits 14 px right of and 7 px below the satellite, and flips to the left or above near the scene's edges. When the satellite orbits away from a still pointer, the hover grace keeps it (below), then the hover moves to whatever is under the pointer now, usually the planet.

### Hover grace (review fix)

An orbiting satellite stays under a still pointer for about 150 ms. So a satellite picked by the rule above is kept hovered (card and ring follow it):

1. while the pointer stays within **6 px** of where the satellite was picked (the user is reading the card; the satellite may orbit away from the still pointer);
2. once the pointer has moved further, while it is within **max(the satellite's screen radius, 14 px)** of the satellite's projected centre (the user follows it).

It is released when the satellite is occluded by a body, off screen or gone (not visible, presence 0), when the popover opens, when the pointer leaves the canvas, or **3 s** after the pointer last moved. Under reduced motion the satellites stand still and the grace is off (the ordinary rule only).

### Clicks (review fix)

The satellite hovered (or kept by the grace) when the button goes down is recorded. If the release is a click (the threshold is unchanged) and that satellite is still visible and not occluded, it is activated without re-picking: an orbiting satellite has often moved out from under the pointer between press and release. Otherwise the click picks as before.

### Per-frame cost (review fix)

The pick spheres (bodies and satellites), the ray and the anchors' positions are scratch buffers reused from pick to pick (no per-frame arrays or objects once grown; a satellite sphere's centre is the live frame's `position`). `satellitesDrawn()` and the sphere builders iterate the registries' own arrays (`satelliteFrames()`, `anchorList()`). The canvas's page rectangle is cached and dropped on window resize, scroll (capture), pointer re-entry, a `ResizeObserver` on the canvas and a canvas size change seen by the frame loop.

## SPEC decision

Recorded as SPEC §7 decision 70:

| 70 | Satellite hover | **Hover a satellite to see who it is and what it is doing** (2026-10-03, P4-08; §4.1, decisions 53, 65, 66, 68): hovering a satellite shows a small card next to it: the agent's role and work ("Waykeeper · <project>", "Steward · <task>"), its state in the panel's words and colours, a one-line title of what it is doing now (the agent's current activity, shortened), and the body it orbits, plus "scanning" or "flying to <body>" while it does that. The card follows the satellite as it orbits and changes as soon as the agent's state or activity does; the hovered satellite gets a faint ring. A satellite under the pointer wins over the planet behind it and over a label; a planet in front of a satellite hides it. When a tiny body and its satellites are all under the pointer (the whole-system view), a click shows the "what's here" list, satellites first, instead of guessing. Clicking a satellite selects its agent and the camera flies to its body; dragging never selects. |

## Tests

- Review fixes: `hover-grace.test.ts` (4: still radius, follow radius, own radius over 14 px, release on gone and after the cap); `scene-pick.test.ts` (+2: stable list order and body hover at the system view across two frames, `hoverTarget`); `Picking.test.tsx` (+11: the speck hover names Mars "+2" and does not change as the satellites swap places; a click on a satellite that orbited away between press and release still selects it, but not once it went behind its planet or shrank out; the grace keeps an orbiting satellite under a still pointer and the hover follows it within the same frame, releases when the pointer stops following, after 3 s, behind a body, when hidden, on popover and on leave, a click while kept selects it; no grace under reduced motion; pick spheres reused across frames; the canvas rect read once, again after resize and scroll); `picking-ui.test.tsx` (+1: 30 hover moves cause no overlay commit, for the card and the body label).
- `scene-pick.test.ts` (8): a satellite in front of a big planet wins, and the planet wins off the satellite; a planet in front hides a satellite; a satellite past the planet's limb is not hidden; the 6 px minimum target (in at 5 px, out at 8 px, no slop); of two satellites, the one nearest the pointer; a speck body plus satellites goes to the list, satellites first; no satellite leaves the bodies' result unchanged; satellites behind the camera are ignored.
- `satellite-card.test.ts` (7): Waykeeper name, state, activity and where; a Steward's shortened task name; one line cut at a word; `oneLine` edge cases; no activity, ended agent, missing status, unknown agent; scanning and flying wording; click → selection for each role.
- `Picking.test.tsx` (+7, fake R3F, no WebGL): hovering a satellite in front of its planet puts the card at the satellite's screen point; the hover follows a frame mutated in place under a still pointer (position and mode) and falls back to the planet; a satellite behind its planet is hidden and a click selects the planet's Waykeeper; a click selects `steward:<id>` and flies to its body, while a drag selects nothing; a satellite wins over a label covering it; a speck body plus two satellites gives "+2" on hover and a click lists both satellites, then the body; hidden or fully shrunk satellites are not targets.
- `picking-ui.test.tsx` (+4): the card's name, pill, activity and where, updating live on status changes, mode and "+n"; the card is placed at the satellite and the same element moves; "what's here" lists satellites first and choosing one selects the agent and flies; `activateSatellite` without a drawn satellite flies to the agent's work body, and an unknown agent does nothing.

## Browser check

For this check I used a throwaway harness (deleted, not committed). It mounts the real `SolarScene`, `LabelLayer` and `PickingOverlay` with P4-01's 40-satellite world: 10 Waykeepers and 30 Stewards, all `working`. I served it with `vite` on 127.0.0.1:6408 (the server proxy pointed at an unused port) and drove headless Chrome (ANGLE Metal, M3 Pro, 1440×900) over CDP.

- **Reduced motion** (the satellites stand still), camera on Jupiter. The pointer on a Steward's satellite gave `{kind:'satellite', agentId:'a-st-07', x:923, y:457}`. The card read "working · Steward · Task 1 / Editing src/a-st-07.ts / Jupiter" at 169×58 px, right of and below the satellite, and the satellite had its white ring. Changing that agent's `currentActivity` in the store changed the card's title on the next frame. A click selected `{kind:'steward', id:'a-st-07'}`.
- **Motion on**, with the pointer still on a Waykeeper's orbit. When the satellite passed under the pointer, the card showed "Waykeeper · Project 3" and followed it frame by frame (944,512 → 944,511 → 945,509), then gave way to whatever was under the pointer once the satellite had moved on.
- **Something to know:** a moving satellite stays under a still pointer for only about 150 ms. The review added the hover grace for that (see "Hover grace"); it was checked with the tests above, not re-run in this browser harness.

## Deferred

- **Keyboard path:** satellites are not in the scene's `]` / `[` cycle. The keyboard path to an agent stays the body + `Enter`, or the panel.
- **Touch:** a tap on a satellite selects it (the click path), but touch has no hover, so the card never shows on a phone. A long-press card could come with the PWA work (Phase 7).
- **Selected agent's satellite:** only the hovered satellite is ringed. The selection ring stays on the body, as decision 65 says. Ringing the selected agent's satellite too would be cheap if Cosmin wants it.
- **Instanced brightness highlight:** the ring was cheaper than brightening one instance of the instanced mesh, so there is no brightness change.
- Satellites near the pointer but not under it are not "what's here" candidates (they move).

## What Cosmin should try

1. Fly to a planet with work (`]` or a click) and rest the mouse on a satellite. The card shows the agent, its state pill, what it is doing and where. Leave the mouse still: the card stays with the satellite as it orbits away (the hover grace), and the planet's name comes back after 3 s, or once you move the mouse away from the satellite. Follow the satellite with the mouse and the card stays.
2. While hovering, watch a Steward change activity in the panel: the card's title changes with it.
3. Click the satellite. The panel selects that Steward or Waykeeper (`/steward/<id>`) and the camera flies to the body. Press and drag from a satellite: nothing is selected.
4. At the whole-system view, click a small planet with satellites. The "what's here" list names the satellites (by agent) above the planet.
5. Orbit until a satellite passes behind its planet: hovering there gives the planet, not the satellite.
