# P9-15 — Permission requests in the Mac menu bar

Branch `p9-15-tray` (from `ae5ecb3`, batch `p9-wave6-dismiss-tray`). User guide: `docs/DESKTOP.md` §2 "Permission requests in the menu bar"; design: `TECHNOLOGY.md` §2.3.

Cosmin's request (2026-10-08): "I want to see the permissions in the mac top bar icon and be able to answer them from there".

## What was built

- **Node side** (`apps/desktop/src`):
  - `tray-menu.ts` — `trayMenu(world, {sending})`: the waiting permission requests (open, held by the user; oldest first; id, version, title) and the clarification questions the user holds, at most 10 each plus totals. Titles "<agent>: <tool> <summary>": the agent as the page labels it (Harmonizer / Waykeeper · project / Steward · task), the input's `command` / `file_path` / `path` / `url` / … (else its JSON), then `redactForMenu` (a menu-local shape pass on top of the server's redaction), `cleanMenuText` (one line, `\p{Cc}` / `\p{Cf}` / line separators removed, capped at 80 characters with "…").
  - `answer.ts` — `answerQuestion`: `POST /api/questions/:id/answer` with `Authorization: Bearer`, `{answer: 'allow' | 'no', version, answerId: 'tray:<uuid>'}` (the panel's own answers); outcomes `answered` / `stale` (409 `stale`, the server's message kept) / `gone` (404) / `failed`; `outcomeNotice` turns a refusal into a notification.
  - `watcher.ts` — `onWorld` after each snapshot and event; `supervisor.ts` — sends a `menu` line when the sections change (empty unless live), and `answer()` (permission requests only, one in flight per request, shown as `sending`); `lines.ts` — the `menu` line and the `answer` command (JSON, validated; anything else ignored); `main.ts` wires it.
- **Rust** (`src-tauri/src`): `tray_menu.rs` (pure, `rustc --test` like `links.rs`): sections → entries, ids `allow:<version>:<id>` / `deny:…` / `focus:<id>` and back, `clean_text` (controls and bidi removed, capped, `&` doubled for muda's mnemonic stripping), `focus_url`. `main.rs` rebuilds the tray menu on each `menu` line around the fixed items, writes `answer` commands, and for "Open in GalacticAgents" shows the window and navigates it to `/#focus=question:<id>`.
- **Web**: `pwa/notification-clicks.ts` also reads `#focus=` on `hashchange` (a navigation of an open page to a fragment does not reload it).
- `scripts/smoke.mjs` step 3 (`pnpm desktop:smoke`): a harness Steward's permission request reaches the `menu` line; Allow once and Deny answer it through the route; a changed version is refused and notified.

## Design decisions (technical)

1. **The menu model is built in Node**, from the same fold as the waiting count, so the menu and the panel agree; Rust only renders it and maps ids back to actions.
2. **Answers go Rust → Node → server**, never through the page: no IPC is added (`capabilities: []` stays). The Node side already holds the token (decision 5 of P8-06).
3. **Same route, same answers, same version check** as the panel: `allow` / `no`. "Always" does not exist anywhere in the path (route, Node command parser, Rust ids); the parser refuses any other decision.
4. **Stale is the server's call**: the menu sends the version it showed; a 409 is notified ("Permission request already answered: … already answered by …"). A clarification id is refused locally; a request already in flight is not sent twice.
5. **Titles are untrusted**: redacted, one line, invisible/bidi characters removed, capped — in Node and again in Rust; `&` is escaped so `a && b` reads as written.
6. **"Open in GalacticAgents"** reuses the push-click fragment `#focus=question:<id>`; the page now also handles it on `hashchange`.

## Proposed SPEC decision (to be numbered by the coordinator; P9-14 adds one too)

**Proposed decision N — Permission requests in the menu bar** (2026-10-08, P9-15, Cosmin's request; decisions 7, 31, 90, 108, 110, 111): the desktop app's menu bar menu lists the permission requests waiting for the user — one entry per request, "<agent>: <tool> <command or path>", shortened to one line with secrets hidden — with **Allow once**, **Deny** and **Open in GalacticAgents**, oldest first, at most 10 shown and the rest as "N more — open the app". Allow once and Deny are the panel's Allow and Refuse: the same answer, as the user, from the Mac, with the version the menu showed; the menu never offers "always" (a lasting rule is set in the project's permission table). A request answered elsewhere or changed since the menu showed it is refused and the app says so in a notification ("already answered"). The clarification questions waiting for the user are listed under "Questions" and only open the app on that question, since an answer needs typing. The list follows Mission Control within a second and is empty while the app is not connected. Open in GalacticAgents brings the window forward with the question selected.

## How it was verified (2026-10-08)

- Vitest: `@galactic/desktop` 54 tests (29 before; +25 here: menu model, redaction/truncation, the answer path against a real HTTP fake server — allow, deny, stale, gone, failed, refused token, id escaping —, command parsing, the supervisor's menu lines and answers, the watcher's world hand-off); web `notification-clicks` +1.
- Rust: `pnpm --filter @galactic/desktop test:rust` (links 5 + tray_menu 7 tests), `cargo check` without warnings, `pnpm desktop:build` (release `.app`, 3.6 MB).
- `pnpm desktop:smoke` against a real server in a temp home (fake Harmonizer, `GALACTIC_DEV=1` for step 3, free port): all good; the request reached the `menu` line within a second.
- The built `.app` was launched once `--hidden` with a temp `GALACTIC_HOME`, port 4481, `GALACTIC_DEV=1`; harness permission and clarification questions were created; the shell log showed no unreadable line (the Rust side parsed the `menu` lines); the app was stopped by its pid (SIGTERM) and its server went with it. Cosmin's running app (and its server on 4321) was not touched. The menu itself was not looked at on screen (no screen access) — a hand check is left.
- Disk: `src-tauri/target` reached 1.7 GB (0.76 GB check + release), removed with `cargo clean` afterwards.

## Left / follow-ups

- Hand check on the real menu bar: the sections, a submenu's three items, Allow once / Deny with the panel open, Open in GalacticAgents selecting the question, a stale answer's notification.
- macOS keeps an open menu as it was until it is closed; a change arriving while the menu is open shows the next time it opens.
- If P9-14 adds a "dismissed" outcome, the menu needs nothing more: a dismissed permission is answered (it leaves the menu), and a stale menu answer is refused by the version.
