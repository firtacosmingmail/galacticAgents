# P25-08 — Settings page and first-run preflight

## What was built

All new UI is in `apps/web/src/panel/settings/`, on top of P25-01's endpoints (`GET`/`PATCH /api/settings`, `GET /api/preflight[?refresh=1]`).

| File | What |
| --- | --- |
| `SettingsData.tsx` | `SettingsProvider` / `useSettingsData()`. The panel reads `GET /api/settings` once, and the page and the first-run gate share that copy. Every write goes through `patch()`, and the reply replaces the copy. The state is `loading`, `ready`, `unavailable` (404, a reply that is not a settings reply, or a stand-in api without the method) or `error` (shown with a retry). |
| `sections.tsx` | One spec per setting (`PROJECTS_ROOT`, `PERMISSION_POLICY`, `RETENTION`, `CAPS`, `QUALITY_TIER`, `STEWARD_SOURCES`), each with its editor, a client-side check and the patch it sends. `useSection(spec)` holds the draft over the saved value, the client error, the server refusal, the notice and the locked/restart flags. `SectionFrame` renders all of it. The page and the wizard use the same specs, so they validate and word errors identically. |
| `settings-model.ts` | The pure parts: the §3.6 table rows (plus decision 49's `unclassified`), the decision-51 restart fields, the env-variable names, validators, the caps draft (wall-clock edited in minutes, decimals allowed), `changedCaps`, `refusalMessage()` and `isSettingsResponse()`. |
| `PreflightCheck.tsx` | The runtime check. For each runtime it shows installed, logged in, the login (auth method · subscription), the provider, the Claude Code and Agent SDK versions, and each problem with its severity and **Fix:**. "Check again" calls `?refresh=1`. |
| `AccessToken.tsx` | The token, masked to its last 4 characters (fully masked when shorter than 12) until "Reveal" is clicked. "Copy" uses the clipboard. A dashed QR placeholder stands in for Phase 7. The token is never put in a URL, a log or an attribute. |
| `SettingsPage.tsx` | `/settings`: the runtime check, the six setting sections (each with its own Save), **Notifications** (mounts P25-07's `<NotificationSettings heading={false} />` under the page's own heading), and Access. |
| `FirstRunWizard.tsx` | The steps: Runtime check → Projects root → Default permission policy → Retention period → Caps → Rendering quality → Stewards' settings sources → Done ("Open the panel"). "Skip setup — keep the defaults" is available on every step; a refused skip is shown next to it at once, with "Continue without saving that setup is done". |
| `FirstRunGate.tsx` | Shows the wizard in place of the panel's three columns while the setup is not done and this client may finish it (see below). On finishing, it navigates to `/` with the Harmonizer selected. |
| `settings.css` | Uses the panel's tokens. Works in dark and light. One column, at most 820 px wide. |

### Behaviour

- **First run.** The marker is on the server, not per browser. A new `setupCompleted: true` patch stamps `setupCompletedAt` (ISO) in `config.json`. The stamp is written once and never moved or cleared. `GET /api/settings` reports it.
  - The wizard shows **only** when the server's reply is a valid settings reply without `setupCompletedAt` and with `writable` absent or `all`.
  - **Who may finish it (review fix).** `SettingsResponse.writable` (`all` | `limited`, optional) is computed by the server from the request's origin exactly as the patch decides (`writableFor`: `limited` for a remote or unknown-origin request unless `autoApproveRemote`). It is on the `GET` and on every patch reply. A `limited` client with no marker gets the panel with a dismissible note, "Setup is not finished — finish it on the computer running Mission Control" (per page life), instead of a wizard whose marker it could never save. Absent (an older server) counts as `all`.
  - **While loading** the gated area renders nothing (no flash of the panel before the wizard). On a 404 or an older server, on a failed read, or with a `{}` stub, the panel shows as before. So the wizard is something the server offers, never a wall in front of a working panel. One existing test (`Panel.test.tsx`, back from `/debug`) now awaits the navigation, since the remounted panel waits for its settings read.
  - Finishing and skipping both stamp the marker. A refusal of the marker is shown at once next to the Skip button on whatever step it happened (and on the Done step for "Open the panel"), with "Continue without saving that setup is done", which lets this page life through.
  - `config.json`'s `setupCompletedAt` is read leniently (any non-empty string), so a hand-edited value does not stop the server; it is still written as ISO, and `response()` reports a parseable date normalised to ISO and anything else as the epoch (setup still done).
  - An install that existed before this change has no marker, so it sees the wizard once. That is deliberate: every step is pre-filled with the current settings and "Skip" is one click.
- **Preflight in the wizard.** Errors do not block the setup. The button reads "Continue anyway", with a note that agents cannot run until the problems are fixed. That follows SPEC §4.6: a fixable message, not a crash and not a dead end.
- **Saving.** On the page, each section has its own Save, enabled only when the section is dirty, valid on the client and not locked. In the wizard, "Next" saves only a changed section ("Save and continue") and stays on the step if the server refuses.
- **Client validation** is a courtesy; the server stays the authority.
  - Projects root: absolute or `~/…`; not `/`, not `~` itself.
  - Retention: more than 0 and at most 3650 days.
  - Caps: whole numbers within the protocol's bounds, with an error on each field. The wall-clock cap is in minutes and may be decimal: `Math.round(minutes × 60000)` ms is checked against the protocol schema, so every value the server accepts (90 000 ms = 1.5 min) is accepted, and a field left untouched keeps its stored value exactly. Save sends only the caps that changed (the server merges caps key by key).
- **Server refusals** are shown in the section that sent them (`role="alert"`):
  - 400 `invalid_body`: "Not accepted by the server — path: message", from the zod `issues`. `ApiError` now carries the error body.
  - 400 `invalid`: "Not accepted: <server message>".
  - 403 `remote_settings`: "Only on the computer running Mission Control: …".
  - 409 `env_override`: "Fixed by an environment variable: …".
  - Anything else: "Could not save (status)". A network failure: "Could not reach Mission Control".
- **Restart to apply (decision 51).**
  - `projectsRoot` and `stewardsLoadUserSettings` always carry an "applies at the next start" tag.
  - When the server lists one in `restartRequired`, the section says "Saved — restart Mission Control to apply".
- **Env-fixed fields.** A field in `envOverrides` gets a "read-only" tag, disabled inputs and a note naming the variable (`GALACTIC_PROJECTS_ROOT`, `GALACTIC_RETENTION_DAYS`, `GALACTIC_MAX_*`).
- **Policy editor (decision 50).**
  - One allow/ask/deny select per §3.6 category, plus "calls the engine cannot classify".
  - A changed row is bold and shows "default: <value>".
  - "Reset to the default table" sends `defaultPermissionPolicy: null`. It is disabled when both the saved table and the draft already equal §3.6.
  - A `floored` reply says the write was held to the current default.
- **Projects-root "picker".** A text field. A browser cannot hand over an absolute folder path, and a native picker would need a server-side directory browser (deferred).
- **URL.** `/settings` is a new `Route` (`'settings'`), handled by `pathFor`/`locationFromPath`. Anything under it, like `/settings/x`, falls back to the panel like other unknown paths. The server's SPA fallback already serves `index.html` for it. The page is reached from a **Settings** link in the top bar and leaves through "← Back to the panel", which keeps the selection.

## Proposed SPEC text (product; recorded as SPEC decision 60, §4.6 and decision 53; TECHNOLOGY §6.3)

**SPEC §7, new decision — First-run setup (2026-10-03, P25-08; refines §4.6, 51).** On first run the panel shows a setup wizard instead of the panel: the runtime check, then the projects root, the default permission table, the retention period, the caps, the rendering quality and the Stewards' settings sources, each pre-filled with the current value, then the panel. A runtime problem is shown with its fix and a "check again" button, and does not block the setup ("continue anyway"). Finishing or skipping the wizard marks the setup done on the server (`config.json`), so it does not come back in this or another browser. Like every setting except the tier and the policy, only a local request can mark it (decision 51). The wizard appears only when the server positively reports the setup as not done: while the settings load, or when they cannot be read, the panel is shown. An installation from before this decision sees the wizard once. Desktop notifications are not a wizard step: the browser's permission prompt needs a click and the choice belongs to each browser; they are on the settings page.

**SPEC §4.6, append:** "The settings page (`/settings`, reached from the top bar) shows the runtime check with a re-check, every setting with its own save, the desktop-notification toggles of this browser, and the access token (masked unless revealed; a QR code for connecting a phone comes with remote access in Phase 7). A refused change is explained next to the setting it concerns."

**SPEC decision 53, append:** "The settings page lives at `/settings`, in the panel's frame."

## Proposed TECHNOLOGY text (technical)

**TECHNOLOGY §6.3, append to "Panel endpoints (P25-01)":**

> - First-run marker (P25-08): `SettingsPatch.setupCompleted: true` stamps `setupCompletedAt` (ISO) in `config.json` once, and it is never moved or cleared. `SettingsResponse.setupCompletedAt` reports it, and `ConfigFile`/`ServerConfig` carry it. Only local requests may set it (it is not in the remote-writable list), so a remote client gets 403 `remote_settings`. The web client shows its wizard only for a valid settings reply without the marker.

**TECHNOLOGY §2.1 or the web section, add:** "The settings page and first-run wizard (`apps/web/src/panel/settings/`) share one `SettingsProvider` per panel. They also share one spec per setting (editor, client check, patch), so the page and the wizard validate and word refusals the same way, and the server stays the authority. `ApiError` carries the error body, which holds the zod `issues` of a 400."

## Shared files touched (exact)

- `packages/protocol/src/panel.ts`: `SettingsPatch.setupCompleted` (optional literal `true`), `SettingsResponse.setupCompletedAt` (optional timestamp) and `SettingsResponse.writable` (optional `all` | `limited`, review fix). All additive.
- `apps/server/src/http/panel-routes.ts` (review fix): the settings `GET` and `PATCH` replies carry `writable`.
- `apps/server/src/config/config.ts`: `ConfigFile.setupCompletedAt` (a lenient non-empty string since the review), `ServerConfig.setupCompletedAt`, and `loadConfig` copies it.
- `apps/server/src/config/settings.ts`: `writableFor(write)` (review fix, also used by `update()`), `response()` reports the marker (normalised to ISO), `update()` stamps it once, `persist()` writes it, and the doc comment mentions it.
- `apps/server/src/http/panel-routes.test.ts`: one new test and a `loadConfig` import.
- `apps/web/src/console/api.ts`:
  - `ApiError` gains an optional 4th `body` parameter (the error JSON);
  - `call` accepts `PATCH`;
  - three new methods at the end: `settings()`, `patchSettings(patch)` and `preflight(refresh?)`.
- `apps/web/src/state/selection.ts`: `Route` adds `'settings'`, and `pathFor`/`locationFromPath` handle `/settings`.
- `apps/web/src/state/selection.test.ts`: the `/settings` cases.
- `apps/web/src/panel/Panel.tsx`:
  - the three settings imports;
  - `SettingsProvider` wrapping the shell;
  - the route switch (`/settings` → `SettingsPage`; otherwise `FirstRunGate` around the grid);
  - the top bar's **Settings** `NavLink`, after P25-07's `<NotificationsControl />` (the merge conflict was resolved keeping both).
- `apps/web/src/App.tsx`: `route === 'settings'` renders the `Panel` too.
- `store.ts` and `Navigation.tsx`: unchanged.

**Notifications slot:** `apps/web/src/panel/settings/SettingsPage.tsx`. It is the `<section aria-label="Notifications">` with its own `<h2>`. P25-07 was merged into this branch first, so it already mounts `<NotificationSettings heading={false} />`, which renders `<section aria-label="desktop notifications">`. The wizard deliberately leaves it out.

## Deferred

- **A folder browser** for the projects root, which would need a server endpoint listing directories. Today it is a validated text field.
- **A preflight banner in the panel** after setup, for when the runtime breaks later (logged out). Today it shows only on the settings page and in the wizard. Candidate for P25-09 if the dogfood run hits it.
- **A real QR code and remote pairing**: Phase 7.
- **Re-running the wizard on demand.** A "run setup again" would need a way to clear the marker, and nothing clears it on purpose. The settings page edits all the same fields.
- **Remote clients** can mark the setup done only through `autoApproveRemote`, following decision 51 and its open §8 question.

## Tests

- `apps/server/src/http/panel-routes.test.ts` (+2): `writable` is `all` locally and `limited` remotely on the GET and on patch replies, and `all` remotely with `autoApproveRemote` (which may then stamp the marker). The marker test: the marker is absent at first; a remote client gets 403 and nothing is written; `setupCompleted: false` gets 400; a local patch stamps it with the token kept; a second patch keeps the same stamp; `loadConfig` reads it back.
- `apps/web/src/panel/settings/settings.test.tsx` (14, through `<App />` with a fake socket and a stand-in settings server):
  - A fresh install walks the whole wizard:
    - a preflight error with its fix, then a re-check that calls `?refresh=1` and reports ready;
    - a projects root refused on the client, then by the server (400 `invalid`, message shown, still on the step), then saved;
    - a policy change;
    - unchanged steps send no patch;
    - "Open the panel" sends `setupCompleted` and lands on `/` with the navigation. The exact list of patches is asserted.
  - Skip sends only the marker and lands in the panel.
  - No wizard once the setup is done.
  - A refused marker (403) is shown, and the user can still go on.
  - A refused skip (500) is shown on the first step, next to Skip, with the way on.
  - A `writable: limited` client gets the panel and a dismissible note, never the wizard, and sends no patch.
  - While the settings read is in flight neither the panel nor the wizard shows; a failed read then shows the panel, a fresh install the wizard (no panel flash).
  - A stored 90 000 ms wall-clock shows as 1.5 and editing an unrelated cap saves just that cap.
  - The settings page is reached from the top bar at `/settings` and left again, and it contains P25-07's `desktop notifications` section.
  - An env-fixed retention is read-only and names its variable. "Applies at the next start" shows on the restart fields, and "restart Mission Control to apply" shows when `restartRequired` lists a field and after saving the projects root.
  - Client validation: a cap error and a disabled Save; a retention error.
  - Server refusals shown next to their section: 409 on caps (and the exact caps patch: only the changed caps, the wall-clock converted from minutes), 403 on the Stewards' sources, 400 `invalid_body` with issues on retention.
  - The policy reset sends `null`; the table returns to §3.6 and the reset button disables.
  - The runtime check shows versions; the token is masked, revealed only on click, and never in the URL; the QR placeholder is present.
- `apps/web/src/panel/settings/settings-model.test.ts` (8): the validators, the minutes conversion (decimal minutes, untouched values kept exactly, only changed caps sent) and per-field cap errors, `maskToken`, the policy row helpers, each refusal's wording, and `isSettingsResponse`.
- `apps/server/src/config/settings.test.ts` (+2) and `config.test.ts` (+1): `writableFor`; a hand-edited marker loads and is reported as a timestamp.
- `apps/web/src/state/selection.test.ts`: `/settings` round-trips, `/settings/` canonicalises, and `/settings/x` falls back to the panel.

Gates on `p25-08-settings` (after merging P25-07): `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check` and `pnpm test` are all green. Protocol 61, server 829 (+1 skipped), web 179.
