# P25-07 — Desktop notifications

## What was built

Desktop notifications in the browser, all under `apps/web/src/panel/notifications/`:

| File | What it does |
| --- | --- |
| `notifier.ts` | `createNotifier({token})`. It folds every stream message through the protocol's `notificationOf` after the store has applied it, so names come from the updated world. On a snapshot it backfills `GET /api/notifications?after=`. `showNotification` creates the `Notification`, using the notification id as its `tag`, and handles the click. |
| `ledger.ts` | A per-browser ledger in `localStorage` (`galactic.notifications.ledger`): `{logId, seq, ids}`, holding the last 500 ids. Every read goes to storage, so tabs share it. If storage fails, it falls back to memory. |
| `prefs.ts` | A zustand store `useNotificationPrefs` saved in `localStorage` (`galactic.notifications.prefs`): `enabled` (the user's opt-in), `kinds` (one boolean per `NotificationKind`, all on by default), and `permission` (`default` / `granted` / `denied` / `unsupported`). `enable()` calls `Notification.requestPermission()` only when the permission is still `default`, and only the Enable button's click calls it. |
| `focus.ts` | `focusFor(world, target)` (pure) and `focusTarget(target)`, which focuses the window, navigates, and scrolls the inbox into view when needed. |
| `NotificationSettings.tsx` | A self-contained settings block: browser status, Enable / Turn off / Send a test, and eight per-kind checkboxes. |
| `NotificationsControl.tsx` | The top bar button "Notifications: on/off/blocked/unavailable". It opens a popover with `NotificationSettings`, and Escape or a click outside closes it. |
| `notifications.css`, `index.ts`, `fake-notification.ts` | Styles (they reuse the panel's `--pnl-*` tokens and have fallbacks), the exports, and the test double. |

### Rules

- **Triggers.** Exactly `notificationOf`'s list (SPEC §4.5): a question or permission held by the user (opened, escalated or reassigned to them); task or project completed or failed; `recovery.needs_attention`; `proposal.parked` with `waitingFor`.
- **Dedup.**
  - Ids come from `notificationOf` on both paths: the live stream and the REST backfill.
  - The ledger skips an event whose `seq` is at or below the stored `seq`, and any id already handled. A question has one id however often it reaches the user, so it notifies once.
  - The `tag` makes the OS replace a duplicate rather than stack it.
  - Two tabs share the ledger, so only one of them notifies.
- **First sight of a log: no replay.** A fresh browser, cleared storage or a new database (`logId` changed) takes the snapshot as the baseline. Nothing older is notified and nothing is fetched.
- **Reload, or a reconnect answered with a snapshot.**
  - When the log is the same and the snapshot is past the ledger's `seq`, the client backfills `after=<ledger seq>`: pages of 100, at most 10 pages.
  - Only notifications at most 24 h old are shown. The server already leaves out questions answered meanwhile.
  - At most 5 are shown one by one, chosen permission first, then question, then interrupted, then the rest, newest first. Anything beyond that becomes one summary notification, "N more updates while the page was closed".
  - The ledger's `seq` moves forward before the fetch, so a reload during a backfill loses that backfill rather than notifying twice.
- **While off** (not enabled, browser refused, or unsupported):
  - Nothing is shown and no backfill is fetched.
  - The ledger still advances, so turning notifications on later notifies only what happens from then on.
  - A kind switched off is marked handled. It is never notified later.
- **Click targets** (decisions 53 and 55):
  - A question opens the thread that holds its card: the project's current Waykeeper, else the Harmonizer. An unknown question opens the Harmonizer with the inbox scrolled into view.
  - A task opens its Steward (the newest live one, else the newest), else its project's Waykeeper, else the Harmonizer.
  - A project opens its Waykeeper.
  - An interrupted agent opens its own view.
  - A parked request opens the Harmonizer with the inbox in view.
  - The backfill summary also opens the Harmonizer with the inbox in view.
- Notifications show even while the panel's tab is focused (see Deferred).

## Proposed SPEC text

**SPEC §7, decision 59: Desktop notifications (2026-10-03, P25-07; §4.5).**

> Desktop notifications are per browser. The user turns them on with "Enable desktop notifications" in the top bar or on the settings page. Only that click asks the browser for permission. A refusal is explained ("allow them in the browser's site settings"), and a browser without notifications says so. One switch per kind (permission, question, task finished, task failed, project finished, project failed, interrupted work, no free body) is kept in that browser only.
>
> Each trigger notifies once per browser: never again on a reload, a reconnect or a second tab, and a question once however often it reaches the user. Opening the page never replays history. What happened while the page was closed is shown on the next load only if it is still current (an answered question is not raised) and at most a day old. The five most important (permissions, then questions, then interrupted work, then the newest of the rest) are shown one by one, and the rest are folded into one "N more updates" notification. While notifications are off, nothing is saved up for later.
>
> A click focuses the panel and selects the item: a question opens the thread showing its card (decision 55), else the inbox; a task or project opens the agent working on it (decision 53); interrupted work opens that agent; a request waiting for a free body opens the Harmonizer with the inbox.

**SPEC §8, new open question:** "Should desktop notifications be suppressed while the panel's tab is focused and visible? Today they always show (the conservative choice: nothing is missed). Revisit after the P25-09 dogfood run."

## Proposed TECHNOLOGY text

**§6.3, append after "Panel endpoints (P25-01)":**

> **Desktop notifications (P25-07).**
>
> - `apps/web/src/panel/notifications/`. `createNotifier` is wired in `startSession`, next to the store, and folds each message after the store applies it. It calls the protocol's `notificationOf` with lookups into the client world.
> - A per-browser ledger in `localStorage` (`galactic.notifications.ledger`: `logId`, last `seq`, last 500 ids) dedupes by `seq` and by id, across reloads and tabs. The `Notification` `tag` is the id.
> - A snapshot of a log the ledger has not seen sets the baseline and backfills nothing. A snapshot of the same log past the ledger's `seq` backfills `GET /api/notifications?after=` (≤ 10 pages of 100, ≤ 24 h old, 5 shown plus one summary).
> - Preferences (`galactic.notifications.prefs`: `enabled`, per-kind booleans) are per device and never sent to the server.
> - `Notification.requestPermission` is called only from the Enable button's click.

## Shared files touched (exact)

- `apps/web/src/client/session.ts`: imports `createNotifier`; creates it in `startSession`; `onMessage` now calls `apply(m)` then `notifier.onMessage(m)`; the stop function calls `notifier.stop()`. +8/−1.
- `apps/web/src/panel/Panel.tsx`: imports `NotificationsControl` and renders `<NotificationsControl />` in `TopBar` right after `<span className="pnl-spacer" />`. +2.
- `apps/web/src/state/conversation.ts`: `questionOwner` and the `QuestionOwner` type are now `export`ed (two words; no behaviour change).
- Not touched: `store.ts`, `console/api.ts` (the backfill uses its own `fetch` with the bearer token), and the protocol or server code.

## For P25-08 (settings page)

- Mount it with `import { NotificationSettings } from './notifications/NotificationSettings.js'` (or from `./notifications/index.js`), then `<NotificationSettings />`.
- It needs no props, context or API. Its state is the browser's own (`useNotificationPrefs`). It imports its own CSS.
- `heading` defaults to `true` and renders an `<h3>Desktop notifications</h3>`. Pass `heading={false}` if the page provides its own heading.
- It renders `<section aria-label="desktop notifications">`.
- The top bar popover keeps working whether or not the settings page mounts it too. Both views share one store, so they stay in sync.

## Deferred

- **Suppress while focused.** Not done (§8 question above).
- **Service-worker notifications** (needed by some mobile browsers, which refuse `new Notification`) and phone push come with Phase 7's PWA. The constructor is wrapped in try/catch, so those browsers simply show nothing.
- **Cross-tab live sync of the preferences.** Another tab's change is read on its next reload (`useNotificationPrefs.reload` exists; there is no `storage` event listener yet).
- **Backfill on a reconnect while the page is closed beyond 24 h** shows nothing older. The inbox still lists every open question.

## Tests

`apps/web/src/panel/notifications/notifier.test.ts` (15) and `NotificationSettings.test.tsx` (5), Vitest with jsdom and a fake `Notification` global:

- each of the seven trigger events notifies exactly once, with a title and body;
- a question escalated, reassigned and escalated again notifies once;
- the first load of a log replays nothing and fetches nothing;
- a reconnect answered by a snapshot backfills the gap with no duplicates and nothing missed;
- a resumed stream that repeats events causes no duplicates;
- a reload backfills only what is new, and a second reload does nothing;
- a second tab does not notify again;
- the backfill caps: the 24 h age limit, 5 shown in importance order, and the summary;
- a kind switched off is suppressed and marked handled;
- while off, the cursor advances, and after enabling only new events notify;
- a browser that refused permission shows nothing;
- a new `logId` starts a new baseline;
- every click target (question, task, asteroid task, project, interrupted agent, parked request), plus `focusFor` fallbacks;
- the permission prompt opens only on the Enable click and not again once granted; refused and unsupported states; per-kind switches persist;
- end to end in the panel (`App` over the fake socket): enable from the top bar popover, a streamed question notifies, and the click selects the Waykeeper's thread and updates the URL.

Full gates on the branch: build, typecheck, lint and format:check are clean. Tests: protocol 61, server 828 (+1 skipped), web 164, all passing.
