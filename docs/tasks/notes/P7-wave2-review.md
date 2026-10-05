# Phase 7 wave 2 review (P7-04, P7-05, P7-07)

Review of `phase-7...p7-wave2-push-offline-demo`, 2026-10-05. No blockers. Fixes landed on
`p7-wave2-review-fixes` and were merged into the batch branch; gates green afterwards (protocol 82,
server 1050 + 1 skipped, web 1645; web suite re-run twice more, no flakes).

## Should-fix (all fixed)

1. **iOS could revoke push.** The worker skipped a push whose tag was already on screen — a silent
   push to Safari. It now always shows, replacing in place without alerting again (SPEC 95).
2. **"Remove device" on the Mac did not stick.** The phone re-subscribed on its next session. The
   device id is remembered; same endpoint unknown to the server means removed, and push stays off.
   A lost phone holding the token can still turn push on — cutting it off needs a token reset.
3. **A transient 5xx/408/429 dropped a queued answer.** Now retried with the same answer id.
4. **The proposal card offered demo or orbit-less planets.** `isCatalogued` moved to the protocol
   package and is used by the server and the card.
5. **Old clients looped on unknown event types** (e.g. `body.retired`). Clients now skip an
   unknown event type with a valid envelope (seq advanced, warning logged); malformed known events
   still close the stream. Protects future builds; tabs on an old bundle need one reload
   (TECHNOLOGY §6.3 "Protocol evolution").
6. **Flaky offline-answers test** made deterministic (and a PushSettings test that clicked
   disabled controls under load).

## Nits (fixed)

Another tab's in-flight sends are left alone; page notifications fall back to `new Notification`
while a worker update is pending; subscriptions are cleared when VAPID keys are regenerated; test
push timestamps pruned; retry slots documented as best effort; decision references cite 95/96;
the P7-07 notes name the "Demo project N in /tmp/galactic-demo-N" caveat.

## Checked and OK

VAPID key 0600 and never logged; endpoint allow-list (IDN, trailing dot, ports, userinfo,
suffix boundary, no redirects); lock screen shows generic titles unless details are on; a
notification tap can only open the app itself; decision 90 on push routes; no re-push after a
restart; answer idempotency (per question, no deadlock); Clear demo never touches real work or
harness rows; migration numbering.

## Left open

- All device checks (push on a locked iPhone/Android, the offline queue on a real phone) — P7-06.
- `pushsubscriptionchange` is not handled (a rotated subscription is re-sent on the next app open).
- Pushes are not withdrawn when a question is answered elsewhere (bounded by the 6 h expiry).
