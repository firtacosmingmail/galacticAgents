# Phase 7 wave 1 review (P7-01, P7-02, P7-03)

Review of `phase-7...p7-wave1-pwa-remote-touch`, 2026-10-05, security first. No blockers. Fixes
landed on `p7-wave1-review-fixes` and were merged into the batch branch; gates green afterwards
(protocol 70, server 1006 + 1 skipped, web 1570).

Device acceptance (install on iOS/Android, phone over Tailscale HTTPS, ≥30 fps on a phone) could
not be run here — Tailscale is not installed on the Mac. The three tasks are code-complete and
their device checklists are folded into P7-06.

## Should-fix (all fixed)

1. **Local processes could already take the token.** `/health` handed the token to any loopback
   request, so a Steward with network access could fetch it and answer its own permission
   questions — the docs wrongly blamed only the opt-in Tailscale identity. `/health` now returns
   the token only with `Sec-Fetch-Site: same-origin`/`none` (a speed bump against scripts, not a
   boundary; documented). REMOTE_ACCESS §4 and the SPEC §8 question now cover both paths and list
   the real mitigations (e.g. denying agents loopback access to the server port).
2. **Tunnels without proxy headers would look local.** Only HTTP-mode Tailscale Serve is
   supported; TCP/TLS-terminated Serve, ssh and editor port forwarding must never point at the
   port. `X-Forwarded-For` is the load-bearing signal. Startup warning when `remoteHost` is set.
3. **Update-flow races.** First install is decided on `reg.active` (a hard reload no longer hides
   the notice — the likely cause of the one failed run); Reload works when another tab already
   activated the worker; redundant workers are logged; static files are served with
   `wildcard: true`, so a rebuild without a restart no longer gives a blank page.
4. **Remote free-form spawn.** `POST /api/agents` (the ops console's dev tool) is refused to
   remote clients unless `autoApproveRemote`; recover stays open. Decision 90 names both.
5. **Docs.** SPEC §5 is tailnet-only; §8 rows answered by decisions 90 and 93; notes and code cite
   decisions 90–94 by number.

## Nits (fixed)

A QR token replaces the saved one only once it connects; `IDENTITY_TOKEN` (now in the protocol
package) is refused as a configured or scanned token; history/sync caveat for `#token=` URLs;
`touch-action: none` only on the canvas, so cards in the scene area pinch-zoom; a scene tap blurs
a focused text field; loopback pages are never "slow"; only the update message is a live region.

## Left open

- SPEC §8: how to stop local processes (agents included) from reaching the server port at all.
- The phone still shows Restart Harmonizer and stop-processes buttons; the server refuses them.
- All device checks (P7-06).
