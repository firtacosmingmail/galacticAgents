# P8-05 — Playwright scene and panel smoke tests

Branch `p8-05-smoke` (from `p8-wave2-smoke-backup-storage-caps`, edbdfbb). 2026-10-06.

## What was built

**`e2e/`: a test-only workspace package (`@galactic/e2e`)**, Playwright 1.63.0. It is a separate package rather than `apps/web/e2e` because the web app's ESLint config applies the React hooks rules to every `.ts` file there, and Playwright fixtures call a function named `use`. It has no `test` script, so `pnpm test` / `pnpm -r test` skip it; `pnpm typecheck` and `pnpm lint` do cover it.

| File | What it does |
|---|---|
| `playwright.config.ts` | one worker, files in order, no retries, 90 s per test, 20 s per `expect`; Chromium headless with `--use-angle=swiftshader --enable-unsafe-swiftshader`; viewport 1280×800 at DPR 1, `reducedMotion: 'reduce'`, dark scheme, UTC, service workers blocked (the PWA's would cache across runs); screenshot defaults (below); trace and screenshot kept on failure in `e2e/test-results/` (gitignored) |
| `support/server.ts` | starts the **real server from the production build** (`node apps/server/dist/index.js`, `GALACTIC_WEB_DIR=apps/web/dist`) with `GALACTIC_DEV=1` (the scene harness), `GALACTIC_HARMONIZER=fake`, `GALACTIC_LOG=silent`, a fresh `GALACTIC_HOME` and `GALACTIC_PROJECTS_ROOT` under `os.tmpdir()/galactic-e2e-*`, and `GALACTIC_PORT=0`: the OS picks a free port, read back from the "listening on …" line (never 4321 / 5173). Every other `GALACTIC_*` variable of the caller is dropped, so a stray `GALACTIC_HOME` can never point at `~/.galactic` and an unset Harmonizer can never mean `claude-sdk`. The config is seeded with `setupCompletedAt` (no wizard) and `qualityTier: balanced`; the **token is the one the server generates and writes to that temp config**, read back from it. `HOME` is the temp root as well (P8 wave 2 review). Stop: SIGTERM to that child's PID, SIGKILL after 30 s, then the temp directory is removed (`E2E_KEEP=1` keeps it and prints where). A build that is missing fails at once with "run `pnpm build` first". |
| `support/global-setup.ts` | one server for the whole run; its URL and token reach the tests through `E2E_BASE_URL` / `E2E_TOKEN`; the returned function is the teardown |
| `support/fixtures.ts` | `baseURL` / `token` from those; `api` (REST with the bearer token); `openApp({listMode?, storage?})`: per-browser preferences in `localStorage` before the first script (scene shown or hidden, tier `balanced`), then `/#token=<token>` (the QR code's hand-over, P7-02) and waits for the live indicator |
| `support/world.ts` | harness helpers (`seedScenario`, `clearHarness`, `askUser`), `questionOnServer` (the server's history is the source of truth), the scene probe readers |
| `support/scene-only.css` | applied to scene screenshots only: everything over the canvas (labels, legend, breadcrumb, scale toggle) at `opacity: 0` (not `visibility`: the label projector sets each label's visibility inline) |

**The scene's test hook** (`apps/web/src/scene/probe.tsx`, mounted in `SceneArea`): one empty `hidden` div, `data-testid="scene-probe"`, with `data-bodies` (registered anchors, sorted), `data-satellites` (the director's published agent ids, the HQ station included, sorted) and `data-camera` (`flying`, the focused body, `system` or `free`). No text, no role, not in the accessibility tree; no three.js. Unit test: `probe.test.tsx`. This is the only change to the app.

## The suite (8 tests)

| Spec | Test | Asserts |
|---|---|---|
| `01-app` | loads, authenticates with the config token and renders the snapshot | live; the fragment's token was saved (equals the config's) and removed from the URL; Harmonizer in the navigation, "Talking to", the fake Harmonizer's greeting from the log; the scene region and `b-earth` in the probe |
| `01-app` | a wrong token in the link is refused and never kept | the page goes live with the token `/health` hands a same-machine page (P3-08), never stores the wrong one |
| `02-scene-screenshot` | the whole system with a harness project | screenshot diffs (below): `system.png` and, after selecting the project in the panel (camera flies, probe `data-camera="b-mars"`), `mars-project.png` |
| `03-scene` | a harness project shows its body, its label and its satellites | every scenario agent (Waykeeper, 2 Stewards, asteroid Steward) in `data-satellites`, plus the HQ; the project's body in `data-bodies`; its DOM label "Harness project N" / "in progress"; a click on the navigation row flies the camera to the body and the dock shows "Waykeeper · …" |
| `04-inbox` | a clarification question is answered from the inbox | a harness Steward asks; the card appears live (`data-question-id`, "held by you"), the top bar counts it; typing + **Answer** removes the card; the server records `answered`, the text, `answeredBy: user` |
| `04-inbox` | a permission question is allowed from the inbox | **Allow** on the card → the server records `allow` by the user |
| `05-list-mode` | list mode: no canvas, no WebGL, and the panel does the work | "Show scene" offered, no scene region, no `<canvas>`, **zero** WebGL contexts requested (counted by wrapping `getContext` before the page's scripts); navigation → the project's Waykeeper; a clarification answered from the inbox reaches the server |
| `05-list-mode` | without WebGL the panel falls back to list mode and says why | `getContext('webgl2')` returns `null`: the top bar's note "3D scene unavailable — list mode" with title "WebGL is not available in this browser", no Retry, no canvas, navigation works |

Every wait is on a condition (`expect(...)` auto-retry, `expect.poll`); there is no fixed sleep anywhere. One race found on the way: `openApp` returns when the stream is live, which can be before the scene's lazy chunk has drawn the satellites — tests that read the probe poll it.

## Screenshot diffs: what makes them deterministic

- **Fixed inputs:** the scene's own seeds (star field, belt, surfaces: no `Math.random` in scene code); `reducedMotion: 'reduce'` (bodies at their starting angles, satellites still, frame loop on demand); `page.clock.install` at 2026-01-01T12:00Z; the camera resting at the system's framing (waited for through `data-camera`), then flown to Mars and resting there; tier pinned to `balanced` (settings and the per-browser key); 1600×1000 viewport at DPR 1; the legend closed; `clearHarness` then a scenario on a fixed body (`b-mars`, no asteroid — a new asteroid's place depends on how many came before).
- **SwiftShader everywhere:** Chrome's CPU renderer, forced by the launch flags, so the pixels do not depend on the GPU (CI runners have none) — the renderer string is "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device …))". Baselines are taken of the canvas only, with the DOM over it transparent, so no font enters a baseline; the snapshot path has no platform in it (`e2e/tests/__screenshots__/<spec>/<name>.png`), one set for macOS and Linux.
- **Not fixed:** a satellite's place on its orbit is seeded by its agent id, which is new on every run. Measured with `maxDiffPixels: 0` over three fresh servers: `system.png` 2–7 px differ, `mars-project.png` 37–86 px (the diff images show the satellites and nothing else). Allowances: 100 px for the system (config default) and 400 px for the close-up, per-pixel `threshold: 0.2`. For scale, Mars alone covers ~18 000 px of the close-up; a black canvas, a missing planet in the close-up, a wrong framing or a broken material fail. A tiny body vanishing from the whole-system view (a few dozen pixels) might not — the probe's `data-bodies` covers that.
- `toHaveScreenshot` itself waits until two consecutive shots agree before comparing, so textures still painting or a frame still settling do not fail it.
- **Updating the baselines** after an intended visual change: `pnpm e2e --update-snapshots` (or, without rebuilding, `pnpm --filter @galactic/e2e e2e --update-snapshots`), look at the new PNGs under `e2e/tests/__screenshots__/`, commit them with the change. On a failure the expected / actual / diff images are in `e2e/test-results/<test>/`; `pnpm --filter @galactic/e2e exec playwright show-trace <trace.zip>` replays it.

## Running it

```sh
pnpm e2e:install   # once per machine: Playwright's pinned Chromium (≈180 MB, into ~/Library/Caches/ms-playwright or ~/.cache/ms-playwright)
pnpm e2e           # pnpm build, then the suite
pnpm --filter @galactic/e2e e2e            # the suite only (needs a current build)
pnpm --filter @galactic/e2e e2e tests/04-inbox.spec.ts
E2E_CHANNEL=chrome pnpm e2e                # an installed Google Chrome instead of the pinned Chromium
```

**Browsers.** Default: Playwright's pinned Chromium (Chrome for Testing 153, playwright build 1243), installed by `pnpm e2e:install`. This machine had network access, so it was downloaded; no browser download happens during a test run. Where downloading is not possible, `E2E_CHANNEL=chrome` uses the installed Google Chrome (same SwiftShader flags; it updates on its own, so a baseline drift there is not a regression).

**Not part of `pnpm test`** (decision for this task): the suite needs a production build and a browser binary that `pnpm install` does not fetch, and it takes ~35 s with the build. `pnpm test` stays browser-free.

**CI notes** (there is no CI yet; the repo has no remote). A job would run, on Linux:

```sh
pnpm install --frozen-lockfile
pnpm --filter @galactic/e2e exec playwright install --with-deps chromium   # browser + its system libraries
pnpm e2e
```

with `CI=1` (forbids `test.only`, adds the HTML report in `e2e/playwright-report/`), and keep `e2e/test-results/` and `e2e/playwright-report/` as artifacts on failure. Cache `~/.cache/ms-playwright` keyed by the Playwright version. The baselines were taken on macOS (Apple M3 Pro) with SwiftShader; SwiftShader on x86-64 Linux should match within the allowances, but that is **unverified** until a first Linux run — if it differs, regenerate there with `--update-snapshots` and commit (or add `{platform}` to `snapshotPathTemplate` and keep one set per platform).

## Results

- `pnpm e2e` (build + suite): **8 passed**, suite 21.6 s, 35 s wall clock with the build.
- Flake check: `--repeat-each=5` on one server: **40/40 passed** (2.3 min — the harness world grows with every repetition). Under load (12 busy threads on a 12-core machine for the whole run) `--repeat-each=3`: **24/24 passed** (3.5 min). Two further plain `pnpm e2e` runs with the gates: 8/8 each (suite 20.4 s, 33 s with the build).
- No leftover processes or temp directories after any run (checked by PID and `galactic-e2e-*`).

## Proposed decisions

None for SPEC §7: the task added no product behaviour. Process suggestion for Cosmin: add `pnpm e2e` to the batch gates in `CLAUDE.md` for batches that touch `apps/web` (not edited here).

## Left over

- The screenshots cannot pin the satellites' exact places (their phases come from random agent ids); a deterministic id option for the harness would allow strict satellite pixels, at the cost of a server change. Not done: the allowance covers it and the probe asserts the satellites.
- A first Linux/CI run to confirm the macOS baselines (above).
- **The acceptance says "suite in CI using the fake adapter": there is no CI yet** (local repository, no remote). The suite runs locally with the fake adapter (`pnpm e2e`); the "in CI" part is pending until a CI exists — the job it would run is described under *CI notes* above.

## Review fixes (P8 wave 2 review, 2026-10-06)

- `support/server.ts` now also sets `HOME` to the run's temp root, so nothing the server or a child process reads from `~` (global VCS config, `~/.galactic`, `~/.claude`) is the user's.
