# P3-01 — Canvas, renderer and quality tiers

## What was built

Everything is in `apps/web/src/scene/`. Only `SolarScene.tsx` imports three.js, and the panel loads it lazily.

| File | What |
| --- | --- |
| `quality.ts` | `QUALITY_TIERS`, one table for `high`, `balanced` and `mobile`, plus `sceneQuality(tier)` (undefined → `high`, the server's `DEFAULT_QUALITY_TIER`). Fields: `dprCap`, `antialias`, `bloom` (`{intensity, threshold, mipmapBlur}` or `null`), `stars`, `shadows`. P3-06 extends this table. |
| `SolarScene.tsx` | The R3F `<Canvas>`. The `gl` factory builds a classic `WebGLRenderer` explicitly (decision 20; no WebGPU path). Output is sRGB with ACES filmic tone mapping: R3F's defaults, so there is no `onCreated` repeating them. Resizing is R3F's own (`react-use-measure`). `dpr={[1, dprCap]}`. No shadow map and no `castShadow` yet: nothing receives shadows (P3-02 wires the tier's `shadows` flag with the planets). A `ContextLossWatch` child listens for `webglcontextlost` on the canvas (`preventDefault`, then `onContextLost` → `onFailure("the GPU context was lost")`), and removes the listener on unmount. The scene has the star-field skybox and the Sun: an emissive sphere (`#ffa630` × 4, linear luminance ≈ 1.95, well above the bloom threshold of 1.0) and a point light at the origin with `decay=0`, ready for P3-02. With bloom on, `EffectComposer` → `Bloom` (mipmap blur) → `ToneMapping(ACES_FILMIC)`; the composer sets the renderer to `NoToneMapping`, so tone mapping has to be an effect there. With bloom off (mobile), there is no composer, and a sprite with a gradient texture drawn at runtime (no image asset) stands in for the glow. The canvas is keyed on `antialias` (a context parameter), so only a tier change that flips it recreates the context. Every other tier change reconfigures the live canvas. |
| `starfield.ts` | `generateStarField(count, seed)`: plain data, seeded (mulberry32), uniform on a 1200–2400 shell, with a cool-to-warm tint and a brightness spread capped at `STAR_MAX_BRIGHTNESS` = 0.85, below the bloom threshold, so stars never bloom. It is drawn as one `THREE.Points` with vertex colours and a fixed pixel size: one draw call, no shader code. |
| `fps.ts` | `FpsCounter` (a 500 ms window) and `fpsMeterEnabled()`: `?fps=1` turns the meter on and remembers it in `localStorage` (`galactic.scene.fps`), and `?fps=0` turns it off. |
| `webgl.ts` | `webglAvailable()`: tries `webgl2` only (three 0.186 needs WebGL2) on a throwaway canvas, then releases that context. It runs lazily, only once the scene is to be shown (list mode never probes), and the result is cached for the page. jsdom (detected by user agent) answers `false` without probing, so the panel tests don't fill the log with "not implemented". |
| `visibility.ts` | `useScene()`: the user's show/hide choice (`galactic.scene.visible`, read and written inside try/catch, shown by default), the failure reason (no WebGL, the scene threw while starting, or its GPU context was lost), `shown = visible && !failure`, and `retry()` (undefined when there is no WebGL). |
| `SceneArea.tsx` | The scene's slot in the panel: `React.lazy(() => import('./SolarScene.js'))`, wrapped in an error boundary and a Suspense fallback ("Loading the solar system…"). It reads the tier from `useSettingsData()` (decision 51), so a saved tier reaches the mounted scene immediately. Also contains the DOM fps meter (`fps · ms · dpr · tier`). |
| `scene.css` | The slot and the meter. |

### Panel integration (shared files)

- `apps/web/src/panel/Panel.tsx`
  - The top bar has a **Hide scene / Show scene** button. The label names the action, so it is a plain button with no `aria-pressed` (a pressed state on a changing label reads backwards). Where the scene can't run, the button is replaced by a note, "3D scene unavailable — list mode", with the reason in its `title`, followed by a **Retry** button (except when the browser has no WebGL at all) that clears the failure and mounts a fresh scene.
  - On the `panel` route with the scene shown, the grid gets `pnl-grid-scene` and the `<SceneArea>` goes between the navigation and the conversation, and the root gets `pnl-with-scene`.
  - The scene is **not** mounted on `/settings` or `/history` (those pages replace the grid).
- `apps/web/src/panel/panel.css`: the layout with the scene (see below), plus the toggle and note styles. List mode is still the Phase 2.5 layout, byte for byte.
- `apps/web/src/panel/settings/sections.tsx`: the tier section's intro now reads "…a change applies at once in this browser (another device's change after a reload)." It used to say "the scene arrives in a later version".
- `apps/web/vite.config.ts`: `build.chunkSizeWarningLimit: 1200`, because the lazy scene chunk is expected to weigh about 1 MB.

Layout with the scene:

| Viewport | Columns |
| --- | --- |
| ≥ 1700 px | navigation \| **scene** \| conversation \| managed agents + inbox |
| 1101–1699 px | navigation \| **scene** \| conversation over managed agents + inbox (3:2 rows). The page height is fixed to the viewport, and each column scrolls on its own. |
| ≤ 1100 px | one column: the scene (45vh), then the navigation, the conversation and the side column. The page scrolls. |

### Behaviour

- **Hidden = unmounted.** "Hide scene" removes `<SceneArea>`, so R3F unmounts the root, disposes the renderer and calls `forceContextLoss()`. No GL context, no frame loop. The choice is stored per browser.
- **Frame loop.** It is `demand` while nothing moves: R3F renders on mount, on resize and when a prop changes. The fps meter switches it to `always`, so the meter measures a real per-frame cost. Decorative motion (P3-02) will need `always` or `invalidate()`.
- **WebGL fallback.** The probe fails → a note, and list mode. If the canvas fails later (`Error creating WebGL context` from R3F's configure, or any throw inside the scene), R3F rethrows to `SceneErrorBoundary`. If the browser takes the context away while the scene runs, `webglcontextlost` is reported the same way. Either calls `fail(reason)`: the panel goes to list mode with the note and a **Retry**, and the saved choice stays as it was. Retry clears the failure for this page and mounts a fresh scene (a new error boundary, canvas and context).
- **Tier at runtime.** Changing the tier on the settings page and saving updates `useSettingsData().response`. `SceneArea` reads it on the next render, and `dpr`, `shadows`, the star count and bloom are reconfigured without a reload. Only a change of `antialias` (to or from `mobile`) recreates the context.

## Proposed SPEC / TECHNOLOGY text (recorded as SPEC decision 62 and TECHNOLOGY §2.1)

**SPEC §7, new decision (scene visibility and list mode):**

> The solar-system scene sits in the centre of the panel's layout and is shown by default. A top-bar toggle "Hide scene" / "Show scene" switches to list mode. The choice is remembered per browser, not in the server's settings, because it is a device preference: the phone may want list mode while the Mac shows the scene. Hidden means unmounted: no WebGL context and no frame loop. If the browser can't create a WebGL context, or the scene fails to start, the panel stays in list mode and says "3D scene unavailable" in the top bar. The scene shows only on the panel's main view; the settings and history pages replace it.

**TECHNOLOGY §2.1, after "Postprocessing":**

> - **Quality tiers** (`apps/web/src/scene/quality.ts`, one table): `high` = DPR ≤ 2, MSAA, bloom 1.4, 9000 stars, shadows allowed (not wired until P3-02); `balanced` = DPR ≤ 1.5, MSAA, bloom 1.0, 5000 stars, no shadows; `mobile` = DPR 1, no MSAA, no composer (a gradient sprite fakes the Sun's glow), 2000 stars, no shadows. The tier comes from the server's settings (`qualityTier`, decision 51) and applies at once in this browser (another device's change after a reload). Only a change of `antialias` recreates the GL context.
> - **Renderer setup.** The canvas's `gl` factory builds a `WebGLRenderer` explicitly. Output is sRGB with ACES filmic tone mapping. When the postprocessing composer is active it forces `NoToneMapping` on the renderer, so ACES is applied as the composer's last `ToneMapping` effect. The frame loop is `demand` until something moves. `?fps=1` shows a dev frame-rate meter and switches the loop to `always`.
> - **Bundle.** three.js, R3F and postprocessing live in a lazily loaded `SolarScene` chunk. The panel's first chunk carries none of them, so list mode and a WebGL-less browser never download them.

**TECHNOLOGY, versions (if the doc keeps a list):** three 0.186, @react-three/fiber 9.8, @react-three/drei 10.7, @react-three/postprocessing 3.1, postprocessing 6.39.

## Dependencies added (`apps/web`)

| Package | Version | Why |
| --- | --- | --- |
| `three` | ^0.186.1 | The renderer (classic `WebGLRenderer`). Must stay < 0.187 for `postprocessing`'s peer range. |
| `@react-three/fiber` | ^9.8.1 | R3F v9, the React 19 line (peer `react >=19 <19.4`; the repo has 19.3.0). |
| `@react-three/postprocessing` | ^3.1.3 | `EffectComposer`, `Bloom`, `ToneMapping` (peer fiber ≥ 9.7). |
| `postprocessing` | ^6.39.5 | The peer of the above. Imported directly for `ToneMappingMode`. |
| `@react-three/drei` | ^10.7.9 | Not used yet; added at the coordinator's request for P3-02/03/04 (controls, `<Html>` labels, instancing helpers). Tree-shaken, so nothing of it is in either chunk today. |
| `@types/three` (dev) | ^0.186.0 | Types. |

`pnpm-lock.yaml` was updated by `pnpm --filter @galactic/web add` and committed. `pnpm` reported "approve-builds" for some transitive install scripts; none are needed, and none were approved.

## Bundle sizes (`pnpm --filter @galactic/web build`)

| Chunk | Size | gzip |
| --- | --- | --- |
| `index-*.js` (the panel's first chunk) | 473.58 kB | 138.25 kB |
| `SolarScene-*.js` (lazy: three + R3F + postprocessing + the scene) | 1,004.02 kB | 266.14 kB |
| `index-*.css` | 24.81 kB | 5.70 kB |

The first chunk contains no three.js (`grep WebGLRenderer` on it finds nothing). It carries only the small scene modules: `SceneArea`, `visibility`, `webgl`, `fps`, `quality`.

## Tests (Vitest, jsdom; no WebGL is rendered)

- `scene/scene-model.test.ts` (11 tests):
  - the tier table has one entry per protocol tier, gets lighter from tier to tier, has mobile's effects off, and falls back to the default;
  - bloom: every tier's threshold is 1.0, the brightest star of a 20 000-star sky stays ≤ 0.85, and the Sun's emissive luminance is well past the full-bloom point;
  - the star field's count, shell bounds and colour range, its determinism, and an empty sky;
  - `FpsCounter` measures 60 fps;
  - the `?fps=` flag sets and clears the remembered setting;
  - the visibility default and its persistence.
- `scene/scene.test.tsx` (9 tests). The lazy `SolarScene` module is mocked with a stub that records its mounts and the config it receives, and `webgl.js` is mocked:
  - shown by default at the tier the settings hold (`balanced`);
  - "Hide scene" unmounts it (mount count 0), stores `'0'`, and keeps the chat, the navigation and the side column working; it stays hidden after a reload, and "Show scene" brings it back;
  - not mounted on `/settings`;
  - no WebGL → the note, no toggle, no scene, and the panel works;
  - a scene that throws on start → the error boundary falls back to list mode with the reason in the note's title; Retry brings the scene back;
  - a lost GPU context (the stub calls `onContextLost`) → list mode with "the GPU context was lost"; Retry brings the scene back;
  - list mode never probes for WebGL; "Show scene" does;
  - a tier patched through `SettingsProvider` reaches the mounted scene (high → mobile: bloom off, 2000 stars) without remounting it;
  - `?fps=1` shows the meter.
- Gates on `p3-01-canvas`: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check` and `pnpm test` all pass:
  - protocol: 64 tests;
  - server: 842 tests (1 skipped);
  - web: 219 tests (was 199; 216 before the review fixes).

### Smoke check in a real browser (not committed)

A throwaway page mounted `SolarScene` with `?fps=1` and was driven through headless Chrome over CDP:

| Tier | Mode | Result |
| --- | --- | --- |
| `high` | GPU | 60 fps, 16.7 ms |
| `balanced` | GPU | 60 fps |
| `mobile` | SwiftShader (software GL) | 60 fps |
| `high` | SwiftShader | 19 fps (expected for software GL) |

Screenshots showed the star field and the bloomed Sun, and the mobile glow sprite. The only console warning is `THREE.Clock … deprecated`, which comes from R3F 9.8 itself. The full panel with the scene was not run against a live server (that would start a real Harmonizer). The layout is covered by the jsdom tests only.

## How Cosmin verifies 60 fps at "high"

1. `pnpm dev` (or `pnpm build && pnpm start`), then open the panel in Chrome or Safari on the Mac.
2. Settings → Rendering quality → **High** → Save, then go back to the panel. The scene is in the centre. If it isn't, click **Show scene** in the top bar.
3. Add `?fps=1` to the URL (e.g. `http://localhost:5173/?fps=1`) and reload. A green readout appears at the scene's top-left: `60 fps · 16.7 ms · dpr 2 · high`. The flag is remembered in this browser; `?fps=0` turns it off. (Until P3-11 the panel's URL rewrite dropped the query before the scene mounted, so this step showed nothing; see `P3-11-fps.md`.)
4. Check that it holds about 60 (or the display's refresh rate) with the window at full size. `dpr 2` confirms the Retina cap is in effect.
5. Try **Hide scene**: the scene disappears and the panel works in list mode. In Activity Monitor or the browser's task manager, GPU use drops. Reload: still hidden. **Show scene** brings it back.
6. Optionally switch the tier to Balanced or Mobile on the settings page, and check the readout's tier and dpr when you return. Mobile has no bloom: a soft sprite glow is used instead.

## Deferred / notes for the next tasks

- The scene unmounts on `/settings` and `/history`. Keeping it mounted (hidden) across routes would avoid recreating the context; that is worth considering in P3-06 or P3-08.
- No camera controls yet (P3-04); the camera is fixed at `(0, 40, 140)`, looking at the Sun.
- `frameloop="demand"`: P3-02's orbital motion needs `always` (or `invalidate()` from a clock). The tier table is the place for a mobile frame cap, if one is needed.
- A slight 8-bit banding is visible in the bloom halo on dark backgrounds. A dithering pass or `Noise` at very low opacity can fix it in P3-08 if it bothers.
- P3-02: enable the shadow map (`shadows="percentage"` from `quality.shadows`: PCF, because three r18x removed the PCFSoft that `shadows={true}` asks for) and the Sun light's `castShadow` once planets receive shadows.
- drei is installed but unused.
