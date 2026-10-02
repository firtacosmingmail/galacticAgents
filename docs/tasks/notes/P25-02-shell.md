# P25-02 — Panel app shell and selection model

## What was built

The side panel (SPEC §4.2) is now the main UI at `/`, in "list mode", the only mode for now. The ops console moved to `/debug`. That is the Phase 1 agents console and P2-18's Hierarchy page, with the status bar, snapshot counts and event log, unchanged.

Layout (`apps/web/src/panel/`):

```
┌ top bar: GalacticAgents · connection · [N waiting for you] open questions · blocked · Ops console ┐
├ Navigation ─────────┬ Main area ───────────────────────────┬ Managed agents + inbox ─┤
│ Harmonizer [beacon] │ eyebrow ("Talking to" / "Watching")  │ managed agents (or      │
│ PROJECTS            │ title · ← Harmonizer                 │  "Reports to")          │
│  ± Billing [beacon] │ ChatBox (Harmonizer / Waykeeper)     │ QuestionInbox           │
│    ± sub-project    │   or StewardView (read-only)         │ ProposalCards           │
│      task           │                                      │                         │
│ ASTEROIDS           │                                      │                         │
│ □ show archived     │                                      │                         │
└─────────────────────┴──────────────────────────────────────┴─────────────────────────┘
```

- **`Navigation.tsx`**:
  - The Harmonizer always sits first. It shows its status, plus a beacon with the count of questions waiting for the user.
  - Below it: the top-level projects, then the standalone (asteroid) tasks. Sub-projects and project tasks are nested under their project. Each row shows its derived work state (P2-15).
  - A project row selects its Waykeeper (the newest live one, else the newest). A task row selects its Steward, chosen the same way. A row without an agent is shown but cannot be clicked.
  - The nested work of a project opens automatically while the project or something inside it is selected, or while something inside it is blocked on the user. A disclosure button overrides that.
  - Archived work stays hidden until "show archived work" is ticked.
  - Every row is a real `<a href>`, so it can be opened in a new tab or copied. A plain click navigates in place.
- **Blocked on user**:
  - `state === 'blocked_on_user'` gets the loud amber **"blocked on you"** beacon: a pulsing dot that stays still under reduced motion, plus an amber edge on the row.
  - At every level, rows sort in this order: blocked on user, open work, finished (`completed`/`failed`/`moved`), archived. Rows of the same rank sort by `createdAt`.
  - The sorting is a pure model with no React (`nav-model.ts`, `buildNav`).
  - Amber appears nowhere else on the panel.
- **`Panel.tsx`**:
  - **Main area:** the selected agent's view, chosen by the agent's actual role. The Harmonizer (the current one, `currentHarmonizer`) and Waykeepers open P2-18's `ChatBox`. A Steward opens P2-18's `StewardView`, which has no message box except an open clarification's answer card (decision 13).
  - **Unknown agent id:** the main area shows "Loading…" until the stream is live, then "not in the current log" with a link back to the Harmonizer.
  - **Right column:** a plain "managed agents" list of links (`managedAgents`). For the Harmonizer it lists the live Waykeepers and asteroid Stewards. For a Waykeeper it lists its live Stewards. For a Steward it shows "Reports to" with its supervisor. Below the list are P2-18's `QuestionInbox` and `ProposalCards`.
- **`panel.css`**: tokens on `.pnl`, dark and light (`prefers-color-scheme`). A few overrides make the reused P2-18 pieces readable in light mode. Below 1100 px the right column moves under the main area; below 720 px the layout is one column, with the navigation capped at 40vh.

## The selection model (`state/selection.ts`, `state/store.ts`)

```ts
type Selection = { kind: 'harmonizer' } | { kind: 'waykeeper' | 'steward'; id: Id };
type SelectionKey = 'harmonizer' | `waykeeper:${Id}` | `steward:${Id}`;   // selectionKey / parseSelectionKey
type Route = 'panel' | 'debug';
interface PageLocation { route: Route; selection: Selection }
pathFor(loc) / locationFromPath(path) / currentLocation()

// store (useAppStore)
route: Route; selection: Selection;
select(selection)          // panel + push a history entry when the URL changes
selectAgent(agentId)       // by the agent's role in world; unknown ids are ignored (for the scene)
navigate(location, { replace? })
syncFromLocation()         // read the URL (load, popstate); canonicalises unknown paths to "/"
```

- **URLs:** `/` selects the Harmonizer, `/waykeeper/<id>` a Waykeeper, `/steward/<id>` a Steward (the id is URI-encoded), and `/debug` opens the ops console. Anything else reads as `/`.
- **Where the URL is read:** at store creation, and again by `App`'s `useLocationSync` in a layout effect, which also listens to `popstate`. So a reload or a deep link restores the selection, and back/forward work.
- **`reset()`** (forget token, refused token) leaves the route and the selection alone.
- **Not stream-derived:** the route and the selection are the only store fields that do not come from the stream. They are the user's navigation, not world state, so the replay-vs-snapshot conformance test is untouched.

## Routing and deep links

- **No router dependency:** the store's `navigate` and `pathFor`/`locationFromPath` cover the four routes. A router would add a dependency for no gain until Phase 7.
- **Vite dev:** `appType: 'spa'` already falls back to `index.html`. The `/dev` proxy key does not match `/debug`, because Vite matches proxy keys by prefix and `/debug` does not start with `/dev`. `vite.config.ts` is unchanged.
- **Server:** the existing `setNotFoundHandler` in `apps/server/src/app.ts` already serves `index.html` for every GET outside `/api/`, `/dev/` and `/health`. Nothing in the server changed. The new `apps/server/src/app-static.test.ts` pins the behaviour: `/`, `/waykeeper/a-1`, `/steward/a-2` and `/debug` load the page, and `/api/nope` stays 404.

## P2-18 pieces reused

These are reused as they are: `ChatBox` (main area, P25-03 replaces it), `StewardView` (main area, P25-05), `QuestionInbox` and `ProposalCards` (right column, P25-06), `currentHarmonizer`, `agentsFor`, `agentLabel`, `StatePill` and `ApiContext`. `WorkTree`/`Controls` stay on `/debug` only; the panel's control actions come with P25-04's cards.

## Tests

- `panel/Panel.test.tsx` (6) renders `<App/>` over the fake socket and checks the following:
  - Navigating Harmonizer → Waykeeper → Steward → Harmonizer changes the selection, the URL and the main area. The Steward view has no textbox. Back restores the Steward.
  - The Harmonizer's managed agents are listed.
  - A Waykeeper deep link and a Steward deep link restore the selection, and an unknown agent gets its message.
  - `/debug` shows the console, and the links go both ways.
  - Blocked-on-user projects and asteroids carry the badge and sort first.
- `state/selection.test.ts` (3): key and URL round-trips, and unrecognised paths.
- `App.test.tsx`: the event-page tests now run at `/debug`.
- `apps/server/src/app-static.test.ts` (2).
- Totals: web 63 tests, server 799 (+1 skipped), protocol 54.

## Decisions (proposed text, ready to paste)

- **SPEC §7, decision N — Panel URLs and selection:** the panel's selection is one of `harmonizer`, `waykeeper:<id>` or `steward:<id>`. It is held in the client store and shared with the scene. It is reflected in the URL as `/`, `/waykeeper/<id>` or `/steward/<id>`, so a link or a reload reopens the same conversation or Steward view. The ops console lives at `/debug` and is not linked prominently: the top bar's small "Ops console" link is the only way in. Selecting a project or a task in the navigation selects the agent working on it: the newest live one, else the newest one.
- **SPEC §4.2 addition:** the navigation lists the Harmonizer first, then the projects (sub-projects and tasks nested), then the standalone asteroid tasks. At every level, items blocked on the user carry a "blocked on you" badge and sort first, then open work, then finished work. Archived work is hidden behind a toggle until the history view exists.
- **TECHNOLOGY §2.1 addition:** the web client has no router library. The store owns `route` and `selection`, and `pathFor`/`locationFromPath` map them to the history API. These are the only client state not derived from the stream (§6.3). The server's SPA fallback already serves `index.html` for every non-API GET, so deep links work both from the dev server and from `galactic start`.

## Deferred

- **For P25-03 … P25-06:** the panel's own chat (inline cards in the thread), managed-agents cards with controls and cost, the Steward view polish, and the inbox and card redesign. Control actions are on `/debug` until then.
- **Selecting a project with no Waykeeper:** a proposed or parked project has no agent yet, so its row cannot be clicked. A project view, or opening its proposal card, could come with P25-06.
- **Keyboard navigation inside the tree:** arrow keys. Tab and Enter work today.
- **Mobile layout and the PWA:** Phase 7. The panel is only kept from breaking at narrow widths.
- **Ids containing a `.`:** Vite's dev SPA fallback treats a path with a dot as a file. Agent ids are generated without dots, so this does not matter today. If it ever does, switch the deep-link scheme to `?sel=`.
