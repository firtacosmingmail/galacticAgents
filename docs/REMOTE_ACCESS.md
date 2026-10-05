# Remote access: the phone over Tailscale Serve

How to reach Mission Control from your phone (P7-02; `TECHNOLOGY.md` §2.4, §8; `SPEC.md` §5). The server stays bound to `127.0.0.1`. **Tailscale Serve** runs on the Mac, terminates HTTPS with a certificate for the Mac's tailnet name and forwards each request to the loopback port. Only devices on your tailnet can reach that name. No port is opened to the internet or the LAN.

> Never bind the server to `0.0.0.0`, never forward a router port to it, and never use **Tailscale Funnel** for it. Funnel publishes the name to the whole internet, and this server starts processes on your Mac.

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

## 2. Connecting the phone

On the Mac, open **Settings → Access → Show the phone QR code** and scan the code with the phone's camera. The code holds `https://<remoteHost>/#token=<token>`:

- The token is in the URL **fragment**. A browser never sends the fragment to a server, so the token never reaches Serve's or Mission Control's request logs. The page reads it, saves it in the phone's browser storage and removes it from the address bar and the history entry straight away.
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

The classification is made per request: on every REST call and on the WebSocket upgrade. `GET /health` reports it as `origin`. What it decides:

| | Local | Remote (unless `autoApproveRemote`) |
|---|---|---|
| Token from `/health` | yes | never |
| Permission policy writes (project trust level, presets, card trust, default table) | as chosen | floored at the global default: no looser in any category, never `trusted` (decision 37) |
| Agents a remote request starts, or a brain starts on a remote message | as chosen | run under that floored policy: anything not auto-allowed by the default table is asked, never auto-approved |
| Settings other than the quality tier and a tighter default table | yes | 403 `remote_settings` (decision 51) |
| Stop a Steward's leftover processes; restart the Harmonizer | yes | 403 `remote_control` (P7-02, the conservative answer to the `SPEC.md` §8 question) |
| Answer questions (permission and clarification), decide cards, chat, pause / resume / stop / cancel work and agents | yes | yes: an explicit user decision |
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
- **What it does not guarantee.** The server cannot tell Serve from any other program on the Mac. Every local process can connect to `127.0.0.1:4321` and send `Host: mymac.tail1234.ts.net` and `Tailscale-User-Login: you@example.com`. That includes processes of other macOS users and **an agent's own shell**: a Steward allowed network access (the `trusting` or `trusted` levels) could answer its own permission questions with one `curl`. With the token, it would first have to read `~/.galactic/config.json`, which is mode `0600` and outside its workspace, so the permission table asks first.
- **What a browser cannot do.** A web page in a local browser cannot forge `Host`, and the server sends no CORS headers, so a website cannot use this path (DNS rebinding included).

So: with identity on, **every process on this Mac counts as the listed users**. Use it only on a single-user Mac, with no project at the `trusted` level and no untrusted software running. Otherwise keep the token, which is the default and recommended. A tighter channel would be for Serve to forward to a permission-protected Unix socket instead of a TCP port, so only Serve could connect. That is not built.

## 5. Checks

- `curl -sk https://mymac.tail1234.ts.net/health` from a tailnet device: `"origin":"remote"` and no `token`.
- `curl -s http://127.0.0.1:4321/health -H 'Host: other.ts.net'`: 403 `forbidden_host`.
- The manual end-to-end checklist is in `docs/tasks/notes/P7-02-remote.md`.
