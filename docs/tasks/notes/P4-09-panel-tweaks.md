# P4-09 — Hidable managed agents, compact project rows

Cosmin: "I don't need the Managed agents side panel. I want it hidable." and "in the projects side panel, when I select a Waykeeper, I want to see less information, but I want to know how many Stewards it uses."

## What was built

### 1. Hiding the managed agents

- **What hides.** The inbox shares the right column with the managed agents (`SideColumn` in `Panel.tsx`), so only the **managed-agents section** hides. The inbox stays where it was, always rendered. The section includes the Steward view's "Reports to" link, so that hides too.
- **Hide.** A small "Hide" button sits in the section's header, next to "Managed agents" / "Reports to". Its accessible name is "Hide managed agents".
- **Show again.** Wide top bar: a "Show managed agents" button appears next to "Hide/Show scene", **only while the section is hidden**. The header already holds the Hide button, and the bar was full enough. Phone menu (decision 67): a "Hide managed agents" / "Show managed agents" item always sits right after the scene item. Picking it closes the menu, as the scene item does. So a hidden section can always be brought back, at any width.
- **Remembered per browser** in `localStorage['galactic.panel.managedAgents.visible']` (`'0'` hidden, otherwise shown, so it is shown by default). Every read and write is in try/catch, exactly like `galactic.scene.visible` (decision 62). With no storage, the choice lasts for that page only. The code is in `apps/web/src/panel/managed-agents-visibility.ts` (`useManagedAgentsVisibility`), held in `Panel` and passed to `TopBar` and `SideColumn`.
- **Hidden = not rendered.** The section is unmounted, so its timers stop. The grid gets the class `pnl-grid-no-agents`, and the side column's label changes to "inbox column". The layout reflows at every breakpoint (P3-01 breakpoints):

| Layout | Shown (before) | Hidden |
|---|---|---|
| List mode > 1100 px | nav 260 · main · side 360 | nav 260 · main · inbox 240–320 (main +40 px at 1440) |
| Scene 1101–1699 px | nav · scene · right column split 3fr conversation / 2fr side | the inbox under the conversation, sized to its content, capped at 36vh (≈ its old 2fr share), so the conversation never gets shorter than before and grows when the inbox is short |
| Scene ≥ 1700 px | four columns: nav · scene · conversation · side 260–320 | three columns: nav · scene · conversation, with the inbox under the conversation (same cap); **the scene takes the fourth column's width** (820 → 1140 px at 1800) |
| ≤ 1100 px (stacked, both modes) | the side column below everything | unchanged, just shorter |

- **Side fix.** The narrower inbox column made an existing overflow visible: the question card's inline answer row ran past the column's edge (P3-12's notes saw it at 1440 too). That row (`.pnl-side .send`) now wraps.
- **What hiding loses: nothing.** The cards' controls (decision 56) stay reachable without them, through the **controls strip** (below). A Steward's pause/stop are in its own view (P25-05). Reopening archived work is in History (P25-10). Every control is also available through the Harmonizer (§4.3) and in the ops console.

### 1b. The controls strip (review fix)

The review found that with the cards hidden a project's work actions (and a task's, and the Waykeeper agent's own pause/stop) had no panel surface. The fix is a compact **controls strip** in the main area, built from the cards' action row:

- **Shared code.** `apps/web/src/panel/controls.tsx`: `useControls` sends the actions through `POST /api/control`, asks inline before stop / cancel / close / archive (same texts as the cards, decision 56), toggles the edit form and keeps the refusal, shown as an alert (`ControlFeedback`). The cards (`AgentCards.tsx`) now use the same hook, `ActionRow` and `ControlFeedback`.
- **Where.** In a Waykeeper's conversation, in the header (`WaykeeperControls` in `Panel.tsx`): the project's work actions and the Waykeeper's agent actions (plus "Resume session" when it is interrupted). In a Steward's view, beside its existing agent controls (`StewardPanelView`): the task's work actions only, the agent's pause/stop are not repeated. Nothing for the Harmonizer.
- **Always shown**, cards hidden or not: it is the selected agent's own controls, while the cards are the agents it manages.
- **Compact.** Pause / Resume inline, each after a small "project" / "agent" / "task" label (accessible names "Pause the project", "Pause the agent", "Pause the task"); everything else in a "More" menu grouped by target ("project controls", "agent controls", "task controls"). Picking an item closes the menu; Escape closes it and returns focus to "More"; a click outside closes it. The menu is absolutely positioned and capped at the viewport width minus the 16 px gutters, so it works on a phone.

### 2. Compact project rows with Steward counts

- **Compact when selected.** Selecting a project's Waykeeper no longer expands its row. `NavRow` used to auto-open when the item *or* anything in it was selected. It now auto-opens only when something **nested** is selected (`childContainsAgent`) or something nested is blocked on the user (unchanged: "blocked on you" stays loud). The +/− disclosure button still opens and closes the row either way. Selecting a Steward (from a deep link, the inbox or a satellite) still opens the path down to its task.
- **Steward count on every project row**, not just the selected one. It reads better when you can compare projects, and it costs one short mono line: **"2 active, 3 in total"**, tinted blue while anything is active and grey otherwise. It is hidden when the project has no Stewards. Screen readers and the tooltip get "Stewards: 2 active, 3 in total". The visible text is `aria-hidden`, and the words sit in a visually hidden span inside the row's link. (The first version read "2/3 Stewards" and counted agents; the review changed it to tasks, below.)
- **What counts** (`stewardCount` in `nav-model.ts`, computed from the client world):
  - Stewards whose task belongs to **the project itself**. A sub-project's Stewards count on the sub-project's own row, because they work under its own Waykeeper. That matches decision 56: a Waykeeper's cards are its own Stewards plus its sub-projects' Waykeepers.
  - **Total** = the distinct tasks of the project that have had a Steward: "how many Stewards it uses" means the work being done, not every Steward process ever spawned, so a respawned task counts once. **Archived** tasks are left out unless "Show archived work" is on, so the number matches what the row can list.
  - **Active** = those tasks whose newest Steward (`primaryAgent`, the one the task's row opens) has a status that is neither ended (`finished`, `failed`, `stopped`, `interrupted`) nor `paused`. Waiting for input counts as active: the Steward is live and needs the user. A paused one does not: nothing is being done. A Steward with no status yet is not active.

## SPEC decision 69 (text as proposed, with the review fixes)

> **Hidable managed agents; compact project rows** (2026-10-03, P4-09; refines §4.2, decisions 53, 56, 62, 67): the side column's managed-agents section can be hidden from its header ("Hide"). Hiding it is remembered per browser, like the scene (a device preference, not a server setting). Hidden means unmounted, and the layout reflows: in list mode the inbox column narrows. Beside the scene the inbox moves under the conversation, sized to its content and capped at about its former share. At four columns the scene takes the freed column. The inbox is never hidden. While the section is hidden, the wide top bar shows "Show managed agents". The phone menu always offers Hide/Show managed agents, right after the scene item. With the cards hidden, a Steward's controls stay in its own view, reopening stays in History, and everything stays available through the Harmonizer. In the navigation, selecting a project's Waykeeper keeps its row collapsed: nested work opens only with the disclosure button, when something inside is selected, or when something inside is blocked on the user. Every project row shows its Stewards as "N active, M in total" (spoken "Stewards: N active, M in total"), counted by task: M is the project's own tasks that have had a Steward (not its sub-projects', which show on their own rows; a respawned task once; archived tasks only while archived work is shown), N those whose newest Steward is live and not paused. A controls strip keeps the selected Waykeeper's project and agent controls, and the selected Steward's task controls, in the main area whether or not the cards are shown.

TECHNOLOGY §6 (client) records the `localStorage` key `galactic.panel.managedAgents.visible`, the grid class `pnl-grid-no-agents`, the controls strip and the count.

## Screenshots (headless Chrome over CDP, throwaway page seeded with the domain fixtures, two working Stewards and one finished on "Auth refactor", a sub-project with one Steward, a user-held question and a pending card; deleted afterwards, along with the port 6409 Vite server)

Headless Chrome has no WebGL2, so for the scene layouts a placeholder element took the scene's grid area. Measured boxes are below; there was no horizontal scroll at any width.

- **1440, list mode, shown, Waykeeper of Auth refactor selected.** The nav row reads "+ Auth refactor in progress / 2/3 Stewards" (the first version's wording; now "2 active, 2 in total") (blue), collapsed, with the current-row highlight. The right column shows "MANAGED AGENTS [Hide]" and three cards, with the inbox below them.
- **1440, list mode, hidden.** The top bar gains "Show managed agents" after "Show scene". The right column is just "INBOX · 2 WAITING FOR YOU", with the question and the work card. Main is 860 px (was 820) and the inbox 320 px (was 360). The answer row wraps.
- **1000 and 390, hidden.** Stacked as before: nav, conversation, then the inbox. At 390 the row reads "Auth refactor in progress 2/3 Stewards" on one line.
- **Scene 1800, shown → hidden.** Scene 820 → 1140 px wide. The conversation stays 440 px wide; its height goes 851 → 527 px with the inbox (324 px, capped) under it.
- **Scene 1440, shown → hidden.** Scene 800 px both times. The conversation goes 510 → 527 px tall, and the inbox gets 324 px (was 340 px, shared with the cards).
- **Scene 1000, hidden.** Stacked, unchanged.

## Tests

- `apps/web/src/panel/panel-tweaks.test.tsx` (new, 9 tests, jsdom through `<App/>` and the fake socket):
  - hide from the header: the section is gone, the inbox and its "1 waiting for you" are still there, the grid has `pnl-grid-no-agents`, and storage holds `'0'`
  - still hidden after a reload, including a Steward's "Reports to"; the top bar's "Show managed agents" restores it and persists `'1'`, and the button disappears
  - hide and show from the phone menu, which closes after each
  - storage that throws: shown by default, and hiding still works for the page
  - `stewardCount` and `buildNav`: active vs total, archived excluded unless shown, the sub-project counted on its own row, tasks carry no count (numbers updated by the review fix below)
  - a Steward without a status is not active
  - the selected Waykeeper's row is collapsed with `aria-expanded=false`, the badge reads its count with the spoken words, and the expand toggle opens and closes the row
  - a Steward deep link still opens the path to its task
  - no badge on a project without Stewards
- Updated: `Panel.test.tsx` (the navigation test now opens the project's row before clicking its task), and `TopBar.test.tsx` (the menu's item list includes "Hide managed agents" after the scene control, and focus lands on it first).
- Review fixes: `apps/web/src/panel/controls-strip.test.tsx` (new, 8 tests): the Waykeeper's strip with the cards hidden (inline pause per target, the "More" groups, pin closing the menu), confirm / Keep and a confirmed agent stop, a 409 refusal shown in the strip, the project's edit form, Resume / Resume session for a paused project and an interrupted Waykeeper, shown with the cards too and absent for the Harmonizer, the Steward's task strip beside its agent controls (no agent actions repeated, a confirmed close), Escape closing the menu. `panel-tweaks.test.tsx`: the count by task (2 active, 2 in total; 3 with archived; a respawned task once, active by its newest live Steward; paused not active, waiting for input active; no status not active), the badge's new words, and focus back on the menu button after the phone menu's toggle (`data-closes-menu`).
- Gates from the repo root: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` all green. protocol 67, server 845 (+1 skipped), web 646 (9 new). After the review fixes (on top of P4-08): protocol 67, server 845 (+1 skipped), web 682.

## Deferred / not done

- The inbox cap (36vh beside the scene) is a fixed number. A resizable split between the conversation and the inbox is left for Phase 5 polish.
