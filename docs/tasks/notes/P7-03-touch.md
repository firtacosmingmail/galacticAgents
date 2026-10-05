# P7-03 — Touch controls and mobile tier

Branch `p7-03-touch` (from `p7-wave1-pwa-remote-touch`), 2026-10-05. Status stays `in progress` until Cosmin has done the phone check below.

## What was already there

- **Camera.** OrbitControls (three-stdlib through drei) already maps one finger to orbit and two fingers to `DOLLY_PAN` (pinch zoom plus pan), with damping. Damping is off under reduced motion.
- **Picking.** `ClickTracker` already allows a 10 px wander for a tap (decision 65), and a second finger already makes a press a pinch.
- **Tiers.** The `mobile` tier existed (DPR 1, no composer, 30 fps cap), and so did list mode ("Hide scene", remembered per browser, decision 62).

## What this task adds

| Area | Change | Where |
|---|---|---|
| Touch-sized hit slop | A tap (`pointerType === 'touch'`) uses `TOUCH_SLOP`. Bodies and satellites get a 16 px minimum target radius (6 for a mouse) and a 8 px cluster (6). Question beacons get 24 px (18), task markers 16 px (9). The hover stays a mouse's and is unchanged. Bigger targets mean a tap near several specks more often opens the "what's here" list. That is corner case 24's rule: list, never guess. | `picking/pick.ts` (`PickSlop`, `pickSlop`), `scene-pick.ts`, `beacons/registry.ts`, `detail/overlay/task-registry.ts`, `Picking.tsx` |
| Ghost click | **Bug found in emulation.** A tap is handled on `pointerup`. The browser's synthesised `click` arrives a moment later at the same page point. After a beacon tap, `revealQuestion` had already scrolled the stacked panel, so that click landed on a navigation row and selected the Waykeeper instead of the asking Steward. Fix: cancel `touchend` on the canvas (non-passive). Nothing on the canvas listens for compatibility mouse events. | `Picking.tsx` |
| No page scroll or zoom from the scene | The canvas has `touch-action: none !important`. OrbitControls leaves an inline `auto` on the canvas and sets `none` on R3F's wrapper, so the `!important` is what actually holds. The scene's chrome (breadcrumb, legend, cards) has `pan-x pan-y`: no page pinch-zoom, but a card can still scroll. iOS `gesturestart/change/end` are cancelled on the controls' element (`blockPageGestures`). There is no long-press callout and no tap highlight. A drag that starts outside the canvas still scrolls the stack. | `scene.css`, `camera/CameraRig.tsx` |
| Touch-sized chrome | On `pointer: coarse`, "what's here" rows and the card's × are 44 px, and the scale toggle's button is 36 px. On a phone-width scene the scale toggle sits above the breadcrumb, which had overlapped it in the detail view ("Detail · Cutaway"). | `picking/picking.css`, `bodies/scale-toggle.css` |
| Per-device tier | The scene's tier is resolved in this order: this browser's own choice, else `mobile` on a phone, else the server's `qualityTier`. A phone means a coarse pointer and a viewport whose short side is ≤ 600 CSS px, in either orientation; tablets keep the server's tier. A new settings section, "Rendering quality on this device" (Automatic / High / Balanced / Mobile), applies at once, is stored in `localStorage` (`galactic.scene.tier`) and is never sent to the server. The server section's intro now says it is the default for every device. | `scene/device.ts`, `scene/device-tier.ts`, `SceneArea.tsx` (`useQualityTier`), `panel/settings/DeviceQuality.tsx`, `SettingsPage.tsx` (one line), `sections.tsx` (intro text) |
| List mode by default | If the browser has no remembered choice, the scene starts hidden when the screen is small (≤ 760 px, the compact bar's width) or the connection is slow (`navigator.connection.saveData`, or an `effectiveType` of `slow-2g`, `2g` or `3g`; Chrome and Android only, so Safari is never "slow"). The first explicit choice is remembered, as before. | `scene/visibility.ts` (`readSceneChoice`, `autoHidden`) |
| One-tap switch | In list mode on a compact screen, a row sits where the scene would be: "List mode, for a small screen." / "…to spare a slow connection." / "List mode." plus a 44 px **Show scene** button. The compact bar keeps its menu item (decision 67), which is two taps away. Wide screens already have the bar's toggle, so they get no row. | `panel/SceneOffer.tsx`, `Panel.tsx`, `panel.css` |

Pinch into the detail view needed no change: pinching drives the same distance check as the wheel (enter < 3 R, leave > 4.5 R, decision 84).

## Choices and conservative calls

- **§8 per-device tier (2026-10-03).** Resolved as **per device, with the server's value as the default and phones starting at Mobile**. See the proposed decision below. The server setting stays and is still remote-writable (decision 51). It now means "the default for devices without their own choice".
- **"Phone" is narrow on purpose.** Coarse pointer *and* a small short side. A touchscreen laptop or a tablet keeps the server tier, and a narrow desktop window gets list mode but not the mobile tier.
- **Slow connection counts 3G.** That is enough to wait for the ≈ 330 kB gzip scene chunk plus textures. The rule only sets the starting state; one tap overrides it.
- **The automatic list mode is not stored.** It is re-evaluated on each load until the user chooses. A laptop that was on a slow hotspot gets the scene back by itself on fast Wi-Fi. A phone stays in list mode until "Show scene" is tapped once.
- **Pinch pans too** (`DOLLY_PAN`, decision 64's "two fingers to pan"). If the fingers' midpoint drifts more than about 1.5 body radii, the camera stops following the body (decision 64's "pans away"), and a further pinch then cannot enter the detail view (it needs a focused body). A symmetric pinch never drifts. **Check on the phone** (checklist item 6). If it bites, the fix is `touches.TWO = TOUCH.DOLLY_ROTATE` or a pan dead-zone; that would be a product change to decision 64.

## Proposed SPEC text (not applied; Cosmin to accept into §7 and close the §8 question)

> **proposed decision 90 — Touch in the scene** (2026-10-05, P7-03; refines decisions 64, 65, 84): on a touchscreen one finger orbits and two fingers pinch to zoom and pan together; a pinch closer than about three radii opens the detail view and back out past four and a half leaves it, as the wheel does. Gestures that start on the scene never scroll or zoom the page; outside it the page scrolls and zooms as usual. A tap is a click (10 px of wander, decision 65) with finger-sized targets: a body or a satellite at least 32 px across, a question beacon 48 px, a task marker 32 px; when that finds several things, the "what's here" list opens with 44 px rows. Hover cards are a mouse's; a tap acts at once.

> **proposed decision 91 — Quality tier per device** (2026-10-05, P7-03; resolves §8 2026-10-03; refines decision 51): the settings' rendering quality is the default for every device; a phone (a touch screen whose short side is at most 600 px) starts at Mobile instead; and the settings page's "Rendering quality on this device" lets each browser pick its own tier, which wins over both, applies at once and is remembered in that browser only — the phone choosing Mobile never changes the Mac.

> **proposed decision 92 — List mode by default on phones and slow connections** (2026-10-05, P7-03; refines decision 62): with no choice remembered in the browser, the panel starts in list mode on a small screen (760 px wide or less) or a slow connection (data saver, or 3G or slower where the browser reports it), and shows the scene everywhere else. On a phone, list mode keeps a "Show scene" button at the top of the panel, one tap away (the menu has it too). The first time the user shows or hides the scene, that choice is remembered and the defaults no longer apply.

The §8 row (2026-10-03, per-device tier) should be closed by decision 91.

## Verification

### Gates (batch branch `p7-03-touch`, after the last commit)

`pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`: all green. Tests: protocol 70, server 976 (+1 skipped), **web 1516** (1494 before; new tests in `scene/touch.test.ts`, `panel/settings/device-quality.test.tsx`, `TopBar.test.tsx`, `picking/Picking.test.tsx`). The a11y suites (`a11y/axe`, keyboard, list mode, reduced motion) pass unchanged.

### Headless Chrome, device emulation (a proxy, not a phone)

**Setup.** All of these were my own processes and all were stopped afterwards; 5173 and 4321 were not touched.

- **Server:** the dev server (`GALACTIC_DEV=1 GALACTIC_HARMONIZER=fake`, `GALACTIC_HOME` in scratch) on 127.0.0.1:7836.
- **Web:** Vite dev on 7737 for driving modules, and `vite preview` (production build) on 7736 for performance.
- **Browser:** Chrome 154 headless with `--use-angle=metal` on an M3 Pro, CDP on 9536, scratch profile.
- **Emulation:** 390×844 CSS px, DPR 3, `mobile: true`, touch emulation (`pointer: coarse` matched; real `Input.dispatchTouchEvent` touch sequences, delivered as `pointerType: touch`).
- **World:** harness projects on Mars (4 Stewards, one asking a question), Jupiter (3), Europa (2) and Saturn (2).

Screenshots are in the session scratchpad, `shots-p703/`.

- **List mode default:** no stored choice gives list mode with the offer row. Tapping **Show scene** shows the scene at `data-tier="mobile"` and stores `1`; it is still shown after a reload (`01`, `02`).
- **Slow connection:** a 1280×800 desktop window under `Network.emulateNetworkConditions` (cellular 3G gave `effectiveType: '3g'`) started in list mode with the bar's "Show scene" and no offer row (`12`).
- **One-finger orbit:** the camera moved, `visualViewport.scale` stayed 1, and the stack did not scroll. A drag that started on the navigation scrolled the stack (0 → 184 px) (`03`).
- **Tap Mars at the system view:** the "what's here" list opened (Waykeeper, 4 Stewards, Mars, Phobos, Deimos: a speck under one fingertip). Tapping "Mars" (44 px row) selected its Waykeeper and the camera flew there at 8.5 R (`04a`, `04b`).
- **Pinch into the detail view:** pinching out from 8.5 R went to 3.09 R and then 1.3 R, and the detail view of Mars opened. Pinching in went to 3.58 R (still in, by the hysteresis) and then 9.8 R, and it left. The page scale was 1 throughout (`05`, `06`).
- **Small targets, reduced motion on** (satellites stand still):
  - A tap **21 px beside the question beacon** selected the asking Steward and focused the inbox. A mouse click at the same point missed it and deselected (`07`, `08`).
  - A tap **12 px beside a 2.7 px satellite** selected its Steward (`09`).
  - With reduced motion the camera stops with the finger: no glide after release.
- **Settings on the phone:** "Rendering quality on this device: Automatic — Mobile, because this looks like a phone" (`13`).

### Frame rate at the mobile tier

**How it was measured.** A **proxy**: the production build in headless Chrome on the Mac's GPU, with phone emulation and CPU throttling. It is not a phone GPU.

- A frame is a burst of WebGL draw calls more than 8 ms after the previous one (draw calls wrapped on `WebGL2RenderingContext`).
- Each value is a 6 s window, at load averages 6–8 (other agents running).
- Canvas: 390×337 at DPR 1 (the tier's cap). The views were the system view, 6 s of continuous one-finger orbiting, and Mars's detail view entered by pinching from a `/waykeeper/<id>` link.

| CPU throttle | cap | system view | orbiting | Mars detail (pinched in) |
|---|---|---|---|---|
| 1× | 30 (as shipped) | 30.0 fps, p95 33.8 ms | 30.0, p95 33.9 | 30.0, p95 34.1 |
| 1× | uncapped (`?show_fps=true`) | 60 (vsync) | 60 | 60 |
| 4× | 30 | 30.0, p95 34.4 | 30.0, p95 34.5 | 30.0, p95 34.5 |
| 4× | uncapped | 60, p95 17.8 | 60, p95 18.0 (max 23) | 60, p95 17.6 |
| 6× | 30 | 30.0, p95 35.2 | 30.0, p95 35.1 | 30.0, p95 34.5 |
| 6× | uncapped | 60, p95 18.3 | 59.8, p95 18.6 (max 26) | 60, p95 18.2 |

The uncapped runs are held to 60 by headless vsync, so the true headroom is higher. CPU throttling stands in for a slower phone CPU. It says nothing about a phone GPU's fill rate, which is what the real-phone check must confirm.

## What is left: manual phone checklist for Cosmin

Use the phone over the LAN (P3-08 notes, "phone steps") or over Tailscale once P7-02 lands. Do it in Safari on the iPhone, and in Chrome on Android if available. Clear site data first so that no choice is remembered.

1. **Default list mode.** The page opens in list mode with "List mode, for a small screen." and a **Show scene** button at the top. Everything is usable without 3D: navigation, the inbox (answer a question), and the chat.
2. **One tap to the scene.** Tap **Show scene**; the scene appears. Reload: it is still shown. Menu → Hide scene, reload: list mode, and the row now says "List mode."
3. **Tier.** Open with `?show_fps=true`: the meter reads `… · dpr 1 · mobile`. Settings → "Rendering quality on this device" shows Automatic — Mobile. Pick Balanced: the meter changes at once. On the Mac, the server's tier is unchanged.
4. **Frame rate.** With the meter on, the system view, a slow orbit and a planet's detail view stay **≥ 30 fps**. Without the meter, motion looks smooth at the 30 fps cap. If it does not, see P3-08's "Mobile cap" note.
5. **One-finger orbit.** Dragging on the scene turns the camera. The page does not scroll or bounce, and there is no text selection or callout on a long press. Dragging on the navigation below scrolls the panel.
6. **Pinch.** Pinching zooms the camera, never the page; Safari's page zoom must not kick in. Select a planet with work (tap it, or pick it from "what's here") and pinch in until the detail view opens (the breadcrumb ends "› Detail"). Pinch out to leave. **Watch for:** a pinch whose fingers drift sideways stops the camera following the planet, after which pinching in does not open the detail view. Note whether this happens with a natural pinch.
7. **Two-finger pan.** Moving two fingers together pans. A pan away from the body releases the follow (decision 64).
8. **Tap targets.**
   - Tap a planet: its Waykeeper is selected, or "what's here" opens when moons or satellites are under the finger. The list's rows and the × are easy to hit.
   - Tap a satellite up close, and a question beacon (the amber "?"): the asking agent is selected, the inbox shows the question, and **nothing else gets selected a moment later** (the ghost click).
   - In a planet's detail view, tap a task pin: its Steward is selected.
   - Tap empty space: back to the Harmonizer.
9. **Chrome over the scene.** The breadcrumb, "Detail view", the scale toggle (now above the breadcrumb) and the legend all work by tap, without overlap. A pinch that starts on them does not zoom the page.
10. **Reduced motion** (iOS Settings → Accessibility → Motion → Reduce Motion): the camera stops when the finger lifts (no glide), flights are instant, and nothing blinks.
11. **Landscape.** Rotate the phone: still the Mobile tier, and the scene and its controls work.
12. **Slow connection** (Android Chrome only, which has the Network Information API): with Data Saver on and site data cleared, the panel starts in list mode with "List mode, to spare a slow connection."

## Files

- New: `apps/web/src/scene/device.ts`, `scene/device-tier.ts`, `scene/touch.test.ts`, `panel/SceneOffer.tsx`, `panel/settings/DeviceQuality.tsx`, `panel/settings/device-quality.test.tsx`.
- Changed: `scene/visibility.ts`, `SceneArea.tsx`, `camera/CameraRig.tsx`, `picking/{pick,scene-pick}.ts`, `picking/Picking.tsx`, `beacons/registry.ts`, `detail/overlay/task-registry.ts`, `scene.css`, `picking/picking.css`, `bodies/scale-toggle.css`, `panel/Panel.tsx`, `panel/panel.css`, `panel/settings/{SettingsPage,sections}.tsx`, and the tests `TopBar.test.tsx` and `Picking.test.tsx`.
- P7-02 touches `SettingsPage.tsx` / `AccessToken.tsx` too. My change to `SettingsPage.tsx` is one import plus one `<DeviceQuality />` line after the server sections, so a merge conflict there should be trivial.
