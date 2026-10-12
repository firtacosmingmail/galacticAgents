# P9-16 review (phone access from the desktop app and the panel)

Review of `main...p9-16-desktop-phone-impl`, 2026-10-12, security first. One blocker. Fixes on
`p9-16-review-fixes`, merged into `main`; gates green (protocol 122, desktop 79, server 1807 + 6
skipped, web 1854), Rust tests, `pnpm desktop:build`.

## Blocker (fixed)

- **B1 — an agent holding the token could start or stop Tailscale Serve** (exposing Mission Control
  to the tailnet on a server the user never opted in). `POST /api/remote/start|stop` now use the
  P9-12 agent peer guard (403 `agent_peer`).

## Should-fix (all fixed)

1. `tailscale` is looked up in trusted absolute locations first (the app's CLI, Homebrew,
   `/usr/local/bin`), each checked for owner and writability; PATH last, resolved once and logged.
2. Funnel is checked apart from Serve: stop turns off our Serve even with Funnel on, "already off"
   only when Serve is absent, and Funnel on is shown as a loud warning.
3. The desktop's automatic start respects the user: a stop from the panel or menu, or our Serve
   disappearing outside GalacticAgents, is recorded and blocks automatic starts until the user
   turns it on again.
4. `remoteHost` is written to `config.json` atomically.
5. A stale ownership record is dropped when Serve is absent, so "off" never stops `pnpm remote`'s
   Serve.
6. Quitting the desktop app stops the Serve it owns before stopping its server; the remaining case
   (a server stopped other ways) is documented.

## Nits (fixed)

`GALACTIC_PHONE_ACCESS` removed from the environment after use; startup waits at most 5 s for
Tailscale; check→act race commented; focusable Access heading; the menu toggle reverts if the
desktop's Node side is gone.

## Left open

- Not tried on a real tailnet or on screen: part of the P9-13 acceptance run.
