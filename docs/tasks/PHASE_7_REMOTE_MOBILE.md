# Phase 7 — Remote and mobile access

**Current task:** P7-06 (wave 3, needs Cosmin with Tailscale on the Mac and the phone, after wave 2 is merged into `phase-7`) · **Task status:** todo
**Phase status:** in progress (6/7 done) — on branch `phase-7`

> Keep the two lines above current. The ticket flow is described in `/CLAUDE.md` and `docs/tasks/README.md`.

## Purpose

Check on the system from the phone while the Mac runs the agents: installable PWA over Tailscale Serve, touch controls, mobile quality tier, list mode, push notifications, and offline-answer reconciliation.

## Entry criteria

- Phase 5 exit criteria met (Phase 6 is not required).
- Tailscale installed on the Mac and the phone.

## References

- `IMPLEMENTATION_PLAN.md` → Phase 7; corner cases 23, 27, 28.
- `TECHNOLOGY.md` §2.4 (PWA, Tailscale, iOS push constraints, service-worker strategy), §6.3 (resume), §8 (security, token provisioning).
- `SPEC.md` §4.5 (notifications), §5 (remote access).

## Design notes for implementation

- Server keeps binding to `127.0.0.1`; Tailscale Serve terminates TLS and forwards. Never a public port.
- Token pasted or scanned (QR) into the PWA; optionally accept Tailscale identity headers as the remote credential.
- Service worker: versioned, network-first app shell; never cache API or WebSocket responses.
- iOS Web Push only for Home-Screen-installed PWAs and only after a user gesture; server needs VAPID keys and the `web-push` library; treat push as best-effort.
- Reconnect already resumes from `lastEventId` (Phase 0); answers given offline carry the question's version.

## Execution order

| Wave | Tasks | Notes |
|---|---|---|
| 1 (parallel) | P7-01, P7-02, P7-03 | PWA shell, Tailscale/token, touch/mobile tier are independent. |
| 2 (parallel) | P7-04, P7-05, P7-07 | Push, offline reconciliation, demo-planet cleanup. |
| 3 | P7-06 | Mobile-data acceptance run. |

## Tasks

### P7-01 — PWA manifest and service worker
- **Status:** done (2026-10-05; device checks in P7-06) · **Depends on:** P5-04 · **Parallel with:** P7-02, P7-03
- Manifest (icons, name, display), versioned network-first service worker for the app shell only, install prompt handling, update flow (new version banner).
- **Acceptance:** installable on iOS and Android; a new deploy is picked up without stale shells.

### P7-02 — Tailscale Serve, token provisioning, remote flag
- **Status:** done (2026-10-05; device checks in P7-06) · **Depends on:** P0-05, P25-08 · **Parallel with:** P7-01, P7-03
- Setup doc for Tailscale Serve; `Host` allow-list includes the `*.ts.net` name; token display + QR in settings; optional acceptance of Tailscale identity headers; connections flagged `remote` so permission auto-approval rules apply (never auto-approve for remote unless configured).
- **Acceptance:** phone on the tailnet opens the app over HTTPS and authenticates; a remote client's permission request is never auto-approved.

### P7-03 — Touch controls and mobile tier
- **Status:** done (2026-10-05; device checks in P7-06) · **Depends on:** P3-06, P5-04 · **Parallel with:** P7-01, P7-02
- One-finger orbit, pinch zoom, tap select; mobile quality tier default on phones; list mode as default on small screens or slow connections with a one-tap switch to the scene.
- **Acceptance:** scene usable on the phone at ≥30 fps at the mobile tier; list mode complete without 3D.

### P7-04 — Web Push notifications
- **Status:** done (2026-10-05; device checks in P7-06) · **Depends on:** P7-01, P25-07 · **Parallel with:** P7-05
- VAPID key generation and storage, push-subscription endpoints, server-side sending (`web-push`) for question/permission opened and project finished/failed; iOS caveats documented (Home-Screen install, user gesture); per-type toggles.
- **Acceptance:** a question opened while the phone is locked produces a push on iOS (installed PWA) and Android.

### P7-05 — Offline answer reconciliation
- **Status:** done (2026-10-05; device checks in P7-06) · **Depends on:** P0-08, P2-03 · **Parallel with:** P7-04
- Answers composed while disconnected are queued with the question's version and sent on reconnect; stale answers get "already answered by …"; UI shows queued state.
- **Acceptance:** airplane-mode test: answer queued, reconnect, resolved or rejected correctly.

### P7-06 — Mobile-data acceptance run
- **Status:** todo · **Depends on:** P7-01 … P7-05 · **Parallel with:** —
- From mobile data (not Wi-Fi): open the app, see the map or the list, read every status, answer a Steward's question and a permission request; record in `docs/tasks/notes/P7-06-mobile-run.md`.
- Includes the device checklists of P7-01 (`notes/P7-01-pwa.md`: install on iOS and Android, update flow, airplane mode), P7-02 (`notes/P7-02-remote.md`: Tailscale Serve, QR token, remote refusals) P7-03 (`notes/P7-03-touch.md`: gestures, ≥30 fps at the mobile tier, list mode) and P7-04 (`notes/P7-04-push.md`: push on a locked iPhone and Android, lock-screen details, removing a device), P7-05 (`notes/P7-05-offline.md`: airplane-mode answers, stale answer from the Mac, offline card decisions) — their acceptance on real devices is verified here. Needs Tailscale on the Mac and the phone (not installed on 2026-10-05).
- **Acceptance:** exit criteria met; notes committed.

### P7-07 — Demo planets go away for good (added 2026-10-05)
- **Status:** done (2026-10-05) · **Depends on:** P4-06, P4-12 · **Parallel with:** P7-04, P7-05
- Found when Cosmin asked how to remove the planets of closed demo projects. `/dev/seed` creates orbit-less "Demo planet n" bodies; archiving their project only frees them, and `chooseBody` (`catalogue.ts`) reuses a free demo planet for a real project once the catalogue planets are taken, so it reappears and silently raises decision 1's planet cap. No bulk clear exists for seeded demo work (the harness "Clear" only takes harness items).
- Demo bodies are never chosen for real work; a demo body is retired (event, projection, migration if needed) when its project is archived; the ops console gets a dev-only "Clear demo projects" that closes/cancels and archives every seeded demo project (never real work).
- **Acceptance:** after "Clear demo projects" no demo planet is drawn and none comes back when a new project needs a planet; real projects and harness items are untouched.

## Exit criteria (from the plan)

From mobile data, you can open the app, see the map or the list, read every status, and answer a Steward's question or permission request.
