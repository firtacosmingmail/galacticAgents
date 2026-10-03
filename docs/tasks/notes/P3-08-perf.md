# P3-08 — Performance pass and phone test

Branch `p3-08-perf` (from `p3-wave5-perf`), 2026-10-03. The automatable part: profiling with a heavy world, the fixes it found, and everything Cosmin needs for the device runs. The Mac and phone numbers that close the exit criteria are Cosmin's (the "Device runs" table below).

## Exit criteria to compare against

From the phase file:

1. **60 fps on the Mac at "high".**
2. **≥ 30 fps at "mobile" in Safari on the phone over the LAN.** The mobile tier caps itself at 30 fps while the planets move (`maxFps`, P3-06). So "≥ 30" means the capped scene holds 30, and the uncapped headroom (`?fps=1`) stays above 30.
3. **Every assigned body can be clicked and shows the right project/task.** Taps must work on the phone (10 px touch slop, P3-05).

## Profiling

### Method

- **Harness.** A throwaway page, not committed and deleted afterwards. It mounted the real `SolarScene` and `LabelLayer` in a full-window `.pnl-scene`, from a **production build** (`vite build`, served by `vite preview`).
- **World:**
  - the catalogue's 31 bodies, parsed from migration 0005;
  - **11 projects**: 7 on planets; Europa and Titan as sub-projects of the Jupiter and Saturn projects; Io and Miranda as independent projects;
  - **Phobos** with a "moved to Mars" marker;
  - **30 task asteroids** (`asteroidSpec(1..30)`), whose states cycle through in progress, blocked on you, awaiting closure, paused, completed, approved, failed and interrupted. The blocked tasks hold open user questions;
  - the Harmonizer, 11 Waykeepers and 30 Stewards.

  That gives **42 labels**. The stress runs used 200 asteroids (212 labels).
- **Selection:**
  - **"waykeeper"**: Jupiter's Waykeeper is selected, so the outline is on (high and balanced) and the ring is shown (mobile);
  - **"harmonizer"**: the default; Earth gets the ring and there is no outline.
- **Browser.** Chrome 154 headless with ANGLE Metal (`ANGLE Metal Renderer: Apple M3 Pro`, checked through `WEBGL_debug_renderer_info`), on an Apple M3 Pro with 12 cores. Desktop runs used 1440×900 at DPR 2. Two kinds of run:
  - **vsync**: what a user sees, capped at 60;
  - **no-vsync**: `--disable-gpu-vsync --disable-frame-rate-limit`, which shows the headroom.

  The phone lower bound used **SwiftShader** (software GL) at 390×844, DPR 3, which the mobile tier caps to DPR 1.
- **Views:**
  - **system**: `back()`, then 2.5 s of settling;
  - **Jupiter / Saturn**: `flyTo`, then 4 s of settling, so the near textures are painted and uploaded;
  - **flights**: `flyTo` every 1.5 s across Jupiter, an asteroid, Saturn, Europa, Mars and another asteroid.

  Each view had 5 s of warm-up after load, then a 6 s window.
- **Metrics:**
  - **fps**: rAF ticks with at least one draw call, per second;
  - **p95 / max**: the frame interval;
  - **calls / triangles**: per frame, counted by wrapping WebGL2's `drawArrays` / `drawElements` (and the instanced versions). They include the composer's passes and the shadow cube faces;
  - **heap**: `performance.memory`, with `--enable-precise-memory-info`;
  - **label updates and writes per second**: `labelStats`;
  - **long tasks**: a `PerformanceObserver('longtask')`, counting tasks over 50 ms;
  - **CPU profile**: `Profiler` over CDP, run on an unminified build.
- **Machine load.** For about the first hour, a stray headless Chrome left by an earlier agent (PIDs 42973/42987) burned 2–8 cores and evidently the GPU. Load averages were 12–30. In that period every uncapped "high" run sat at ≈ 40 fps whatever the build, and the vsync runs locked to 30–40. Those runs are used **only for draw-call and triangle counts**, which do not depend on load. The stray process was gone by 15:45. Every table below comes from after that, at load averages of 2–6 (given per row).

### Results, before → after this branch (clean machine)

The "before" build is `p3-wave5-perf` and the "after" build is this branch. Both ran in the same session with the same world. Each no-vsync figure is one 6 s run; repeats moved by about ±10 %.

| tier | selection | view | load avg (before / after) | fps, vsync (before / after) | headroom fps, no-vsync | draw calls / frame | triangles / frame | heap MB | label passes/s | label DOM writes/s | labels shown | long tasks > 50 ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| high | waykeeper | system | 5.84 / 2.11 | 60 / 60 | 50 → 93 | 291 → 226 | 407k → 264k | 28 | 30 | 17 | 9 | 0 |
| high | waykeeper | Jupiter | 5.85 / 2.25 | 60 / 60 | 73 → 80 | 81 → 66 | 355k → 235k | 36 | 30 | 30 | 2 | 0 |
| high | waykeeper | Saturn | 5.49 / 2.44 | 60 / 60 | 73 → 89 | 82 → 57 | 301k → 170k | 45 | 30 | 10 | 2 | 0 |
| high | waykeeper | flights | 4.89 / 2.33 | 60 / 60 | 69 → 82 | 86 → 61 | 305k → 188k | 43 | 30 | 116 | 2 | 0 |
| high | harmonizer | system | 4.54 / 2.11 | 60 / 60 | 74 → 87 | 162 → 162 | 218k → 218k | 26 | 29 | 15 | 8 | 0 |
| high | harmonizer | Jupiter | 4.00 / 2.16 | 60 / 60 | 76 → 89 | 57 → 57 | 203k → 203k | 32 | 28 | 29 | 2 | 0 |
| high | harmonizer | Saturn | 3.54 / 2.36 | 60 / 60 | 76 → 88 | 58 → 58 | 170k → 170k | 40 | 29 | 10 | 2 | 0 |
| high | harmonizer | flights | 3.58 / 2.65 | 60 / 60 | 71 → 85 | 60 → 60 | 179k → 179k | 44 | 28 | 105 | 1 | 0 |
| balanced | waykeeper | system | 3.28 / 3.11 | 60 / 60 | 136 → 165 | 276 → 211 | 237k → 145k | 28 | 27 | 17 | 9 | 0 |
| balanced | waykeeper | Jupiter | 2.92 / 3.50 | 60 / 60 | 137 → 151 | 66 → 51 | 173k → 102k | 29 | 27 | 28 | 2 | 0 |
| balanced | waykeeper | Saturn | 2.78 / 3.20 | 60 / 60 | 134 → 164 | 67 → 42 | 152k → 76k | 27 | 29 | 10 | 2 | 0 |
| balanced | waykeeper | flights | 3.44 / 3.02 | 60 / 60 | 110 → 135 | 71 → 46 | 146k → 77k | 27 | 29 | 114 | 2 | 0 |
| mobile (meter, uncapped) | waykeeper | system | 3.55 / 2.79 | 60 / 60 | 711 → 711 | 131 | 62k | 24 | 15 | 16 | 9 | 0 |
| mobile (meter, uncapped) | waykeeper | Jupiter | 3.55 / 2.59 | 60 / 60 | 747 → 748 | 25 | 29k | 24 | 15 | 22 | 2 | 0 |
| mobile (meter, uncapped) | waykeeper | Saturn | 3.24 / 2.84 | 60 / 60 | 747 → 748 | 26 | 27k | 22 | 14 | 0–8 | 1–2 | 0 |
| mobile (meter, uncapped) | waykeeper | flights | 3.14 / 2.77 | 60 / 60 | 782 → 784 | 25–28 | 27k | 23 | 14 | 57–69 | 1–2 | 0 |
| mobile (capped, no meter) | waykeeper | system / Jupiter / Saturn / flights | ≈ 2–3 | 30 / 30 on every view (p95 33.4 ms) | — | 131 / 25 / 26 / 28 | 62k / 29k / 27k / 27k | 19–24 | 14 | 16 / 21 / 8 / 66 | 9 / 2 / 2 / 2 | 0 |

Reading it:

- **The vsync rate is 60 everywhere at high and balanced, and the cap holds a steady 30 on mobile, both before and after.** On this machine the exit criteria are met with margin. The headroom column is what the fixes buy: about 15–85 % at high with a Waykeeper selected, and 15–20 % with the default Harmonizer selection.
- **Harmonizer vs Waykeeper, before.** The outline's depth pass added 129 draw calls and 189k triangles at the system view (162 → 291). After, that is 64 calls and 46k triangles, and nothing at all while the selected body is off screen. With Jupiter selected and the camera at Saturn, the count is 57, the same as with no outline.
- **Labels.** The projection pass ran at 27–30 Hz on high and balanced and 14–15 Hz on mobile. It made about 15–17 DOM writes/s at the overview and 105–116/s during flights (57–69/s on mobile). It never showed in a CPU profile: `projectLabels` was outside the top 14 self-time functions, which are all three.js renderer internals, below 2 % each. The main thread was 73–87 % idle in every profiled window.
- **Long tasks.** None over 50 ms in any clean window, including flights. Those windows include the near-texture paints (in the worker) and their uploads of 2048 maps. While the stray Chrome ran, one 116 ms task appeared once (200 asteroids, flights, old build). It did not come back at clean load.
- **Heap.** 19–67 MB (the most with 200 asteroids), with no upward trend across a run.

### Stress: 200 task asteroids (212 labels), high, waykeeper (vsync, after, load ≈ 2.4)

| view | fps | calls | triangles | label writes/s | shown | long tasks |
|---|---|---|---|---|---|---|
| system | 60 | 736 (971 before; 471 on mobile) | 414k | 16 | 8 | 0 |
| close to asteroid 3 | 60 | 71 | 191k | 4 | 8 | 0 |
| flights | 60 | 92 | 203k | 309 | 1 | 0 |

Draw calls grow at about 2.5 per task asteroid: rock, halo and the outline's depth pass. They do not grow with labels. Label writes stay bounded by the throttle and by de-clutter (8 shown at the overview out of 212).

### SwiftShader, phone-sized (390×844, DPR 3 → 1), mobile tier: a lower bound

Software GL on the CPU, so this is far slower than a phone's GPU:

| setup | view | fps | calls | load |
|---|---|---|---|---|
| capped (no meter) | system / Jupiter / Saturn / flights | 30 / 30 / 30 / 30 (p95 33.4 ms) | 131 / 24 / 36 / 27 | 8–12 |
| uncapped (meter), harmonizer | system / Jupiter / Saturn / flights | 59 / 60 / 60 / 60 | 131 / 24 / 36 / 27 | 17–18 |
| uncapped, 200 asteroids | system / flights | 39 / 55 | 471 / 100 | 15 |

Even software GL holds the 30 fps cap on every view with the realistic world. This says nothing about a real phone's GPU, though: that is the Device runs table.

### Where the time goes at "high" (ablation, after, no-vsync, load ≈ 2.5)

High waykeeper at the system view and close to Jupiter, with one setting changed at a time. These are experiments in the harness, not changes:

| variant | system fps | Jupiter fps |
|---|---|---|
| high as shipped | 73 | 91 |
| DPR cap 2 → 1.5 | 155 | 156 |
| composer MSAA 4 → 0 (no antialiasing) | 176 | 176 |
| no shadows | 102 | 104 |
| no composer at all (no bloom, no outline) | ≈ 117–127* | — |

\* measured under load with the stray Chrome, against ≈ 41 for "as shipped" in that session.

The high tier's cost is **pixels, not draw calls**: a 2880×1800 HalfFloat render target multisampled 4×, then bloom's mip chain, then the point light's cube shadow. Draw-call savings help the CPU side and the outline. Resolution and MSAA dominate the GPU.

## What changed and why

Each change has tests without WebGL. None changes what the user sees: before/after screenshots at the system view and close to Jupiter, with Jupiter outlined, are indistinguishable. Edges are still antialiased, and the outline, rings, orbit lines, belt and stars are all drawn.

1. **Decorations on their own layer, left out of the outline's depth pass** (new `scene/layers.ts`, `picking/outline.ts` `depthPassWithoutDecor`).
   - With a body outlined, postprocessing's `OutlineEffect` renders the whole scene into a depth buffer every frame, only to tell visible edges from hidden ones.
   - The decorations never hide anything, so they are now on `DECOR_LAYER` (1) only: orbit lines, the star field, the belt's 6000 instanced background rocks, task-asteroid halos, the hover and selection rings, and the own-project rings.
   - The canvas's camera enables that layer (`onCreated` → `showDecor`). The effect's `depthPass.render` is wrapped once to render with that layer off (`withoutDecor`, which restores the mask even on a throw).
   - The shadow map was already blind to layer 1 (three tests casters against the shadow camera's own layers), and none of these objects cast shadows. Picking uses anchors, not a raycaster.
   - A side effect, and arguably a fix: halos and lines no longer count as occluders, so they cannot turn part of an outline into a "hidden" edge.
   - Effect: −65 calls and −143k triangles at high's system view; −15 to −25 calls close up.
2. **No outline while the selected body is off screen** (`bodyInView` in `outline.ts`, used by `OutlineSync`).
   - A frustum-vs-sphere test runs per frame with reused scratch objects (no allocation). The radius is ×2.5, so Saturn's and Uranus's rings count.
   - An off-screen body gets an empty selection, and the effect then skips all its passes. The selection comes back when the body is in view again.
   - Effect: with Jupiter's Waykeeper selected and the camera at Saturn, 82 → 57 calls, the same as no selection.
3. **No context MSAA where the composer already multisamples** (`contextAntialias` in `quality.ts`, used by `SolarScene`).
   - High and balanced draw the scene into the composer's own 4× multisampled target, and only a full-screen quad reaches the canvas. A multisampled canvas there only added a full-resolution MSAA buffer and its resolve on every frame.
   - The context is now antialiased only on a tier that wants MSAA and has no composer. Today that is none: mobile has neither.
   - Effect: about +15 % headroom at high even with the default Harmonizer selection (74–76 → 85–89 fps uncapped). The canvas key (context recreation) follows the same value.

Not changed:

- **Label updates.** The task asked for a cap on simultaneous label updates. P3-07's design already caps them:
  - one pass for all labels, at most `labelHz` (30, or 15 on mobile) times a second;
  - a transform write only past 0.5 px, and a visibility write only on change;
  - de-clutter keeps about 8 labels shown at the overview.

  Measured: ≤ 17 writes/s at rest and ≤ 116/s in flights with 42 labels, ≤ 309/s with 212 labels, and no measurable main-thread time. A further cap (deferring writes) would only make labels lag behind their bodies.
- **Per-frame allocations.** The profile shows none worth chasing. The remaining small ones are `anchorPosition` tuples in the ring and marker frames and the projector's per-pass maps at 30 Hz. GC was ≤ 0.1 % of samples.
- **The invisible pick spheres on task asteroids** (P3-05 notes) are skipped by three's renderer (`visible: false` material), so they cost nothing per frame. They are left in place.

## Proposed trade-offs (not done: they change what the user sees)

Only needed if the Mac misses 60 at high, or a phone misses 30 at mobile. In order of value for cost:

1. **High: DPR cap 2 → 1.5.** Roughly doubles the headroom (73 → 155 fps at the system view). The scene gets slightly softer on a Retina display, and the labels (DOM) stay sharp.
2. **High: shadows off**, the first thing the wave-2 review named. +40 % (73 → 102). Loses Saturn's shadow on its rings and moon eclipses.
3. **Composer MSAA 4 → 2, or SMAA instead of MSAA.** MSAA off is +140 % (73 → 176) but leaves jagged orbit lines and limbs. 2× or SMAA sits between the two, not measured.
4. **Ring only, no outline, while the selected body is under 18 px on screen**, where the ring is drawn anyway. This saves the outline's depth pass at the system view (226 → 162 calls with a Waykeeper selected). The faint outline around a speck goes; the ring stays.
5. **Later (Phase 4+), instance the task asteroids** if task counts go past ≈ 100. Each asteroid is 2 draw calls (rock and halo) plus the depth pass: 736 calls at high with 200 tasks, 471 on mobile.
6. **Mobile cap.** If the 30 fps cap does not feel smooth on the phone, set `maxFps: null` for mobile (`quality.ts`). The uncapped headroom is large (≈ 700 fps headless on the Mac's GPU, 60 even on SwiftShader).

## Security finding (not changed): the dev/preview proxy hands the token to the LAN

Found while writing the phone steps; verified with curl against a throwaway server (`GALACTIC_HOME` in scratch, `GALACTIC_ALLOWED_HOSTS=192.168.1.138`) behind `vite preview` on port 5917:

- `/health` hands out the token when the connection is from loopback and the `Origin`, if any, is loopback (`app.ts`). Behind the Vite proxy every request comes from loopback, and a same-origin `GET` (or `curl`) carries no `Origin` at all.
- So `curl -H 'Host: 192.168.1.138:5917' http://127.0.0.1:5917/health` → `{"…","token":"…"}`. **Any device on the LAN that can reach a `--host` Vite gets the token.**
- With an `Origin` from the LAN, no token is returned. A `Host` not in `GALACTIC_ALLOWED_HOSTS` gets `403 forbidden_host`.
- Suggested fix, for the coordinator or Cosmin: hand the token out only when `!isRemoteRequest(req)` (it already treats a non-loopback `Host` as remote). This branch does not change it.
- Until it is fixed, use the LAN steps below only on a trusted network, and stop the `--host` server after the test.

## Device runs (Cosmin) — to fill in

### On the Mac (tier "high")

1. Use a production build, closer to what the phone gets and without React's dev overhead. From the repo root: `pnpm build`, then `pnpm start` (add `--dev` to get the **Seed demo project** button). It serves the page on `http://127.0.0.1:4321`.
   - `pnpm dev` (`http://localhost:5173`) works too, but dev React costs main-thread time.
2. Settings (`/settings`): quality tier **high**. The tier is server-wide (decision 51): another device picks it up after a reload.
3. Have some work in the scene: real projects and tasks, or a few **Seed demo project** runs. Ideally a few planets and moons with projects, some task asteroids, and one question waiting for you.
4. Open `http://127.0.0.1:4321/?fps=1`. The meter at the top left reads `NN fps · ms · dpr 2 · high`. `?fps=1` is remembered in this browser; `?fps=0` clears it.
5. Rows:
   - **system view**: `Escape` or `Home`, then wait 5 s;
   - **close to Jupiter**: click Jupiter, or `]` until Jupiter, and wait 5 s for the near textures;
   - **during a flight**: press `]` repeatedly, about once a second, and read the meter while the camera flies.

   Do each row twice: with a Waykeeper selected (outline on) and with the Harmonizer selected.

### On the phone (iPhone Safari over the LAN, tier "mobile")

The server binds `127.0.0.1` only, and so does Vite by default (`server.port 5173`, no `host`). The phone therefore reaches Vite on the Mac's LAN address, and Vite proxies `/ws`, `/api`, `/health` and `/dev` to the server on loopback. Nothing in the code changes. Two opt-ins are needed, both per run:

- **Vite on the LAN:** `--host` (binds `0.0.0.0`). Use the IP address: Vite refuses unknown host *names*, such as `mymac.local`, unless they are in `server.allowedHosts`.
- **The server accepts the LAN address in `Host` and `Origin`** (its DNS-rebinding and WebSocket origin guards): `GALACTIC_ALLOWED_HOSTS=<mac-ip>`.

Steps:

1. Find the Mac's LAN IP: `ipconfig getifaddr en0` (for example `192.168.1.138`). The phone must be on the same Wi-Fi.
2. From the repo root, `pnpm build` (once).
3. Terminal 1, the server: `GALACTIC_ALLOWED_HOSTS=<mac-ip> pnpm start --no-open`. Add `--dev` for the demo buttons.
4. Terminal 2, the production page on the LAN, proxied to the server: `pnpm --filter @galactic/web preview --host --port 4173`. `vite preview` uses the same proxy table as `vite dev`.
   - For the dev server instead: `pnpm --filter @galactic/web dev --host`, with `pnpm --filter @galactic/server dev` in terminal 1 under the same `GALACTIC_ALLOWED_HOSTS`. `pnpm dev` from the root cannot pass `--host`.
5. On the Mac, set the quality tier to **mobile** in `/settings`.
6. On the iPhone, open `http://<mac-ip>:4173/?fps=1` in Safari. If it asks for the token, paste the one `pnpm start` printed (it is also `token` in `~/.galactic/config.json`). See the security finding: today the phone is usually handed it automatically.
   - The meter lifts the 30 fps cap, so it shows the headroom; that must be ≥ 30.
   - Then open `http://<mac-ip>:4173/?fps=0` to clear the meter and judge the capped 30 fps by eye.
7. Rows: as on the Mac. **System view**: the breadcrumb's "Solar system". **Close to Jupiter**: tap Jupiter. **During a flight**: tap one body after another.
8. **Taps:** tap 10 different bodies (planets, a moon, task asteroids, a label). Count how many select the right Waykeeper or task in the panel, and how many open the "what's here" list when they should not.
9. Stop both terminals afterwards: `Ctrl-C`. The LAN opt-ins live only in those commands.

### Results

| device | tier | view | selection | fps (meter) | feels smooth? | notes |
|---|---|---|---|---|---|---|
| Mac | high | system view | Waykeeper | | | |
| Mac | high | system view | Harmonizer | | | |
| Mac | high | close to Jupiter | Waykeeper | | | |
| Mac | high | close to Jupiter | Harmonizer | | | |
| Mac | high | during a flight | Waykeeper | | | |
| Mac | high | during a flight | Harmonizer | | | |
| iPhone (model: ) Safari, LAN | mobile | system view | Waykeeper | | | |
| iPhone Safari, LAN | mobile | close to Jupiter | Waykeeper | | | |
| iPhone Safari, LAN | mobile | during a flight | Waykeeper | | | |
| iPhone Safari, LAN | mobile | 30 fps cap (no meter): feels smooth? | — | (30) | | |
| iPhone Safari, LAN | mobile | taps select reliably? (n right / 10) | — | — | | |

Also worth a line: the phone's warmth and battery after about 5 minutes with the scene open, capped versus `?fps=1` (P3-06 notes).

### Then

- **All met:** P3-08 can be closed: 60 at high on the Mac, ≥ 30 at mobile on the phone, and taps right.
- **Mac below 60 at high:** apply trade-off 1 (DPR 1.5), then 2 (shadows).
- **Phone below 30 at mobile:** the next levers are fewer belt rocks (1200), fewer stars (2000) and the task asteroids' halos. Measure first; DPR is already 1.

## Files

- `apps/web/src/scene/layers.ts` (new): `DECOR_LAYER`, `showDecor`, `withoutDecor`.
- `apps/web/src/scene/picking/outline.ts`: `bodyInView`, `viewScratch`, `OUTLINE_VIEW_MARGIN`, `depthPassWithoutDecor`.
- `apps/web/src/scene/picking/Picking.tsx`:
  - `OutlineSync` patches the depth pass and empties the selection off screen;
  - the highlight rings are on the decor layer.
- `apps/web/src/scene/quality.ts`: `contextAntialias`; the `antialias` doc line.
- `apps/web/src/scene/SolarScene.tsx`:
  - the context's `antialias` and the canvas key come from `contextAntialias`;
  - `onCreated` → `showDecor`;
  - the star field is on the decor layer.
- `apps/web/src/scene/bodies/Bodies.tsx` (orbit lines), `belt/Belt.tsx` (background rocks, halos), `labels/MoonMarkers.tsx` (own-project rings): `layers={DECOR_LAYER}`.
- Tests, +7: `outline.test.ts` +4 (on-screen test with its margin; the depth pass without the decor layer, idempotent, tolerant of other effects; restoring on a throw; layer visibility); `Picking.test.tsx` +2 (`OutlineSync` empties and restores the selection off and on screen; leaves the decor layer out of the effect's depth pass); `scene-model.test.ts` +1 (`contextAntialias` per tier).
- `docs/TECHNOLOGY.md` §2.1: a "Performance pass (P3-08)" bullet; the quality-tier bullet's MSAA wording.

## Security finding — fixed (2026-10-03)

The coordinator fixed the `/health` token leak found here: the token is now handed out only when `!isRemoteRequest(req)` (`apps/server/src/app.ts`), so a LAN or Tailscale client behind a proxy on this machine (a remote `Host`, no `Origin`) no longer gets it; `app.test.ts` reproduces the leak (it failed before the fix). For the phone run, paste the token on the phone (it is printed by `galactic start` and shown on the settings page's Access section).
