# P7-06 — Mobile-data acceptance run

**Result:** passed — 2026-10-12, Cosmin, on his phone over Tailscale (run in parallel with Phase 8 and Phase 9).

Cosmin ran the device checklists of P7-01 (`P7-01-pwa.md`), P7-02 (`P7-02-remote.md`), P7-03 (`P7-03-touch.md`), P7-04 (`P7-04-push.md`) and P7-05 (`P7-05-offline.md`) and reported that everything works.

## Exit criterion

From mobile data, you can open the app, see the map or the list, read every status, and answer a Steward's question or permission request — met.

## Findings fixed during the run

- The phone got "Not found" with `pnpm dev`: the page comes from Vite, not from the port Serve forwards to. Added `pnpm remote` (`scripts/remote-start.mjs`: starts Serve if needed, prints its status, builds and runs `galactic start --dev`) and documented it in `docs/REMOTE_ACCESS.md`.
- The desktop app showed "Phone: off" and Tailscale off while both worked: the Tailscale Mac binary acts as the CLI only when `TERM` is set. `tailscaleEnv` sets it (`apps/server/src/remote/tailscale.ts`, P9-16 follow-up).
