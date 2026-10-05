# Phase 7 — Remote and mobile access

**Current task:** P7-01, P7-02, P7-03 (wave 1, branch `p7-wave1-pwa-remote-touch`) · **Task status:** in progress
**Phase status:** in progress (0/6 done) — on branch `phase-7`

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
| 2 (parallel) | P7-04, P7-05 | Push and offline reconciliation. |
| 3 | P7-06 | Mobile-data acceptance run. |

## Tasks

### P7-01 — PWA manifest and service worker
- **Status:** in progress · **Depends on:** P5-04 · **Parallel with:** P7-02, P7-03
- Manifest (icons, name, display), versioned network-first service worker for the app shell only, install prompt handling, update flow (new version banner).
- **Acceptance:** installable on iOS and Android; a new deploy is picked up without stale shells.

### P7-02 — Tailscale Serve, token provisioning, remote flag
- **Status:** in progress · **Depends on:** P0-05, P25-08 · **Parallel with:** P7-01, P7-03
- Setup doc for Tailscale Serve; `Host` allow-list includes the `*.ts.net` name; token display + QR in settings; optional acceptance of Tailscale identity headers; connections flagged `remote` so permission auto-approval rules apply (never auto-approve for remote unless configured).
- **Acceptance:** phone on the tailnet opens the app over HTTPS and authenticates; a remote client's permission request is never auto-approved.

### P7-03 — Touch controls and mobile tier
- **Status:** in progress · **Depends on:** P3-06, P5-04 · **Parallel with:** P7-01, P7-02
- One-finger orbit, pinch zoom, tap select; mobile quality tier default on phones; list mode as default on small screens or slow connections with a one-tap switch to the scene.
- **Acceptance:** scene usable on the phone at ≥30 fps at the mobile tier; list mode complete without 3D.

### P7-04 — Web Push notifications
- **Status:** todo · **Depends on:** P7-01, P25-07 · **Parallel with:** P7-05
- VAPID key generation and storage, push-subscription endpoints, server-side sending (`web-push`) for question/permission opened and project finished/failed; iOS caveats documented (Home-Screen install, user gesture); per-type toggles.
- **Acceptance:** a question opened while the phone is locked produces a push on iOS (installed PWA) and Android.

### P7-05 — Offline answer reconciliation
- **Status:** todo · **Depends on:** P0-08, P2-03 · **Parallel with:** P7-04
- Answers composed while disconnected are queued with the question's version and sent on reconnect; stale answers get "already answered by …"; UI shows queued state.
- **Acceptance:** airplane-mode test: answer queued, reconnect, resolved or rejected correctly.

### P7-06 — Mobile-data acceptance run
- **Status:** todo · **Depends on:** P7-01 … P7-05 · **Parallel with:** —
- From mobile data (not Wi-Fi): open the app, see the map or the list, read every status, answer a Steward's question and a permission request; record in `docs/tasks/notes/P7-06-mobile-run.md`.
- **Acceptance:** exit criteria met; notes committed.

## Exit criteria (from the plan)

From mobile data, you can open the app, see the map or the list, read every status, and answer a Steward's question or permission request.
