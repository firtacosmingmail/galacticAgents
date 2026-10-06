# P7-04 — Web Push notifications

Design: SPEC §4.5 and decision 59 (the notification triggers), decision 90 (remote clients), decision 91 (installable app), TECHNOLOGY §2.4 (iOS push constraints). The device checks below are folded into P7-06.

## What was built

**Protocol** (`packages/protocol/src/push.ts`)

- `PushKind`: `permission`, `question`, `project_completed`, `project_failed`. It is a subset of `NotificationKind`, checked at compile time.
- Request and response schemas: `PushSubscribeRequest`, `PushEndpointRequest`, `PushDevice`, `PushStatusResponse`, `PushDeviceResponse`.
- The payload, `PushPayload`, and the `#focus=` fragment key.

**Server** (`apps/server/src/push/`)

- `vapid.ts`: the VAPID key pair.
  - It is made on first need: the first `GET /api/push`, or the first send to a device. While nobody subscribes, no key exists.
  - It is stored in `<dataDir>/vapid.json` (`~/.galactic`) with mode 0600, and the data directory gets 0700 if it is new.
  - A copy that others can read is set back to 0600 with a warning. A damaged (or lost) file is replaced, and every device must then turn push on again: the stored subscriptions are bound to the old public key, so they are cleared at once with a warning that names only how many (review fix, 2026-10-05). Pruning on a 401/403 from the push service was considered and not chosen: a 403 can also mean a passing VAPID problem, and the regeneration is the one case known to break every subscription.
  - The keys are never logged.
  - `vapidSubject`: the `sub` claim is `https://<remoteHost>` when remote access is set up, else `mailto:mission-control@galactic-agents.invalid`. `GALACTIC_PUSH_SUBJECT` overrides it. Apple refuses a localhost subject.
- `endpoint.ts`: the endpoint allow-list and device ids.
  - Only the browsers' push services are accepted: FCM (`*.googleapis.com` fcm/android), Mozilla (`*.push.services.mozilla.com`), Apple (`*.push.apple.com`) and WNS (`*.notify.windows.com`).
  - The endpoint must be `https`, with no port and no user info.
  - The device id is the first 32 hex digits of SHA-256(endpoint). The page computes the same id with WebCrypto.
- `store.ts`: `push_subscriptions` (migration `0010_push_subscriptions.sql`). Like `agent_processes`, this is device configuration, not domain state: no event, never in a snapshot.
  - One row per endpoint, holding the keys, the per-kind switches (JSON), `details`, the label, the origin (`local`/`remote`), `last_sent_at` and `last_error`.
  - The list shows ids and labels only, never an endpoint or a key.
- `service.ts`: `PushService`.
  - It subscribes to the event log and folds every committed event through the protocol's `notificationOf`: the same rules and the same ids as the page's desktop notifications (decision 59).
  - Only the four push kinds are sent, and only to devices that keep that kind on.
  - Each id is pushed once per server life, so a question that is escalated or reassigned to the user again is not pushed twice.
  - The transport is `web-push` 3.6.7: aes128gcm, VAPID-signed, 10 s timeout. TTL is 6 h for questions and permissions (a late push about something answered meanwhile is misleading) and 24 h for projects. Urgency is `high` for questions and `normal` for projects.
  - 404 and 410 remove the device.
  - 429, 5xx and network errors are retried: at most 3 attempts in all, backing off 1 s then 4 s, with `Retry-After` honoured up to 30 s.
  - Any other answer (400, 403, 413) is recorded as `lastError` and not retried.
  - At most 32 deliveries are in flight; beyond that a push is dropped with a warning. A delivery keeps its slot through its retries and back-offs, so during a push service outage the slots can fill up and pushes are dropped (best effort, by design).
  - Test push times (the per-device rate limit) are forgotten after a minute or when the device is removed.
  - Logs name a device by its id and give the status, never the endpoint (a capability URL), its keys or the payload.
  - Delivery and bookkeeping are separate (P8-12, 2026-10-06). Only the send is retried: once the push service answered 2xx, `markSent` failing (a full disk) is logged and the push counts as sent; `markFailed` failing is logged too. A 404/410 whose removal the database refuses puts the device on an in-memory "gone" list: it is skipped (no send, and the test push answers 404) and the removal is retried on each later push. New keys whose clearing is refused stay made (the file is written); the old subscriptions are skipped and the clearing retried on the next need. A storage refusal (`isStorageFailure`) logs one line per episode, naming the SQLite code; the next bookkeeping write that works logs "the database takes writes again". The "already pushed" ledger is in memory, so a notification is still pushed once per server life while nothing can be recorded. Subscribing, unsubscribing or removing a device that the storage refuses answers 507 `storage_full` (503 for the other storage failures) through the root storage-refusal handler (P8-09). Tests: `push.test.ts` "PushService on a full disk (P8-12)" (5, one over a real SQLITE_FULL) and a 507/test-push case in `routes.test.ts`.
- `routes.ts`, all bearer-guarded in their own scope:
  - `GET /api/push`: the public key, the devices and `canRemoveOthers`.
  - `PUT /api/push/subscription`: an upsert by endpoint. A bad endpoint gets 400 `invalid_endpoint`; past 20 devices a new one gets 409 `too_many_devices`.
  - `POST /api/push/unsubscribe` with `{endpoint}`.
  - `POST /api/push/test` with `{endpoint}`: 404 when the device is not subscribed, 429 within 5 s of the last test.
  - `DELETE /api/push/devices/:id`: local only unless `autoApproveRemote`, else 403 `remote_control`.
- Wiring: `index.ts` creates the service after `composeRuntime` and starts it on the log (so questions asked while agents resume are pushed too), and stops it on shutdown. `app.ts` takes a `push` option.

**Web** (`apps/web/src/pwa/`)

- `sw.js`, an additive block after the fetch handler:
  - `push`: it parses and validates the payload (id, title, a known target kind, clipped lengths). It always calls `showNotification` (review fix: Safari on iOS counts a push that does not as a silent push and revokes the subscription). If a notification with the same tag is already on screen, it is replaced in place with `renotify: false` and keeps its text (the page's may carry details the push leaves out). Otherwise it shows `title`, then `body` or "Open GalacticAgents to see it.", with `tag = id`, `data = {id, target}` and the 192 px icon.
  - A missing or foreign payload still shows a generic "GalacticAgents" notification, never a silent push.
  - `notificationclick`: it closes the notification. If one of our windows is open (focused first, then visible, then any), it focuses it and posts `{type: 'NOTIFICATION_CLICK', target}`. Otherwise it calls `clients.openWindow('/#focus=<kind>:<id>')`, or `#focus=inbox` when there is no target.
- `notification-clicks.ts` (wired in `main.tsx`):
  - It takes `#focus=` from the address bar and strips it, keeping other fragment keys.
  - It listens for the worker's `NOTIFICATION_CLICK`.
  - Both paths call P25-07's `focusTarget` once the first snapshot has arrived.
- `push.ts`:
  - Support detection: `supported`, `ios-install` (iPhone or iPad in Safari, not installed), `insecure`, `unsupported`.
  - The device id, the device label (for example "iPhone · Safari (Home Screen)"), key decoding and the `/api/push*` client.
  - `syncPush`: on each session start, if push was turned on in this browser and the browser holds a subscription the server does not know, it looks at the device id it remembers (`galactic.push.device` keeps the id — the endpoint's SHA-256 prefix, never the endpoint — with the switches). A different id means the push service rotated the subscription: it is handed over again with the remembered switches. The same id (or none, from a build before the review fix) means the server forgot this very subscription — the Mac's "Remove device", or a prune after the push service said it was gone: the browser forgets its choice and drops the local subscription, and the settings show push off. (Review fix, 2026-10-05: before, the phone's next app open re-subscribed and undid the removal.) It never prompts and never subscribes anew.
  - Removing a device is not a revocation: a lost phone that still holds a valid token can turn push on again from its settings. Cutting it off needs a token reset (decision 90).
- `PushSettings.tsx`: settings → "Push notifications" (its own section under the desktop notifications).
  - Each unavailable state gets its explanation; the iOS one says "tap Share, then Add to Home Screen…".
  - "Turn on push notifications" calls `pushManager.subscribe` as the first await of the click. The browser's prompt opens there and nowhere else.
  - Four kind switches and "Show project names and question text (visible on the lock screen)", off by default.
  - "Send a test push" and "Turn off".
  - Other devices are listed, with "Remove" only when `canRemoveOthers`.
  - Results are announced in `role=status`, errors in `role=alert`.
- `panel/notifications/notifier.ts` (P25-07, minimal change): when a service worker is registered, the page's desktop notifications are shown with `registration.showNotification`, with the same tag and data as before. Otherwise it falls back to `new Notification`. See "One notification per device" below.

## Decisions taken here

### One notification per device, also while the app is open

The conservative answer to the SPEC §8 question of 2026-10-03 is that notifications show even while the panel is in front. Push follows it: a push is always shown, and the device never shows the same notification twice.

- The page's notifications and pushes share one tag space: the `notificationOf` id, shown through the same service worker registration. Chrome keeps a page's `new Notification` and a worker's notifications in separate tag spaces, which is why the page now shows through the worker.
- Whichever arrives second replaces the first in place: same tag, `renotify: false`, no second alert. (Review fix, 2026-10-05: it used to do nothing, which Safari counts as a silent push. A repeat push keeps the text already on screen; the page always shows its own, so an updated backfill summary — "N more updates" — replaces the older count.)
- While a new worker is installing or waiting, the active one may predate the `notificationclick` handler, so the page shows its own `new Notification` (whose `onclick` it handles) and uses the worker only when the browser refuses that (mobile).
- Pushes are never silent: Chrome replaces a silent push with its own "site updated in the background" notice, and Safari revokes the subscription after a few.
- Side effect: Android Chrome, which refuses `new Notification`, now shows the page's desktop notifications too. This was the item P25-07 deferred.
- Remaining gap: if the user dismisses the page's notification in the second or so before the push about the same thing arrives, the push shows it again.

### Lock-screen content

- The payload is minimal: the kind's own title ("A question for you", "Permission needed", "Project finished", "Project failed"), the id, the target and the time.
- The body, meaning the question's text (secrets redacted, clipped to 120 characters) or the project's name, is sent only to a device that ticked "Show project names and question text". It is off by default.
- Without it, the notification says "Open GalacticAgents to see it."
- The payload is encrypted to the device: the push service cannot read it. It never carries a token, and the tap opens `/#focus=…`, which holds no credential.

### Per device, stored on the server

- Desktop notification switches stay in the browser (decision 59).
- Push switches must live on the server, because the server decides what to send while the page is closed. They are stored with the subscription, and only the browser holding that subscription can change them, since every change names the endpoint.
- The browser keeps a copy (with the device id, not the endpoint) only to hand a rotated subscription over again, and to tell a rotation from a removal.

### Remote clients (decision 90)

- A remote client may subscribe, change, test and unsubscribe its own device: push is per device, not a server-wide setting.
- Removing another device is the Mac's, like the other controls that silence or stop something elsewhere, unless `autoApproveRemote`.

### Which kinds

- Push carries the four kinds the task names: question, permission, project finished, project failed.
- Task finished/failed, interrupted work and "no free body" stay on the page's desktop notifications. They are frequent or desk-bound, and the phone's lock screen is not the place for them.
- No new trigger was invented: the kinds are a subset of `notificationOf`'s.

### SSRF guard

- The server POSTs to whatever endpoint a client registers, so only the known push services are accepted. They are listed in `endpoint.ts`.
- A new browser's push service would need a code change. That is deliberate.

## SPEC text (recorded as SPEC decision 95 and the §8 row, 2026-10-05)

**Decision 95 — Push notifications on the phone** (§4.5; refines decision 59; decisions 90, 91):

> A device can receive push notifications while GalacticAgents is closed: a question or a permission request waiting for the user, a project that finished or failed — the other notifications stay on the open page. Each device turns push on for itself in the settings ("Turn on push notifications"); only that click asks the browser's permission, and on iPhone and iPad only the app added to the Home Screen can (the settings say so). Each device keeps its own switches, one per kind, and chooses whether its notifications show project names and question text; by default they do not, and the lock screen says only what happened ("A question for you", "Project finished"). The phone manages its own device like the Mac does; removing another device's push works only from the Mac (decision 90). A device shows one notification per event — a push and the open page's own notification for the same question are one notification, the later one replacing the earlier in place without alerting again — and a push is shown even while the app is in front (as desktop notifications are, §8 2026-10-03). Tapping one opens GalacticAgents at the item, as a desktop notification's click does (decision 59). Push is best effort: a question not delivered within six hours, or a project's end within a day, is not delivered later; a device that no longer exists is forgotten.

**SPEC §8, update the 2026-10-03 row** ("suppress while focused"): add "Push follows the same answer (Decision 95): a push is always shown, one notification per device by id; suppressing in front would need the page to tell the worker, and Safari revokes subscriptions that receive silent pushes."

## TECHNOLOGY

§2.4's push bullet now describes what was built: keys, endpoints, sending, worker handlers, dedup and click routing. §8 gains one bullet on push secrets and the endpoint allow-list.

## Shared files touched (exact)

- `apps/web/src/pwa/sw.js`: one block appended after the `fetch` listener. Nothing above it changed.
- `apps/web/src/main.tsx`: one import and `wireNotificationClicks()` after `registerPwa()`.
- `apps/web/src/client/session.ts`: one import and `void syncPush(token)` after `client.connect()`.
- `apps/web/src/panel/settings/SettingsPage.tsx`: one import and a "Push notifications" `<section>` after the Notifications section.
- `apps/web/src/panel/notifications/notifier.ts`: `showNotification` tries the worker first. The page path (`showFromPage`) is the old body, unchanged.
- `apps/server/src/app.ts` (+7) and `apps/server/src/index.ts` (+8): the wiring.
- `packages/protocol/src/index.ts`: `export * from './push.js'`.
- `apps/server/package.json` and `pnpm-lock.yaml`:
  - `web-push ^3.6.7` (MPL-2.0; dependencies `asn1.js`, `http_ece`, `https-proxy-agent`, `jws`, `minimist`).
  - Development only: `@types/web-push` and `http_ece` 1.2.0 (the test decrypts a real request).
- Migration number: **0010**. If P7-07 adds a migration too, the second one to merge renumbers to 0011.

## Tests

- Protocol `push.test.ts` (4): the kinds are a subset of `NotificationKind`; subscriptions are validated; unknown keys (a token) are stripped from a payload; endpoints are never listed.
- Server `push/push.test.ts` (17):
  - Keys: made at 0600, reused, loosened permissions tightened, a damaged file replaced; warnings never carry a key; the subject.
  - The endpoint allow-list, including look-alike hosts, ports and user info; the device id.
  - The store's upsert and listing.
  - Sending:
    - the right kinds go to the right devices;
    - details off sends no body, and details on gets a redacted one;
    - nothing for tasks, interrupted work, a parked request or a question held by an agent;
    - a question escalated twice is pushed once;
    - 404/410 prune;
    - 429 with `Retry-After`, network and 503 retries are bounded to 3; 403 is recorded;
    - logs carry ids, never endpoints;
    - an unsubscribe during a retry stops it;
    - the in-flight cap;
    - the test push and its rate limit; its times are pruned after a minute or with the device;
    - new keys (a lost or damaged `vapid.json`) clear the stored subscriptions with a warning that carries no secret; `onCreate` fires on a new pair only;
    - no key is made without subscribers;
    - stop.
  - The real `web-push` request is decrypted with the device's private key and auth secret (`http_ece`): aes128gcm, VAPID `k=` is our key, and the payload is not in clear.
  - `WebPushError` is mapped to its status only, never the endpoint.
- Server `push/routes.test.ts` (6):
  - every route is 401 without the token;
  - GET makes the key at 0600 and lists without endpoints or keys, and neither the private key nor an endpoint is logged;
  - a phone through Serve headers subscribes (origin `remote`), updates, tests (then 429), unsubscribes, then 404;
  - an endpoint that is not a push service gets 400, an `http` one fails validation;
  - deleting another device is 403 from the phone and allowed from the Mac, and with `autoApproveRemote`;
  - the 20-device cap still lets an existing device update.
- Web:
  - `pwa/sw-push.test.ts` (9): shows with the tag; the detailed body; a tag already on screen is replaced in place (one notification, the earlier text kept, `renotify: false`); every push calls `showNotification`; a generic notification for a missing, foreign or invalid payload; an unknown target is dropped and fields are clipped; a tap focuses the focused window and posts to it; with no window it opens `/#focus=` (no token); a window that refuses focus still gets the message.
  - `pwa/push.test.ts` (10): support, including the iOS install caveat; the device id equals the server's SHA-256; the label; key decoding and comparison; the remembered switches; the rotated-subscription re-sync, which never subscribes anew; a removed device (same id) is not re-sent and push stays off, also for a remembered choice without an id; a known subscription's id is learnt; a stale key is not re-sent.
  - `pwa/PushSettings.test.tsx` (7): the iOS explanation; the development (no worker) explanation; the prompt only on the click, with the server key and `userVisibleOnly`; the switches, details, test and turn off; other devices removable only when `canRemoveOthers`; the blocked permission and a failed call (alert); retry after a read failure. Axe shows no serious or critical findings in the off, on, other-devices and iOS states.
  - `pwa/notification-clicks.test.ts` (3): `#focus=` parsing and stripping (other keys and `#token=` kept); waiting for the first snapshot; worker messages, with junk going to the inbox.
  - `panel/notifications/notifier-worker.test.ts` (6): through the worker with tag and data; replaces in place what a push already showed; an updated backfill summary replaces the older one; the page's `Notification` while a worker is installing or waiting, the worker when the page cannot; falls back to `new Notification` without a registration or when the worker fails.
- Full gates on `p7-04-push`: build, typecheck, lint and format:check are clean. Tests: protocol 74, server 1029 (+1 skipped), web 1598, all passing.

## Verified in headless Chrome (CDP), production build

The real server ran on `127.0.0.1:47815` with `GALACTIC_DEV=1` and `GALACTIC_HARMONIZER=off`. Google Chrome ran headless (`--headless=new`) with its own profile on CDP port 9333, and notifications were granted through `Browser.grantPermissions`. The script is in the session's scratchpad (`p704/check.mjs`). Results:

- The worker controls the page, and `#token=` is gone from the address.
- `GET /api/push` returns the public key, and `vapid.json` is created with mode **0600**. The route answers 401 without the token.
- **A real subscription works in headless Chrome**, on `fcm.googleapis.com`. The settings' "Turn on push notifications", clicked with a real mouse event, subscribed and saved the device "Mac · Chrome". "Turn off" removed it.
- **End to end through Google's push service.**
  - With the panel open and its desktop notifications on, a permission question opened through `/dev/harness` produced exactly **one** notification. It carried the page's text, the push's `lastSentAt` was set, and the push saw the tag and added nothing. (Before the review fix; the push now replaces it in place with the same text and no second alert.)
  - With no app page open (only `/icons/icon.svg` on the origin), another permission question arrived **by push alone**: "Permission needed", "Open GalacticAgents to see it.", no question text (details off).
- A fake FCM endpoint got **410 from Google** and the server removed the device.
- The server log contains no endpoint, no private key and no token. The push lines read `push: device <id> is no longer subscribed (410); removed`.
- **Not verified:**
  - CDP's synthetic `ServiceWorker.deliverPushMessage` showed nothing on a fresh profile in three runs, though it worked once on a profile that already had a subscription. It was not pursued further: the real FCM path above covers it, and the handler's details are unit-tested.
  - A notification tap (CDP cannot click an OS notification); it is unit-tested.
  - Safari, iOS and Android.

## Manual device checklist (Cosmin; folded into P7-06)

Prerequisites:

- P7-02's Tailscale Serve (HTTPS on the ts.net name) and `remoteHost` set (it also becomes the VAPID subject).
- `pnpm build`, then `galactic start`.
- The phone has the app installed (P7-01 checklist).

iPhone (iOS 16.4 or later):

1. In Safari (not installed), Settings → Push notifications says "tap Share, then Add to Home Screen…". There is no Turn on button.
2. From the Home Screen app: Settings → Push notifications → **Turn on push notifications**. iOS asks for permission now, not before. Allow. The block shows "On for this device (iPhone · Safari (Home Screen))". If no prompt appears, note it: the click calls `pushManager.subscribe` directly, and some iOS versions may want `Notification.requestPermission()` first.
3. **Send a test push**: "Push notifications work on this device." arrives within seconds.
4. Lock the phone. On the Mac, make a Steward ask a permission (the cautious `permission` fake scenario, or a real `rm -rf`). The lock screen shows "Permission needed — Open GalacticAgents to see it.", with no command text. Tap it, unlock: the app opens on the thread holding the card (decision 55).
5. Tick "Show project names and question text", lock, and ask another question: the text now shows on the lock screen. Untick it.
6. Close a project on the Mac (or let one fail): "Project finished" / "Project failed" arrives. Untick "A project finished" and close another: nothing arrives.
7. With the app open in front, ask a question: exactly one notification (or none at all, if iOS hides notifications of the foreground app; note which).
8. Settings → **Turn off**: nothing arrives any more. The Mac's settings no longer list the iPhone.

Android (Chrome, installed or not):

9. Repeat 2–8 (the prompt is Chrome's). Also with the app closed (swiped away) and the phone in Doze for a few minutes: the question arrives (urgency `high`).

Mac:

10. Settings shows the phone under "Other devices with push" with **Remove**. On the phone, the same list shows no Remove button (decision 90). Remove the phone from the Mac: on the next question, the phone gets nothing.
11. Delete `~/.galactic/vapid.json`, restart, and ask a question: devices get nothing and keep `lastError` (403 from FCM, or `BadJwtToken` from Apple). Turning push on again on each device fixes it. Check that `ls -l ~/.galactic/vapid.json` shows `-rw-------`.
12. `grep` the server log for the phone's endpoint host path and for the private key in `vapid.json`: no match.

## Left for later

- `pushsubscriptionchange` is not handled in the worker, which has no token to call the server with. A rotated subscription is handed over on the next app open (`syncPush`) and is missed until then.
- Desktop pushes to the Mac's own browser work too (Chrome over FCM). Whether the Mac's browser should be offered push at all is not decided; it is harmless.
- A push about a question answered meanwhile is not withdrawn: the push service cannot recall it. The 6 h TTL bounds it.
- Rate-limiting pushes to one device beyond the in-flight cap: a burst of 30 questions gives 30 pushes.
