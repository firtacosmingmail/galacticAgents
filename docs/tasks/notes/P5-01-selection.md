# P5-01 — Bidirectional selection and Earth = Harmonizer

Branch `p5-01-selection` (from `p5-wave1-selection-status-history`). Acceptance: every selection path in `SPEC.md` §4.1–4.2 works in both directions.

## Gap audit

Sources: SPEC §4.1, §4.2 and decisions 53, 55, 62, 64, 65, 66, 69, 70, 71, 74. Test paths are under `apps/web/src/`. "Panel → scene" means: the selection changes, the URL follows, the camera flies to the agent's body (not for the Harmonizer). "Scene → panel" means: the main view and the URL change, the camera flies to the body.

| # | Path | Direction | Status | Proof |
|---|---|---|---|---|
| 1 | Click a planet hosting a project → its Waykeeper (newest live, else newest) | scene → panel | works | `scene/picking/body-action.test.ts` "a planet hosting a project…", "with no live Waykeeper…"; `picking-ui.test.tsx` "selects the Waykeeper of a project's planet and flies there"; `selection-paths.test.tsx` "a body, Earth, and a click on empty space" (main view + URL) |
| 2 | Click a moon (sub-project or independent project) → its Waykeeper | scene → panel | works | `body-action.test.ts` "round-trips with bodyAction for every body with an agent" (Io); same rule as a planet |
| 3 | Click an asteroid → its Steward | scene → panel | works | `body-action.test.ts` "an asteroid hosting a task…"; `picking-ui.test.tsx` "selects an asteroid task's Steward; Earth selects the Harmonizer" |
| 4 | Click Earth → Harmonizer | scene → panel | works | `body-action.test.ts` "Earth, the headquarters, selects the Harmonizer"; `selection-paths.test.tsx` (from a Waykeeper, main view back to the Harmonizer chat) |
| 5 | Click the Harmonizer's HQ station (its satellite) → Harmonizer | scene → panel | works (test added) | `Picking.test.tsx` "a click on the Harmonizer's HQ station selects the Harmonizer and flies to Earth" |
| 6 | Click a free / reserved / moved / not-started body → info card, selection unchanged | scene | works | `picking-ui.test.tsx` "a free body…", "work with no agent yet says so"; `body-action.test.ts` "free, reserved, moved and unknown bodies…" |
| 7 | Click a satellite → its agent, fly to its body (decision 70) | scene → panel | works | `Picking.test.tsx` "a click selects the satellite's agent…", "…orbited out from under the pointer still selects it" |
| 8 | Click a beacon → the asker, fly, reveal the question (decision 74) | scene → panel | works | `beacons-ui.test.tsx` "selects the asking agent…", "the Harmonizer's own question…"; `Picking.test.tsx` "a click selects the asker…" |
| 9 | Click a label → its body (decision 66) | scene → panel | works | `Picking.test.tsx` "a click on a label's rectangle is a click on its body", "a moon under a planet's label stays clickable" |
| 10 | "What's here" list → the chosen body or satellite | scene → panel | works | `picking-ui.test.tsx` "\"what's here\" lists the bodies…", "…lists the satellites first; choosing one selects its agent" |
| 11 | Drag never selects | scene | works | `Picking.test.tsx` "a drag that starts on a label selects nothing", satellite drag case; `Picking.test.tsx` "a drag over empty space deselects nothing" (added) |
| 12 | **Deselect in the scene → Harmonizer** (§4.2 "deselect, or click Earth") | scene → panel | **fixed here** | Was: a click on empty space only closed a popover; nothing deselected. Now `deselectFromScene` (`picking/store.ts`). `Picking.test.tsx` "a click on empty space goes back to the Harmonizer; the camera stays", "with a card open, the first click on empty space only closes it"; `selection-paths.test.tsx` |
| 13 | **Escape → deselect** | scene → panel | **fixed here** | Was: Escape only closed the popover or flew back to the system. Now Escape unwinds popover → camera body → selection → system framing; Home stays camera-only. `picking-ui.test.tsx` "Escape then deselects…", "a deselecting Escape is taken (the replay does not also exit on it)"; existing "Escape closes the popover before going back to the system" |
| 14 | Enter on the scene → the body the camera is on | scene → panel | works | `picking-ui.test.tsx` "Enter on the scene selects the body the camera is on…", "Enter on a free body shows its info" |
| 15 | `]` / `[` / Home / breadcrumb move the camera, never the selection (decision 64) | scene | works | `camera/camera-ui.test.tsx` "drives the camera store from the scene area…", "names the focused moon under its planet; the crumbs fly back" |
| 16 | Scene selection updates the URL (a history entry) | scene → URL | works | `picking-ui.test.tsx` (`/waykeeper/a-wk-old` after a click); `selection-paths.test.tsx` (pick, deselect, then Back returns to the scene's Steward and flies) |
| 17 | Navigation row (project, task, asteroid) | panel → scene | works | `panel/Panel.test.tsx` "navigates between…" (URL); `selection-paths.test.tsx` "a navigation row…" (flies) |
| 18 | Navigation's Harmonizer row / top-bar brand / "Back to the Harmonizer" → no flight | panel → scene | works | `sync.test.ts` "going back to the Harmonizer leaves the camera alone"; `selection-paths.test.tsx` |
| 19 | Inbox card "open agent" link (decision 55) | panel → scene | works | `panel/Inbox.test.tsx` "…opens the agent" (URL); `selection-paths.test.tsx` "an inbox card's agent link" (flies) |
| 20 | Managed-agents cards, Steward view's supervisor link, chat links (`NavLink`) | panel → scene | works | all go through `navigate`; `useSelectionSync` flies on any non-scene change (`picking-ui.test.tsx` "flies on a panel selection…"); `panel/AgentCards.test.tsx` for the cards' links (the Steward view's supervisor link is the same `NavLink`, not tested on its own) |
| 21 | Back / forward | panel → scene | works | `Panel.test.tsx` (URL); `selection-paths.test.tsx` "back and forward fly to the agent again; back to the Harmonizer does not" |
| 22 | URL deep link / reload; wrong kind corrected | URL → both | works | `sync.test.ts` deep-link cases; `picking-ui.test.tsx` "a deep link flies once the body is drawn", "a plain load with a selection does not fly"; `Panel.test.tsx` "restores the selection from a deep link", "rewrites a link whose kind is not the agent's role"; `selection-paths.test.tsx` "a deep link (a reload)…" |
| 23 | Notification click (panel on the main view) | panel → scene | works | `notifications/notifier.test.ts` (selection per target); flies through the sync like any panel change |
| 24 | **Notification click / history agent link / back-forward from the settings or history page** | panel → scene | **fixed here** | Was: the scene is unmounted on those pages, so the selection arrived before the scene mounted and never flew. Now kept like a deep link (`picking/sync.ts`). `picking-ui.test.tsx` "a selection that comes back to the panel from the history page flies", "…a notification clicked on the settings page…", "returning to the panel with the same selection, or to the Harmonizer, does not fly"; `selection-paths.test.tsx` "a notification clicked while the settings page shows…" |
| 25 | Selection changed in list mode, scene shown later → no flight (decision 62/65 "the camera does not move on its own") | panel | works (test added) | `sync.test.ts` "…neither does showing the scene again"; `picking-ui.test.tsx` "a selection changed in list mode does not fly…" |
| 26 | Selection highlight: Harmonizer = ring on Earth only; Waykeeper / Steward = outline (ring on the phone tier, and while small) on the work's body; a project task's Steward highlights its project's body | scene | works | `Picking.test.tsx` "never outlines Earth for the default Harmonizer selection; outlines a Waykeeper's planet"; `body-action.test.ts` `selectionBody` / `outlineBody` cases |
| 27 | **Replay (P4-07) and selection** | both | **decided and fixed here** | Picks and flights use the replayed world; the panel shows the live agent. Was: a panel selection of an agent not yet in the replayed world waited and flew mid-playback when it appeared. Now dropped. `picking-ui.test.tsx` "during a replay" (3 tests) |
| 28 | Selected agent's own satellite marked among several on one body | scene | deferred | SPEC asks only for the body's outline; a project planet with several Stewards does not show which satellite is selected. Proposed as an open question below. |

Counts: **24 work** (2 of them with a test added here: #5, #25), **4 fixed here** (#12, #13, #24, #27), **1 deferred** (#28).

## What was built

- `scene/picking/store.ts` — `deselectFromScene()`: back to the Harmonizer through `selectFromScene` (a history entry; the sync does not fly), closes the popover; false when already on the Harmonizer.
- `scene/picking/Picking.tsx` — a click release with nothing under the pointer: closes an open popover, else deselects.
- `scene/SceneArea.tsx` — `Escape` with no popover and the camera on no body deselects (and takes the key, so a replay does not also exit); otherwise as before.
- `scene/picking/sync.ts` — a module-level store subscription keeps a selection that arrives with a switch from a non-panel route to the panel as a pending "deep link", so the scene flies to it once mounted; any other selection change drops it. `SyncDeps.replaying`: during a replay a flight to an agent with no body in the replayed world is dropped.
- Tests: `scene/selection-paths.test.tsx` (new, `App` with the scene stubbed: every panel path selects, rewrites the URL and flies; scene picks change the main view and the URL), additions in `Picking.test.tsx` and `picking-ui.test.tsx`.
- `docs/TECHNOLOGY.md` §picking: "Selection both ways".

## Proposed SPEC text

Amendment to decision 65 (picking), appended:

> Deselecting returns to the Harmonizer (§4.2): a click on empty space in the scene — when no info card or "what's here" list is open; with one open, the click only closes it — or `Escape` with the scene focused, once there is no card open and the camera is on no body (Escape steps back one thing at a time: the card, the camera's body, the selection, then the whole system's framing; `Home` only moves the camera). Deselecting never moves the camera. A selection made on a page without the scene (a notification or a history link clicked from the settings or history page, back or forward onto an agent) flies the camera there when the panel's main view comes back, as a link does on load; a selection changed in list mode does not fly when the scene is shown later. During a replay (decision 78), picking and flights use the replayed world while the panel stays live; selecting in the panel an agent that does not exist yet at the replayed time leaves the camera alone.

Open question for §8:

> On a body with several agents (a project planet with its Waykeeper and Stewards), should the selected agent's own satellite be marked (a ring like the hover's), in addition to the body's outline?

## Tests

- New: 6 in `scene/selection-paths.test.tsx`, 4 in `Picking.test.tsx`, 9 in `picking-ui.test.tsx` (19).
- The three tests of gap #24 fail with the fix disabled (checked).
