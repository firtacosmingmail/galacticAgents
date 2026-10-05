# P7-02 — Tailscale Serve, token provisioning, remote flag

The setup guide for users is `docs/REMOTE_ACCESS.md`. This note covers what was built, the decisions behind it, and the manual checklist for a real tailnet. Tailscale is not installed on the development Mac, so the automated tests copy what Serve does: a loopback connection carrying the ts.net `Host`, `X-Forwarded-*` and `Tailscale-User-*` headers, sent through Fastify inject and `ws`. Serve's header behaviour was checked against Tailscale's source (`ipn/ipnlocal/serve.go`): it keeps `Host`, sets `X-Forwarded-Host/-Proto/-For`, deletes any `Tailscale-User-Login/-Name/-Profile-Pic`, `Tailscale-Funnel-Request` and `Tailscale-Headers-Info` the client sent, and sets the identity only for untagged tailnet devices, never for Funnel traffic.

## What was built

- **Config.** `remoteHost` (`config.json`) or `GALACTIC_REMOTE_HOST`: one exact DNS name, validated (no scheme, port or `*`), stored lower-case and added to `allowedHosts`. `tailscaleIdentityLogins` turns identity headers on; it needs `remoteHost` and is ignored with a warning without it. `loadConfig` now also returns `warnings`, printed at startup: a wildcard in `allowedHosts` (`*.ts.net` also admits every Funnel page's `Origin`), identity being on, and (review) the HTTP-mode-Serve-only reminder whenever `remoteHost` is set.
- **Remote detection** (`isRemoteRequest`). The P2-04 rule is kept and widened: any `X-Forwarded-*`, any `Tailscale-*` and `Via` now count as proxy headers too. `/health` reports `origin`.
- **Identity** (`tailscaleIdentityOf`, `isAuthorized`). Checked in this order: the opt-in is on, the connection is loopback, `Host` is exactly `remoteHost`, `Origin` is absent or `https://<remoteHost>`, there is no Funnel header, and there is exactly one listed login (case-insensitive). The bearer guard and the WebSocket `hello` accept an identity in place of the token. `/health` reports `identity` and still never the token. On the client, `discoverToken` returns `IDENTITY_TOKEN` (a stand-in, never stored) when `/health` names an identity.
- **Remote controls.** `POST /api/agents` (a free-form spawn, review fix), `POST /api/agents/:id/processes/stop` and `POST /api/harmonizer/restart` are refused to remote clients with 403 `remote_control` unless `autoApproveRemote`. Listing processes, recover, the work and agent controls, answers and card decisions are unchanged.
- **Permission auto-approval.** This is still the P2-04/P2-21 floor. The end-to-end test shows that the phone, by token or by identity, can neither start a free-form agent (403) nor loosen a project's policy (floored to `ask`), while a `trusted` spawn from the local page runs `rm -rf` on its own.
- **Settings.** `SettingsResponse.remote {host?, tailscaleIdentity}`. The Access section has "Show the phone QR code" (behind its own click, drawn client-side with `uqr` 0.1.3, MIT, no dependencies) for `https://<remoteHost>/#token=…`. Without `remoteHost` it shows a pointer to the setup doc instead. A device signed in by identity sees neither the token nor the QR code.
- **Token entry.** Pasting works as before. `takeTokenFromFragment` reads `#token=` and strips it from the address bar and the history entry (other fragment parameters are kept). It runs in `App`'s first state initializer (`initialToken`), before the router rewrites the URL, and a token handed over this way is tried before a saved one. It is saved only once its session goes live (`confirmToken`); if the server refuses it, the page falls back to the token saved before (`refuseToken`) — review fix: a stale code used to overwrite a working token. The stand-in `IDENTITY_TOKEN` is never taken from a fragment, and the server refuses it as a configured token.
- **`/health` speed bump** (review fix). The token goes only to a request with `Sec-Fetch-Site: same-origin` or `none`, which browsers send for the page's own `fetch` and a typed navigation. The local page's first run is unchanged (its `fetch('/health')` is same-origin, also through the Vite dev proxy); a plain `curl` from an agent's shell gets `"origin":"local"` and no token. Not a boundary: any local process can send the header.
- **Tunnel warning** (review fix). With `remoteHost` set, startup warns that only HTTP-mode Serve may point at the port: a TCP Serve, `ssh -L/-R`, IDE port forwarding or any other tunnel adds no `X-Forwarded-For`, so its users would count as local.
- **Logs.** A test captures every Fastify log line (level `trace`) through local and remote requests, refusals and WebSocket sessions, and checks that the token and the login appear in none of them. The gateway logs only the credential kind of a remote session.

## Decisions

### Remote detection rule

A request is local only when it comes over a loopback connection with a loopback-or-absent `Host`, a loopback-or-absent `Origin`, and no proxy header. Everything else is remote. This is robust because:

- Serve can only be recognised by what it adds: it always preserves the ts.net `Host` and always adds `X-Forwarded-For`.
- Headers can only make a request more remote.
- A browser cannot forge `Host`.

Corollary (review): `X-Forwarded-For` is what makes this hold, not `Host`. A tunnel that adds no proxy header (TCP Serve, `ssh -L`) can deliver `Host: localhost` and is then indistinguishable from the local page. Only HTTP-mode Serve is supported (`docs/REMOTE_ACCESS.md` §1, §3).

### Trust model

Serve guarantees the identity header is genuine for traffic that went through Serve. Nothing guarantees that traffic came through Serve: any local process can reach `127.0.0.1` and send the same headers. The first version of this note said identity therefore "trusts every local process as much as the listed users", as if the token path did not. The review corrected that: **`GET /health` already hands the token to any loopback request with a loopback `Host` and no proxy headers** — that is how the Mac's page gets it on first run — so any local process (another macOS user's, or a Steward's shell with network access) can already get the token and answer its own permission questions. Identity adds no new local exposure; every local process is trusted either way.

Identity is still off by default, needs an explicit list of logins and is read only under the exact Serve name. The SPEC §8 question (2026-10-05) now covers both paths. Mitigations: the `/health` `Sec-Fetch-Site` speed bump (built); keeping Stewards' network access asking, or denying agents loopback access to the server's port; running Mission Control as its own macOS user; a Unix-socket Serve target with file permissions and no token over TCP (Serve's proxy code appears to handle Unix-socket backends, but the documented CLI targets are TCP only — left for later).

### Decision 90 (now in SPEC §7)

What a remote client may do is SPEC decision 90. The review added two rows to it: a free-form spawn from the ops console (`POST /api/agents`, decision 24) is local-only like the restart and the process stop; recover stays open, like resume. Work-driven spawns (a Waykeeper's Stewards, the Harmonizer's) never go through that route.

## Manual checklist (Cosmin, with Tailscale installed)

Prerequisites: Tailscale on the Mac and the phone, the same tailnet, MagicDNS and HTTPS certificates on. A fresh `pnpm build`.

1. [ ] Set `remoteHost` to the Mac's exact name in `~/.galactic/config.json` and run `galactic start`. One `[config]` warning appears: only HTTP-mode Serve may point at the port. No other unless you also have a wildcard or identity configured.
2. [ ] `tailscale serve --bg --https=443 http://127.0.0.1:4321`, then `tailscale serve status` shows the mapping. `lsof -iTCP:4321 -sTCP:LISTEN` shows `127.0.0.1` only, not `*`.
3. [ ] On the Mac, open Settings → Access. The QR code is hidden until you click "Show the phone QR code". The address bar never contains the token.
4. [ ] On the phone (Wi-Fi off, mobile data), scan the code. The app opens over `https://<name>` with a valid certificate, connects (snapshot, live updates), and the address bar shows no `#token=`. Reload: it still connects (token saved).
5. [ ] On the phone, open `https://<name>/health` directly: `"origin":"remote"`, no `token`, no `identity`. On the Mac, `curl -s http://127.0.0.1:4321/health`: `"origin":"local"`, no `token`; the Mac's browser page still connects on first run (clear its site data to check).
6. [ ] From another tailnet device: `curl -s https://<name>/health -H 'Tailscale-User-Login: you@example.com'` shows no `identity` (Serve dropped the forged header). Also `curl -s https://<name>/api/runtimes` gives 401.
7. [ ] On the Mac: `curl -s http://127.0.0.1:4321/health -H 'Host: other.ts.net'` gives 403 `forbidden_host`.
8. [ ] Phone, permission request: from the phone's ops console (dev mode) a spawn is refused with the "only from this machine" message (decision 90). From the Mac, start a fake `permission` scenario under the `cautious` preset; it asks before `rm -rf`, and the phone answers it. On the phone, raise a project's trust level to `trusted`: the saved policy still asks for destructive calls (floored at the default).
9. [ ] Phone: Settings → Restart Harmonizer and a Steward's "Stop processes" are refused with the "only from this machine" message. Pausing and stopping an agent work.
10. [ ] Server log (`~/.galactic` / terminal) after all of the above: `grep` for the token finds nothing. `ws remote session (token)` lines are present.
11. [ ] Optional identity: add `"tailscaleIdentityLogins": ["<your login>"]` and restart (startup warns). On a fresh phone browser (no saved token), `https://<name>` connects without scanning, and Settings → Access says it is signed in by Tailscale identity. Remove the login and restart: the phone gets "unauthorized" and asks for the token.
12. [ ] Stop Serve afterwards if you don't keep it: `tailscale serve --https=443 off`.

## Left for later

- How far to defend against local processes — both the `/health` token path and identity headers — and a Unix-socket Serve target (SPEC §8, 2026-10-05).
- Per-device quality tier: answered by decision 93 (P7-03).
- The panel does not yet hide the restart and stop-processes buttons on a remote device. It shows the server's refusal instead. `/health.origin` is there for a later UI change.
- `pnpm-lock.yaml` gained `uqr`. If P7-01 adds dependencies too, the coordinator merges the lockfile (re-run `pnpm install` on the batch branch).
