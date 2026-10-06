# P8-06 — Tauri 2 desktop shell

Branch `p8-06-desktop` (from `p8-wave4-pty-desktop`). User guide: `docs/DESKTOP.md`; design: `TECHNOLOGY.md` §2.3.

## What was built

- `apps/desktop/` (`@galactic/desktop`):
  - `src-tauri/` — the Rust shell (Tauri 2.12): window, menu bar icon, OS notifications, login item. `main.rs` only; no app commands, `capabilities: []`.
  - `src/` — the Node side the shell starts (`dist/main.js`): `lifecycle.ts` (data lock, `/health`, `galactic start`, stop), `supervisor.ts` (attach / start / restart / stopped), `watcher.ts` (one status WebSocket folded with the protocol's `applySnapshot` / `applyEvent`; notifications through `notificationOf`), `tray-view.ts` (what the menu shows), `lines.ts` (the stdout/stdin line protocol). 27 Vitest tests, in `pnpm test`.
  - `splash/index.html` — the shell's own page until Mission Control answers (no script).
  - `scripts/tray-icons.mjs` (template icon, no dependencies), `scripts/smoke.mjs` (`pnpm desktop:smoke`).
- `apps/web/src/desktop-shell.ts` + `panel/notifications/*`: inside the shell the page's notifications are off and the settings say the app posts them (top bar: "Notifications: by the app").
- Root scripts `desktop:dev`, `desktop:build`, `desktop:smoke`; `.gitignore` / `.prettierignore` / ESLint ignore `src-tauri/target` and `gen`.

Dependencies (all Apache-2.0 OR MIT): `@tauri-apps/cli` 2.12.1 (dev), crates `tauri` 2.12.1 (features `tray-icon`, `image-png`), `tauri-build` 2.7.1, `tauri-plugin-notification` 2.5.1, `tauri-plugin-autostart` 2.7.0, `serde` 1, `serde_json` 1. MSRV 1.90 (built with 1.99, `aarch64-apple-darwin` only). `Cargo.lock` committed (an application).

## Design decisions (technical)

1. **Lifecycle in Node, not Rust.** The server, the lock, the protocol fold and `notificationOf` are TypeScript; doing the lifecycle and the status in a small Node process reuses them unchanged (same ids as the page and Web Push, same "waiting" count) and keeps it testable without Rust. The Rust side only renders lines. Node is required anyway (the server).
2. **Attach vs start** uses the data lock (P8-03) plus `/health`; staleness is left to the server's own lock check (a refused start goes back to attaching). An attached server that disappears is not replaced (a user restarting `pnpm dev` would otherwise lose the race for the lock).
3. **Stop only what it started**: SIGTERM to the launcher it spawned (forwarded to the server), SIGKILL to the launcher's process group (spawned `detached`) after 35 s, never once it exited. The shell dying closes the Node side's stdin → it stops its server.
4. **Webview origin = the server's origin** (`http://127.0.0.1:<port>`): the existing token rules apply unchanged (verified: WKWebView passes the `/health` `Sec-Fetch-Site` check — the page's bearer-guarded `/api/settings` and `/api/preflight` answered 200). No IPC for any page; navigation restricted to the splash and that origin.
5. **The status socket's token** comes from `GALACTIC_TOKEN` / `config.json` (the shell is a local process of the same user, the trust model of REMOTE_ACCESS §4), sent only in `hello`, never logged; the launcher banner's token line is redacted in the shell log.
6. **Not bundling the server**: the `.app` runs the checkout it was built from (`GALACTIC_REPO`). Bundling Node, `better-sqlite3` and the agent SDK into the app is a bigger task (signing native modules, updates) — not needed for a single developer.

## Proposed SPEC decisions (not in §7 yet)

**Proposed decision 110 — The desktop app** (P8-06; §5, decisions 59, 90, 91, 104): GalacticAgents can also run as a macOS app with a Dock icon and a menu bar icon. It shows the same panel as the browser. When Mission Control already runs on this Mac's data, the app uses it; otherwise the app starts it. Quitting the app stops Mission Control only if the app started it (the Quit item says so); one started another way keeps running. If the app's Mission Control stops unexpectedly the app starts it again, at most three times in five minutes; if a Mission Control the app did not start stops, the app does not replace it and offers "Start Mission Control". Closing the window keeps the app in the menu bar. The menu bar shows whether Mission Control is live, disconnected or not running, a storage problem, and how many things wait for the user. "Start at Login" is off until the user turns it on; at login the app starts in the menu bar without a window. The phone and the PWA are unaffected.

**Proposed decision 111 — Notifications inside the desktop app** (P8-06; decisions 59, 95, 104): inside the app the page shows no desktop notifications; the app posts macOS notifications instead, so each event notifies once on the Mac. The app notifies the Web Push kinds — a permission request, a question for the user, a project finished, a project failed — with no per-kind switches of its own (the system's notification settings silence them). Each event notifies once per app run; opening the app never replays history; after a reconnect, what is still current and at most a day old is shown — the five most important one by one, the rest as "N more updates". Clicking a notification brings no particular item into view. A full disk is shown in the menu bar, never notified (decision 104).

Open questions for §8 (proposed):
- Should the app notify the other decision-59 kinds (task finished / failed, interrupted work, no free body), with switches in the menu? Conservative meanwhile: the push kinds only.
- Should the app remember what it notified across restarts and backfill on launch like the page (decision 59)? Meanwhile: no backfill at launch (never a replay).

## How it was verified (2026-10-06)

All checks in temporary `GALACTIC_HOME`s under the session scratchpad, ports 4472–4475 and random ones, `GALACTIC_HARMONIZER=fake`; the user's server on 4321 (pid 42294) was never touched.

- `pnpm desktop:smoke` (Node side vs a real server): started its own (owned), live, `/health` answers without a token; `quit` → launcher gone, port closed, lock released. Attach: a server started outside → `owned: false`, live; closing stdin → the outside server still answers.
- The built `.app` (release binary run from the bundle, port 4472): app → Node side → `galactic.mjs start --no-open --port 4472` → server; `/health` answered; the WebKit network process held connections to 4472. `osascript -e 'tell application id "dev.galacticagents.desktop" to quit'` → the log says "stopping the Mission Control this app started", every process of the run gone within ~1 s, the lock removed, port closed.
- Attach with the `.app` (outside server on 4473 with `GALACTIC_LOG=info`, app with `GALACTIC_PORT=4474`): nothing listened on 4474; the server logged the page's `/`, assets, `/health` and the bearer-guarded `/api/settings` and `/api/preflight` → 200 (the token reached the page in the webview). `kill -9` of the app → the Node side exited, the outside server kept running (then stopped by hand).
- Owned + `kill -9` of the app (port 4475): the Node side saw stdin close and stopped its server (port closed within ~1 s, lock removed).
- No screenshot was possible (no screen-recording permission for the terminal), so the window's rendering was checked through the server's request log only. Notifications, the tray title and Start at Login were not exercised by hand (the LaunchAgent would be written to the user's `~/Library/LaunchAgents`); `tauri dev` was not run.

Disk: `src-tauri/target` 1.7 GB after a `cargo check` and the release build (≈ 0.98 GB release kept, the 0.76 GB `debug` check output deleted); `~/.cargo/registry` +197 MB; bundle 3.6 MB.

## Left / follow-ups

- Hand checks on the real desktop: the menu bar title and items, a notification (permission prompt on first use), Start at Login on and off, ⌘Q from the app menu, Dock reopen.
- Notification clicks cannot select the item (the plugin has no desktop click callback); a later version could use `UNUserNotificationCenter` directly.
- A signed / notarized build and a bundled server are out of scope.
