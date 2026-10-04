# P4-12 — Hidable inbox; closed projects out of the navigation

Cosmin: "I want to be able to hide the inbox as well" and "I want to be able to remove closed projects from the projects bar. There are a few demo projects that seem to be working on invented planets." In his data: four "Demo project 1–4", `in_progress` on non-catalogue "Demo planet" bodies (made by early dev buttons), and two completed projects, csv2parquet and tally.

## What was built

### 1. The inbox hides and comes back

- **Hide.** A "Hide" button in the inbox's header, next to "Inbox · N waiting for you" (accessible name "Hide inbox"), like the managed agents' (decision 69).
- **Show again.** Wide top bar: "Show inbox" appears next to "Show managed agents", only while the inbox is hidden. Phone menu: a "Hide inbox" / "Show inbox" item always sits after the managed-agents item and closes the menu (`data-closes-menu`).
- **"N waiting for you" stays** in the top bar. It is now a button in the wide bar too (it was plain text): clicking it, in either bar, goes back to the panel from settings or history, **shows the inbox if hidden**, then scrolls to it and focuses it. A question beacon's click (`revealQuestion`) does the same before scrolling to the card and highlighting it. Showing it this way is remembered like pressing "Show inbox".
- **Remembered per browser** in `localStorage['galactic.panel.inbox.visible']` (`'0'` hidden), every access in try/catch. The state is a small module store (`apps/web/src/panel/inbox-visibility.ts`, `useSyncExternalStore`) rather than component state, because `revealInbox` / `revealQuestion` are not React and are called from the scene's beacons.
- **Layout.** Hidden means unmounted. With only the managed agents left the grid gets `pnl-grid-no-inbox` and the column narrows as with `pnl-grid-no-agents`; the column is labelled "managed agents column". **With both hidden the side column is not rendered** and the grid is `pnl-grid-no-side`: wide, `nav | centre` with the scene and the dock taking the freed width (with and without the scene, and above 1700 px); stacked (≤1100 px), the scene then the navigation at full width above the dock; phone, the same single column. Checked in a browser at 1440, 1000 and 500 px wide: no overlap, the page does not scroll (`scrollWidth === innerWidth`, `scrollHeight === innerHeight`).

### 2. Closed work leaves the navigation

- **Closed** = `completed` or `archived` (`CLOSED` in `nav-model.ts`). A **failed** (cancelled) item is not closed: it can still be picked up again, and it is what "Archive now" applies to, so it stays visible until archived.
- `buildNav` now builds the whole tree and prunes closed items with everything nested in them (a completed project's tasks, even unfinished ones, go with it), and completed or archived standalone tasks.
- **"Show closed"** replaces "Show archived work" at the bottom of the navigation, off by default, remembered per browser in `localStorage['galactic.panel.nav.showClosed']` (`'1'` shown). While off it says how many are hidden ("Show closed (2 hidden)"). With it on, closed rows are listed, dimmed (`is-closed`).
- **The selected item is always listed**, even closed (a deep link to a closed task's Steward or a completed project's Waykeeper), with the path to it.
- The Steward count's option is renamed `showClosed`; archived tasks still leave the total without it, completed tasks count (they are work its Stewards did).

### 3. Clearing leftover work from the navigation

- Every project and task row has a **"⋯"** button ("Actions for <name>"), shown on hover or keyboard focus (always on touch screens). It opens the row's actions **inline under the row** (the navigation is a narrow scroll container, a popover would be clipped): the controls strip's work actions (`workActions`) minus Edit — Pause/Resume, Stop, Cancel, Close, Archive now, Pin, Reopen as the state allows — through the shared `useControls` (`POST /api/control` with `{target: {kind, id}, action: {action}}`), the same inline confirmations ("Close the project now? …" → "Yes, close"), and the server's refusal shown as an alert under them. Escape closes it and returns focus to "⋯". The actions stay open after one runs, so a cancelled project then offers "Archive now".
- **What the server allows** (checked in `apps/server/src/domain/projects.ts`, `cascade.ts`, `states.ts`): an `in_progress` project with no live agents can be **closed** (`closeProject` refuses only while a sub-project is unfinished; it leaves the project's tasks as they are) or **cancelled** (its unfinished tasks become `failed`, the project `failed`). **Archive** needs the project finished (`completed` or `failed`) and all its tasks finished; a completed project cannot then be cancelled. So when a project has unfinished tasks the actions say so: "N unfinished tasks: Cancel marks them failed so the project can then be archived; Close leaves them open." (or, once completed, "… keep this project from being archived: cancel or close them first.").
- **For Cosmin's demo projects:** "⋯" → Cancel → Yes, cancel → Archive now → Yes, archive now: the project is archived, its body freed, and it leaves the navigation. "⋯" → Close also takes it out of the navigation at once (closed is hidden); the retention job archives it later. csv2parquet and tally are hidden by default already.

## Proposed SPEC decision (for §7, next free number)

| 75 | Hidable inbox, closed work out of the navigation | **The inbox hides like the managed agents; closed work is hidden in the navigation, and work can be cleared from it** (2026-10-04, P4-12; refines decisions 69, 71, 74): a "Hide" button in the inbox's header hides it, remembered per device; the wide top bar shows "Show inbox" while it is hidden and the phone menu always has the item. "N waiting for you" stays in the top bar and, like a question beacon, shows the inbox again before opening it. With the inbox and the managed agents both hidden the side column goes and the scene and the conversation take its width. The navigation lists open work only: completed and archived projects (with their tasks) and completed or archived standalone tasks are hidden behind a "Show closed" toggle at its bottom (remembered per device; it says how many are hidden), which lists them dimmed; a cancelled (failed) item stays listed until archived; the selected item is always listed, even closed. Every row's "⋯" opens its task's or project's actions (those of the controls strip, without Edit) with the same confirmations and the server's refusals, and says when unfinished tasks keep a project from being archived (Cancel fails them; Close leaves them). |

## Tests

`apps/web/src/panel/inbox-closed.test.tsx` (14 tests):

- the inbox hides from its header, the managed agents and "N waiting" stay, the grid reflows, "Show inbox" appears; both hidden → no side column (`pnl-grid-no-side`), survives a reload, "Show inbox" brings it back; the waiting count shows a hidden inbox and focuses it; `revealQuestion` shows a hidden inbox and focuses and highlights the card; phone menu hide/show; no-storage browser;
- `buildNav` hides completed/archived projects (and their tasks) and standalone tasks, counts them, lists them with `showClosed`; keeps the selected closed item with its path; the toggle's UI, dimming and persistence; a deep link to a closed task's Steward;
- row actions: Close with its confirmation posts `{target: {kind: 'project', id}, action: {action: 'close'}}`; the unfinished-tasks note (`openTasksNote`); Archive now on a cancelled project shows the server's 409 text, then posts again; Cancel on a standalone task, Escape closes and returns focus.

Updated: `TopBar.test.tsx` (the phone menu's item list gains "Hide inbox"), `panel-tweaks.test.tsx` (`showClosed`).

Full gates: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` all green.

## Deferred / not done

- `SPEC.md` decision text above is proposed, not written (the coordinating agent owns SPEC).
- `moved` items stay listed (they are markers of work that went elsewhere); hiding them with closed work is a one-line change in `CLOSED` if wanted.
- The managed-agents cards keep their own "show archived work" checkbox; they still list completed work.
- No bulk "archive all closed" action; the demo projects are cleared one by one (two confirmations each).
- Not drawing the demo planets is P4-13's.
