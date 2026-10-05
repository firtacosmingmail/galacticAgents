# P7-02 — Tailscale Serve, token provisioning, remote flag

The setup guide for users is `docs/REMOTE_ACCESS.md`. This note covers what was built, the decisions behind it, and the manual checklist for a real tailnet. Tailscale is not installed on the development Mac, so the automated tests copy what Serve does: a loopback connection carrying the ts.net `Host`, `X-Forwarded-*` and `Tailscale-User-*` headers, sent through Fastify inject and `ws`. Serve's header behaviour was checked against Tailscale's source (`ipn/ipnlocal/serve.go`): it keeps `Host`, sets `X-Forwarded-Host/-Proto/-For`, deletes any `Tailscale-User-Login/-Name/-Profile-Pic`, `Tailscale-Funnel-Request` and `Tailscale-Headers-Info` the client sent, and sets the identity only for untagged tailnet devices, never for Funnel traffic.

## What was built

- **Config.** `remoteHost` (`config.json`) or `GALACTIC_REMOTE_HOST`: one exact DNS name, validated (no scheme, port or `*`), stored lower-case and added to `allowedHosts`. `tailscaleIdentityLogins` turns identity headers on; it needs `remoteHost` and is ignored with a warning without it. `loadConfig` now also returns `warnings`, printed at startup: a wildcard in `allowedHosts` (`*.ts.net` also admits every Funnel page's `Origin`), and identity being on.
- **Remote detection** (`isRemoteRequest`). The P2-04 rule is kept and widened: any `X-Forwarded-*`, any `Tailscale-*` and `Via` now count as proxy headers too. `/health` reports `origin`.
- **Identity** (`tailscaleIdentityOf`, `isAuthorized`). Checked in this order: the opt-in is on, the connection is loopback, `Host` is exactly `remoteHost`, `Origin` is absent or `https://<remoteHost>`, there is no Funnel header, and there is exactly one listed login (case-insensitive). The bearer guard and the WebSocket `hello` accept an identity in place of the token. `/health` reports `identity` and still never the token. On the client, `discoverToken` returns `IDENTITY_TOKEN` (a stand-in, never stored) when `/health` names an identity.
- **Remote controls.** `POST /api/agents/:id/processes/stop` and `POST /api/harmonizer/restart` are refused to remote clients with 403 `remote_control` unless `autoApproveRemote`. Listing processes, the work and agent controls, answers and card decisions are unchanged.
- **Permission auto-approval.** This is still the P2-04/P2-21 floor. A new end-to-end test shows that a remote spawn under the `trusted` preset, authenticated either by token or by identity, still asks before `rm -rf`, while the same spawn from the local page runs it.
- **Settings.** `SettingsResponse.remote {host?, tailscaleIdentity}`. The Access section has "Show the phone QR code" (behind its own click, drawn client-side with `uqr` 0.1.3, MIT, no dependencies) for `https://<remoteHost>/#token=…`. Without `remoteHost` it shows a pointer to the setup doc instead. A device signed in by identity sees neither the token nor the QR code.
- **Token entry.** Pasting works as before. `takeTokenFromFragment` reads `#token=`, saves it, and strips it from the address bar and the history entry (other fragment parameters are kept). It runs in `App`'s first state initializer, before the router rewrites the URL, and a token handed over this way wins over a saved one.
- **Logs.** A test captures every Fastify log line (level `trace`) through local and remote requests, refusals and WebSocket sessions, and checks that the token and the login appear in none of them. The gateway logs only the credential kind of a remote session.

## Decisions

### Remote detection rule

A request is local only when it comes over a loopback connection with a loopback-or-absent `Host`, a loopback-or-absent `Origin`, and no proxy header. Everything else is remote. This is robust because:

- Serve can only be recognised by what it adds: it always preserves the ts.net `Host` and always adds `X-Forwarded-For`.
- Headers can only make a request more remote.
- A browser cannot forge `Host`.

### Trust model of identity headers

Serve guarantees the header is genuine for traffic that went through Serve. Nothing guarantees that traffic came through Serve: any local process can reach `127.0.0.1` and send the same headers. So identity is off by default, needs an explicit list of logins, is read only under the exact Serve name, and is documented as "every local process counts as these users". The concrete risk: a Steward with network permission could `curl` the API and answer its own permission question. This is now an open question in SPEC §8 (2026-10-05). A Unix-socket Serve target with file permissions would close it; Serve's proxy code appears to handle Unix-socket backends, but the documented CLI targets are TCP only, so that is left for later.

### proposed decision (now in SPEC §7)

Proposed text for SPEC §7.2 (not added to SPEC §7 here):

> | 90 | What a remote client may do | **The phone answers and steers; the Mac alone restarts and kills** (2026-10-05, P7-02; §5, decisions 37, 51, 76, 82, 83): a client that reaches Mission Control through Tailscale Serve (a remote client: anything but the Mac's own browser on loopback) may do everything the work needs — read every status, chat, answer clarification and permission questions, decide cards, pause, resume, stop and cancel work and agents (from the panel or through the Harmonizer's `control_work`) — but its permission policies are floored at the global default (decision 37), it changes only the quality tier and a tighter default table (decision 51), and it cannot stop a Steward's leftover processes (decision 76) or restart the Harmonizer (decision 82): those are refused with a note that they work from the Mac. `autoApproveRemote` lifts all of these limits together. The phone connects with the token, by scanning the settings page's QR code (the token rides in the address's fragment and is wiped from it on arrival) or by pasting it; Tailscale identity may replace the token only when the user lists the accepted logins, knowing that it then trusts every program on the Mac as much as those users. |

## Manual checklist (Cosmin, with Tailscale installed)

Prerequisites: Tailscale on the Mac and the phone, the same tailnet, MagicDNS and HTTPS certificates on. A fresh `pnpm build`.

1. [ ] Set `remoteHost` to the Mac's exact name in `~/.galactic/config.json` and run `galactic start`. No `[config]` warning should appear unless you also have a wildcard or identity configured.
2. [ ] `tailscale serve --bg --https=443 http://127.0.0.1:4321`, then `tailscale serve status` shows the mapping. `lsof -iTCP:4321 -sTCP:LISTEN` shows `127.0.0.1` only, not `*`.
3. [ ] On the Mac, open Settings → Access. The QR code is hidden until you click "Show the phone QR code". The address bar never contains the token.
4. [ ] On the phone (Wi-Fi off, mobile data), scan the code. The app opens over `https://<name>` with a valid certificate, connects (snapshot, live updates), and the address bar shows no `#token=`. Reload: it still connects (token saved).
5. [ ] On the phone, open `https://<name>/health` directly: `"origin":"remote"`, no `token`, no `identity`.
6. [ ] From another tailnet device: `curl -s https://<name>/health -H 'Tailscale-User-Login: you@example.com'` shows no `identity` (Serve dropped the forged header). Also `curl -s https://<name>/api/runtimes` gives 401.
7. [ ] On the Mac: `curl -s http://127.0.0.1:4321/health -H 'Host: other.ts.net'` gives 403 `forbidden_host`.
8. [ ] Phone, permission request: start a fake `permission` scenario under the `trusted` preset from the phone (ops console, dev mode). It asks rather than running `rm -rf`, and the phone can answer it. The same spawn from the Mac runs without asking.
9. [ ] Phone: Settings → Restart Harmonizer and a Steward's "Stop processes" are refused with the "only from this machine" message. Pausing and stopping an agent work.
10. [ ] Server log (`~/.galactic` / terminal) after all of the above: `grep` for the token finds nothing. `ws remote session (token)` lines are present.
11. [ ] Optional identity: add `"tailscaleIdentityLogins": ["<your login>"]` and restart (startup warns). On a fresh phone browser (no saved token), `https://<name>` connects without scanning, and Settings → Access says it is signed in by Tailscale identity. Remove the login and restart: the phone gets "unauthorized" and asks for the token.
12. [ ] Stop Serve afterwards if you don't keep it: `tailscale serve --https=443 off`.

## Left for later

- Whether identity-authenticated requests may answer permission questions, and a Unix-socket Serve target (SPEC §8, 2026-10-05).
- Per-device quality tier (an existing §8 question). It belongs to P7-03's mobile defaults, not here.
- The panel does not yet hide the restart and stop-processes buttons on a remote device. It shows the server's refusal instead. `/health.origin` is there for a later UI change.
- `pnpm-lock.yaml` gained `uqr`. If P7-01 adds dependencies too, the coordinator merges the lockfile (re-run `pnpm install` on the batch branch).
