# Remote access: the phone over Tailscale Serve

How to reach Mission Control from your phone (P7-02; `TECHNOLOGY.md` §2.4, §8; `SPEC.md` §5). The server stays bound to `127.0.0.1`. **Tailscale Serve** runs on the Mac, terminates HTTPS with a certificate for the Mac's tailnet name and forwards each request to the loopback port. Only devices on your tailnet can reach that name. No port is opened to the internet or the LAN.

> Never bind the server to `0.0.0.0`, never forward a router port to it, and never use **Tailscale Funnel** for it. Funnel publishes the name to the whole internet, and this server starts processes on your Mac. Point only HTTP-mode Serve at the port, never another tunnel (§1).

## 1. One-time setup

1. Install Tailscale on the Mac and the phone and sign both into the same tailnet.
2. In the Tailscale admin console (DNS page), turn on **MagicDNS** and **HTTPS certificates**. Serve needs both to give the Mac a `https://<machine>.<tailnet>.ts.net` name.
3. Find the Mac's full name: `tailscale status --self` (or the admin console's Machines page), e.g. `mymac.tail1234.ts.net`.
4. Tell Mission Control the name in `~/.galactic/config.json`:

   ```json
   {
     "remoteHost": "mymac.tail1234.ts.net"
   }
   ```

   Or set `GALACTIC_REMOTE_HOST=mymac.tail1234.ts.net` in the environment. The value must be one exact host name: no scheme, no port, no `*`. It is added to the `Host` allow-list, the settings page builds the phone's address from it, and it is the only `Host` under which Tailscale identity headers are read (§4).

   Do not use a `*.ts.net` wildcard in `allowedHosts`. It lets every name under `ts.net` through the `Host` and `Origin` checks, and that includes any stranger's public Funnel page. The server prints a warning at startup if it finds one.
5. Restart Mission Control (`galactic start`), then start Serve, in the background, pointing at the server's port (4321 by default):

   ```sh
   tailscale serve --bg --https=443 http://127.0.0.1:4321
   tailscale serve status        # shows https://mymac.tail1234.ts.net → http://127.0.0.1:4321
   ```

   To stop it: `tailscale serve --https=443 off` (or `tailscale serve reset`).

   **Only HTTP-mode Serve is supported**: exactly `tailscale serve --https=443 http://127.0.0.1:<port>`, which forwards each request as HTTP and adds `X-Forwarded-For`. Never point anything else at this port: not a TCP or TLS-terminated-TCP Serve (`--tcp`, `--tls-terminated-tcp`), not `ssh -L` / `ssh -R`, not VS Code's or any IDE's port forwarding, not `ngrok`, `cloudflared` or any other tunnel. Such a tunnel also connects from loopback but adds no proxy header, so the server cannot tell its users from the local page: they would count as **local** (§3), get the token from `/health` and skip every remote rule. The server warns about this at startup whenever `remoteHost` is set.

## 2. Connecting the phone

On the Mac, open **Settings → Access → Show the phone QR code** and scan the code with the phone's camera. The code holds `https://<remoteHost>/#token=<token>`:

- The token is in the URL **fragment**. A browser never sends the fragment to a server, so the token never reaches Serve's or Mission Control's request logs. The page reads it and removes it from the address bar and the history entry straight away. It saves it in the phone's browser storage once a connection with it is accepted; a token the server refuses never replaces one that works.
- The page can only clean its own history entry. The browser may still have recorded the `#token=` address elsewhere first: the global history and its suggestions, synced tabs or history on your other devices (iCloud Safari, Chrome sync), a camera app's list of scanned codes. Clear it there if that matters, or rotate the token (below).
- The code is drawn in the Mac's browser (the `uqr` library) and nothing is fetched to draw it. It shows only after its own click. Anyone who sees it, or a photo of it, has the token.

You can also open `https://<remoteHost>` on the phone and paste the token that `galactic start` printed (Settings → Access → Reveal / Copy on the Mac).

The phone is a **remote client** (§3): the server never hands it the token through `/health`, and the stricter remote rules apply to everything it does.

To revoke a phone, change `token` in `~/.galactic/config.json` (or delete it so a new one is generated) and restart. Every device then has to scan or paste again.

## 3. How the server tells a remote client from the local page

A request is **local** only when all of these hold (`isRemoteRequest`, `apps/server/src/http/security.ts`):

- the TCP connection comes from loopback (`127.0.0.0/8`, `::1`);
- `Host` is absent or a loopback name (`localhost`, `127.x`, `[::1]`, any port);
- `Origin` is absent or a loopback origin;
- no proxy header is present: no `Forwarded`, `X-Real-IP` or `Via`, no header starting with `X-Forwarded-`, and no header starting with `Tailscale-`.

Any other request is **remote**. When Serve forwards a request, it connects from loopback but keeps the phone's `Host` (the `ts.net` name) and adds `X-Forwarded-For`, `X-Forwarded-Host` and `X-Forwarded-Proto`. For a tailnet user it also adds the `Tailscale-User-*` identity headers. Any one of these marks the request remote. Headers can only make a request look more remote, so a forged header gains nothing. Unknown cases fail towards remote.

**`X-Forwarded-For` is the load-bearing signal, not `Host`.** The `Host` check catches a client that names the `ts.net` host, but a tunnel can deliver any `Host` it likes — `ssh -L 4321:127.0.0.1:4321` delivers `localhost:4321` — and adds no proxy header. Such a request is indistinguishable from the local page and counts as local. That is why only HTTP-mode Serve, which always adds `X-Forwarded-For`, may point at this port (§1).

The classification is made per request: on every REST call and on the WebSocket upgrade. `GET /health` reports it as `origin`. What it decides:

| | Local | Remote (unless `autoApproveRemote`) |
|---|---|---|
| Token from `/health` | only to a browser's own page (`Sec-Fetch-Site: same-origin` or `none`) | never |
| Permission policy writes (project trust level, presets, card trust, default table) | as chosen | floored at the global default: no looser in any category, never `trusted` (decision 37) |
| Agents a brain starts for remote work (a project the phone approved or edited, a message it sent) | as chosen | run under that floored policy: anything not auto-allowed by the default table is asked, never auto-approved |
| Settings other than the quality tier and a tighter default table | yes | 403 `remote_settings` (decision 51) |
| Spawn a free-form agent (`POST /api/agents`, the ops console's development tool, decision 24); stop a Steward's leftover processes; restart the Harmonizer | yes | 403 `remote_control` (`SPEC.md` decision 90) |
| Answer questions (permission and clarification), decide cards, chat, pause / resume / recover / stop / cancel work and agents | yes | yes: an explicit user decision, or work already started (decision 90) |
| `/dev/*` | yes | 403 `remote_dev` |

`autoApproveRemote: true` (or `GALACTIC_AUTO_APPROVE_REMOTE=1`) treats remote clients like the local page in every row above. It is off by default. Leave it off unless the phone is the only remote device and you accept that.

## 4. Optional: Tailscale identity instead of the token

Serve tells the server which tailnet user made a request (`Tailscale-User-Login`, `-Name`, `-Profile-Pic`). Mission Control can accept that login as the credential instead of the token. This is **off by default**. It is turned on only by listing the logins in `config.json`, and it needs `remoteHost`:

```json
{
  "remoteHost": "mymac.tail1234.ts.net",
  "tailscaleIdentityLogins": ["you@example.com"]
}
```

A request authenticates by identity only if it looks exactly like Serve forwarding that user (`tailscaleIdentityOf`):

- it comes over a loopback connection (the server binds `127.0.0.1` only, so a tailnet peer cannot connect directly);
- `Host` is exactly `remoteHost` (any port);
- `Origin`, if present, is `https://<remoteHost>`;
- it has no `Tailscale-Funnel-Request` header;
- it has exactly one `Tailscale-User-Login`, equal (ignoring case) to a listed login.

Such a request passes the bearer guard and the WebSocket `hello`, whatever token it sends. It is still a remote request (§3) and still never gets the token from `/health`. `/health` names the accepted login (`identity`). A phone that holds no token then connects with a stand-in, and the settings page says it is signed in by its Tailscale identity.

### Trust model: read this before turning it on

- **What Serve guarantees.** Before it forwards a request, Serve deletes any `Tailscale-User-*`, `Tailscale-Funnel-Request` and `Tailscale-Headers-Info` header the client sent. It then sets the identity only for a tailnet user's device: not for a tagged node and not for Funnel traffic (`ipn/ipnlocal/serve.go`, `addTailscaleIdentityHeaders`). So a device on the tailnet cannot forge someone else's login through Serve.
- **What it does not guarantee.** The server cannot tell Serve from any other program on the Mac. Every local process can connect to `127.0.0.1:4321` and send `Host: mymac.tail1234.ts.net` and `Tailscale-User-Login: you@example.com`. That includes processes of other macOS users and **an agent's own shell**.
- **But identity adds no new local exposure.** The same local processes can already get the token without identity: `GET /health` hands it to a loopback request with a loopback `Host` and no proxy headers, which is what the local page needs on first run. A Steward allowed network access (the `trusting` or `trusted` levels), or another macOS user, can ask `/health` for the token and then answer its own permission questions over the REST API or the WebSocket, with or without identity turned on. **Every process on this Mac is trusted as much as you are, either way.** Identity widens nothing locally; on the tailnet side it is as strong as Serve's guarantee above.
- **The `/health` speed bump.** `/health` returns the token only when the request carries `Sec-Fetch-Site: same-origin` (the page's own `fetch`) or `none` (a navigation typed in the address bar). Browsers set that header themselves and no page script can change it; `curl`, Node's `fetch` and most scripts do not send it by default. So an agent's casual `curl http://127.0.0.1:4321/health` gets no token. It is **a speed bump, not a boundary**: any local process can add the header (`curl -H 'Sec-Fetch-Site: same-origin' …`). A browser too old to send it (Safari before 16.4) gets no token on first run either: paste the one `galactic start` printed.
- **What a browser cannot do.** A web page in a local browser cannot forge `Host` or `Sec-Fetch-Site`, and the server sends no CORS headers, so a website cannot use either path (DNS rebinding included).

The open question (`SPEC.md` §8, 2026-10-05) covers both paths. Mitigations, from cheapest:

1. Keep the `/health` speed bump (built).
2. Keep agents off the server's port: run Stewards under a permission policy that asks for network access (`default` / `cautious`), or, where the runtime supports a network sandbox, deny loopback connections to the server's port.
3. Run Mission Control as its own macOS user, so other users' processes cannot read `~/.galactic`.
4. A channel only Serve can use: Serve forwarding to a permission-protected Unix socket instead of a TCP port, and the token never handed out over TCP. Not built.

Turn identity on only on a single-user Mac with no untrusted software running. The token is the default and recommended — not because it is safer against local processes (it is not, see above), but because it needs nothing configured.

## 5. Checks

- `curl -sk https://mymac.tail1234.ts.net/health` from a tailnet device: `"origin":"remote"` and no `token`.
- `curl -s http://127.0.0.1:4321/health` on the Mac: `"origin":"local"` and no `token` (no `Sec-Fetch-Site`); the Mac's browser page still picks it up.
- `curl -s http://127.0.0.1:4321/health -H 'Host: other.ts.net'`: 403 `forbidden_host`.
- The manual end-to-end checklist is in `docs/tasks/notes/P7-02-remote.md`.
