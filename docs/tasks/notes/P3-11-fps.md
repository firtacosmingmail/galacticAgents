# P3-11 — The fps meter does not show

Cosmin: "if I add `?show_fps=true` to localhost nothing seems to happen."

## Root cause

The panel rewrites the URL to its canonical form on load, and that rewrite dropped the query. The scene reads `?show_fps=` only when it mounts, and it mounts after the rewrite.

1. `App` → `useLocationSync` runs `syncFromLocation()` in a layout effect on the first render. That calls `navigate(location, { replace: true })`, which did `history.replaceState(null, '', pathFor(location))`. `pathFor` returns only the path (`/`, `/waykeeper/<id>`, `/steward/<id>`), so `?show_fps=true` was gone about 10 ms after load.
2. `SceneArea` reads the flag in its first render (`useState(fpsMeterEnabled)`, reading `location.search`). It is not in the first render: `FirstRunGate` renders nothing until `GET /api/settings` answers, and on a first visit `App` shows the token discovery first. By the time `SceneArea` mounted, `location.search` was `''`. The flag was never stored in `localStorage` either.

The meter itself was fine. With `galactic.scene.fps = 1` already in `localStorage`, it rendered and was visible.

The P3-01 jsdom test missed this because it mounted `SceneArea` alone, without `App`'s URL sync. The P3-01 browser smoke check missed it too: it used a throwaway page that mounted `SolarScene` directly.

### Evidence

Repro setup:

- A server with the fake Harmonizer (`GALACTIC_HARMONIZER=fake`, `GALACTIC_HOME` in a scratch folder, port 5943). Setup was marked complete through `PATCH /api/settings {"setupCompleted":true}`.
- Vite dev on port 5947, proxying to that server.
- Headless Chrome 154 (ANGLE Metal), driven over CDP, with `galactic.scene.fps` cleared before each cold load.
- A script injected before the page's own scripts wrapped `history.replaceState` and logged when `.pnl-scene` appeared.

Before the fix, cold-loading `http://localhost:5947/waykeeper/w-x?show_fps=true` gave:

```
96ms  DOMContentLoaded, search="?show_fps=true"
107ms replaceState(/waykeeper/w-x) from /waykeeper/w-x?show_fps=true     ← syncFromLocation
117ms replaceState(/waykeeper/w-x) from /waykeeper/w-x
135ms scene mounted, search=""
→ href …/waykeeper/w-x, canvas present, .pnl-scene-fps absent, localStorage flag null
```

`/` and `/steward/s-x` behaved the same way. On a fresh install (first-run wizard showing) the query was stripped as well, and the scene is not shown until setup is done.

With the flag set by hand in `localStorage`, the meter showed and was visible:

- Text: `30 fps · 33.3 ms · dpr 2 · high`.
- Position: the scene's top-left (x 228, y 57 at 1440×900; the navigation column is to its left).
- Style: `display: block`, `visibility: visible`, `opacity: 1`, colour `rgb(156, 245, 156)`.
- Stacking: in the scene's chrome layer, above the canvas and the labels.

So the stacking order, the colour, the lazy chunk and the server's SPA fallback were all ruled out. The SPA fallback keeps the query (checked on the build too).

## Fix

- `state/store.ts`: `navigate(…, { replace: true })` keeps `location.search` and `location.hash`. This is the canonical rewrite, used by `syncFromLocation` and by `Panel`'s `useCanonicalSelection` for `/waykeeper/<a Steward's id>`. Unrelated query parameters now survive normalisation. A push navigation (a click to another agent, settings, history) still goes to a clean path.
- `scene/fps.ts`: new `captureFpsFlag()`. It takes `?show_fps=true` / `?show_fps=false` from the loaded URL and applies it to `localStorage`, the same way `fpsMeterEnabled` does. It also keeps the value in memory for a browser without storage.
- `App.tsx`: `useLocationSync` calls `captureFpsFlag()` before the first sync. The flag is therefore taken even when the scene mounts much later: after the token, the settings, the first-run wizard, or a "Show scene" click after a navigation dropped the query.
- `Panel.tsx`, `SceneArea.tsx` and `scene.css` are unchanged.

After the fix, the same cold load in Vite dev and in a production build (`pnpm build`, then the server serving `apps/web/dist` on 5943) gave:

```
…/waykeeper/w-x?show_fps=true → href keeps ?show_fps=true, flag stored "1", meter "30 fps · 33.3 ms · dpr 2 · high", visible at the scene's top-left
…/?show_fps=true, …/steward/s-x?show_fps=true → the same
…/steward/s-x?show_fps=false (flag set before) → no meter, flag cleared
```

Headless Chrome reads 30 fps because its frame rate is throttled. A normal window shows the display's rate.

## Tests

- `scene/scene.test.tsx`, "the fps meter from a cold load (P3-11)". These tests render the whole `App` with the stub scene:
  - `?show_fps=true` on `/`, `/waykeeper/<id>` and `/steward/<id>`:
    - the meter is rendered inside the scene area with the chrome class;
    - the path and `?show_fps=true` stay in the URL;
    - the flag is stored.
  - `/waykeeper/<a Steward's id>?show_fps=true&other=x#here` is rewritten to `/steward/<id>?show_fps=true&other=x#here`, and the meter shows.
  - The flag is remembered without the query, and `?show_fps=false` clears it.
  - List mode first: a navigation drops the query, then "Show scene" still brings up the meter.
  - All six failed before the fix.
- `scene/scene-model.test.ts`: `captureFpsFlag` stores the flag. Without storage, the start-up value holds for the page.
- The stacking order (meter above the labels) stays covered by `scene/stacking.test.ts`.

## How to use the meter

1. Open the panel: `pnpm dev` → `http://localhost:5173/`, or `pnpm build && pnpm start` → `http://127.0.0.1:4321/`. The scene must be shown: click **Show scene** in the top bar if it is hidden. Finish the first-run wizard if it is up.
2. Add `?show_fps=true` to any panel URL and load it, for example `http://localhost:5173/?show_fps=true` or `…/waykeeper/<id>?show_fps=true`.
3. A small green readout appears at the scene's top-left, for example `60 fps · 16.7 ms · dpr 2 · high`. It shows `… fps · high` for the first half second.
4. It is remembered in this browser (`localStorage` key `galactic.scene.fps`), so later loads without the query show it too.
5. `?show_fps=false` on any panel URL turns it off.
6. While it is on, the frame loop runs continuously, and the mobile tier's 30 fps cap is lifted, so the meter measures headroom.
