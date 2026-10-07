# The desktop app (macOS)

An optional app around Mission Control (P8-06; `TECHNOLOGY.md` §2.3). It gives GalacticAgents a Dock icon, a menu bar status, OS notifications and a "Start at Login" switch. It shows the **same web UI** as the browser, served by the same local server: nothing about the server, its token or remote access changes. You can keep using the browser, the PWA on your phone and `pnpm start` exactly as before.

## 1. Build

Requirements: Node 22+ and pnpm (as for the rest of the repository), Rust (`rustup`, the stable toolchain for your Mac), Xcode command line tools.

```sh
pnpm install
pnpm desktop:build
```

This builds the server, the web app and the app's Node side, then the app bundle:

```
apps/desktop/src-tauri/target/release/bundle/macos/GalacticAgents.app
```

To build it and put it in `/Applications` in one step (quit the app first if it runs; options `--skip-build`, `--to <folder>`, `--open`):

```sh
pnpm desktop:install
```

It replaces `/Applications/GalacticAgents.app` only when the copy there is this app (same bundle identifier), and refuses while the app is running. Run it again after `git pull`: the app runs the repository it was built from.

The bundle is not signed by a developer certificate (ad-hoc only) and not notarized. Run it from where it was built, or copy it to `/Applications` (`pnpm desktop:install`); the first time, macOS may ask you to confirm opening it (right-click → Open). The build needs about 2–4 GB of disk for Cargo's build files (a debug build alone took 2.2 GB) under `apps/desktop/src-tauri/target/` (safe to delete; `cargo clean` there).

**The app does not contain the server.** It runs the repository it was built from: `apps/server` (with `galactic start`), `apps/web/dist` and `apps/desktop/dist`. After `git pull`, run `pnpm build` again (no Rust rebuild needed unless `apps/desktop/src-tauri` changed). Moved the repository? Set `GALACTIC_REPO` or rebuild.

During development, `pnpm desktop:dev` runs the app with `tauri dev` (a debug build). `pnpm desktop:smoke` checks the Node side against a real server in a temporary data directory, without Rust.

## 2. What it does

**Mission Control's lifecycle.**

- If Mission Control is already running on this data (`~/.galactic`, or `GALACTIC_HOME`) — started by `pnpm start`, `pnpm dev`, `pnpm remote` or another way — the app **attaches** to it: it shows its UI and never starts a second one (the data lock allows only one).
- Otherwise the app **starts** one (`galactic start`, on the port in `config.json` or `GALACTIC_PORT`, default 4321).
- **Quit** (menu bar → Quit, or ⌘Q) stops Mission Control **only if the app started it** — the menu says "Quit GalacticAgents (stops Mission Control)" then. Stopping is the usual graceful stop: running agents are interrupted and resumed on the next start. A Mission Control the app attached to keeps running.
- If the app's own Mission Control stops unexpectedly, the app starts it again (up to three times in five minutes, then the menu says so and offers **Start Mission Control**).
- While an import or a restore (`galactic import` / `galactic restore`) holds the data, the app waits, however long it takes, and never starts Mission Control over it; it says so in the menu bar.
- If a Mission Control the app attached to stops, the app does **not** start its own in its place (you stopped it, or you are restarting it); the menu says it is not running and offers **Start Mission Control**. When one starts again, the app attaches to it.
- Closing the window keeps the app (and Mission Control) running in the menu bar; click the Dock icon or **Open GalacticAgents** to bring it back.

**The menu bar icon** shows, loudest first: starting / disconnected / not running, a storage problem (the disk is full: "!"), "N waiting for you" (the count next to the icon: questions and cards waiting for you, the same number as the panel's), or "Live". The next line says which Mission Control and whether the app started it.

**Notifications.** The app posts macOS notifications for: a permission request, a question for you, a project finished, a project failed — the same kinds as Web Push. Inside the app, the page's own desktop notifications are switched off (its settings say the app posts them), so the app's window never adds a second one for an event. A browser tab open on the Mac at the same time is a separate page: it still posts its own notifications if you turned them on in that browser, so an event can then notify twice (close the tab or turn its notifications off). Push stays per device: the app changes nothing on the phone. Each event notifies once; opening the app never replays old events; after a reconnect, what is still current (an unanswered question, at most a day old) is shown, the five most important one by one and the rest as "N more updates". Clicking a notification does not open the item (a limit of the notification plugin); open the app's inbox. Manage or silence them in **System Settings → Notifications → GalacticAgents**. A full disk is shown in the menu bar, not notified (SPEC decision 104).

**Start at Login** (menu bar, off by default): adds a login item (a LaunchAgent in `~/Library/LaunchAgents`). At login the app starts in the menu bar without a window, and starts or attaches to Mission Control as above. Turn it on from the installed app (the item records the app's path; an app moved afterwards needs it turned off and on again).

## 3. Options

Environment variables (or, for the first two, `--port <n>` and `--home <dir>` after the app's binary):

| Variable                | Meaning                                                                 |
| ----------------------- | ----------------------------------------------------------------------- |
| `GALACTIC_PORT`         | The port of a Mission Control the app starts                            |
| `GALACTIC_HOME`         | The data directory (default `~/.galactic`); decides what is attached to |
| `GALACTIC_REPO`         | The repository to run (default: the one the app was built from)         |
| `GALACTIC_NODE`         | The `node` binary (default: your login shell's, else Homebrew/Volta/nvm) |
| `GALACTIC_DESKTOP_LOG`  | The log file (default `~/Library/Logs/dev.galacticagents.desktop/desktop.log`) |

Any other `GALACTIC_*` setting reaches the server the app starts. A separate data directory on another port, e.g. for a try-out:

```sh
GALACTIC_HOME=/tmp/galactic-try GALACTIC_PORT=4400 \
  apps/desktop/src-tauri/target/release/bundle/macos/GalacticAgents.app/Contents/MacOS/galactic-desktop
```

An app opened from the Finder gets a minimal PATH; the app asks your login shell once for its PATH and gives it to Mission Control, so agents find git, the agent CLIs and your project tools as in a terminal. It asks a **login, non-interactive** shell (`$SHELL -lc`, in the background, stopped after 10 s): `~/.zprofile`, `~/.zshenv` (and bash's `~/.bash_profile`) are read, `~/.zshrc` is not — an interactive shell would run whatever `.zshrc` starts (prompts, plugin managers, `exec tmux`) with no terminal. If your PATH or node is set only in `~/.zshrc` (nvm's installer puts it there), move those lines to `~/.zprofile` or set `GALACTIC_NODE`; the app also tries Homebrew, Volta and nvm's node folders by itself.

## 4. Security

Nothing new is exposed. The window shows `http://127.0.0.1:<port>`, Mission Control's own origin, so the page reads its token from `/health` and connects exactly as in Safari; the app adds no route to the server and gives the page no access to the app (no Tauri commands or plugins are callable from any page — the notifications and the menu are driven from the app's own process). Links to other sites open in your browser — at most one a second and five a minute, so a page cannot flood the Mac with tabs; a link a terminal agent prints in its terminal view opens only if it is http(s) and you confirm it. The app's status connection reads the token from `config.json` (or `GALACTIC_TOKEN`) and never writes it to its log; the `galactic start` banner's token line is hidden there.

## 5. The app, the PWA and Tailscale

- **On the Mac**: use the app, or the browser, or both. A browser tab next to the app notifies on its own only if you turned its notifications on in that browser — then you get the app's notification and the tab's for the same event.
- **On the phone**: nothing changes. The phone uses the PWA over Tailscale Serve (`docs/REMOTE_ACCESS.md`); Web Push goes to the phone whether the Mac shows the app or a browser.
- **Remote access with the app**: `pnpm remote` starts Tailscale Serve and its own `galactic start`; start it first, and the app attaches to that Mission Control. Or let the app start Mission Control and point Tailscale Serve at its port yourself (`docs/REMOTE_ACCESS.md` §1). Quitting the app stops only a Mission Control the app started — and with it what the phone reaches.
