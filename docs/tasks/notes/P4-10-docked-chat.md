# P4-10 — Chat docked at the bottom, minimisable

Cosmin, after hiding the managed agents: "The inbox panel is now below and on top of the chat window. Now I cannot reach the chat. Move the chat to the bottom part of the screen, between the side panels. I want to be able to minimise the chat as well, and pull it back up." Earlier: "There is a big scroll on the page for some reason. The bottom of the page is empty and I can scroll to it."

## Root cause

Reproduced on the batch branch's code (`p4-wave1-satellite` at `c92a076`) in a throwaway harness page: the real `App`, a fake socket fed the domain fixtures, two user-held questions, two pending cards, a 40-line Harmonizer conversation. It ran on a private Vite (port 6510) under headless Chrome with SwiftShader WebGL2, so the real scene was on screen. Boxes are `[left, top, width, height]` in CSS px.

### 1. "The inbox covers the chat": the composer overflowed the main area, right where the inbox starts

There was no geometric overlap between the grid cells. The main area's **content** was taller than its cell, and the part pushed out was the composer.

- `.pnl-thread` (chat.css) was `max-height: calc(100vh - 290px); min-height: 240px`. Those numbers suit a column as tall as the viewport, as at ≥1700 px with the managed agents shown.
- Between 1101 and 1699 px the conversation sits in the top row of `minmax(0, 3fr) minmax(0, 2fr)`. With the managed agents hidden (P4-09), that becomes `minmax(0, 1fr) auto`, with the inbox in the second row capped at 36vh. The main area is then only about 0.6–0.64 × the viewport tall.
- The chat still needed about `100vh − 290 + header + chat head + composer` ≈ `vh − 20` px. The main area (`overflow-y: auto`) hid the overflow. The composer landed below the main area's bottom edge, exactly where the inbox begins, so the inbox seemed to sit "below and on top of" the chat.
- Reaching the composer meant scrolling the main area itself. But the wheel over the chat scrolls the thread, an inner scroller 4,800 px tall, so in practice the composer could not be reached.

Measured at 1280 × 900, scene shown:

| managed agents | main area (cell) | main content | composer | inbox column |
|---|---|---|---|---|
| hidden | 49 → 576 (527 px) | 878 px | **798 → 899** | 576 → 900 |
| shown | 49 → 560 (510 px) | 878 px | **798 → 899** | 560 → 900 |

The composer was entirely outside its column in both cases, so the bug existed with the managed agents shown too. Hiding them made it obvious: the inbox moved directly under the chat. At 1920 px with the managed agents shown (four columns, the main area 851 px tall), the composer fitted.

### 2. "A big scroll on the page": the shell was only a minimum height

- `.pnl` was `min-height: 100vh`. Only `.pnl-with-scene` set `height: 100dvh`, and that was reset to `height: auto` at ≤1100 px.
- In **list mode**, the grid's single row grew to the tallest column (the inbox's content). The navigation and the main area stretched to the same height, so their lower part was empty page you could scroll to. At 1280 × 900: `scrollHeight` 2473, with the navigation, main area and side column each 2424 px tall. At 1280 × 900 with the agents hidden: 2100.
- With the scene at **≤1100 px** (stacked), the grid was `45vh auto auto auto`, so the page grew to the stacked content: `scrollHeight` 3538 at 1100 × 800 and 8100 at 390 × 800. On the phone the chat alone was 5143 px tall, because the 720 px rule removed the thread's cap.
- One more way out, found once the shell was fixed: an absolutely positioned visually hidden label far down a long column has the initial containing block as its containing block. Its static position stretched the document past `overflow: hidden`: the settings page had `scrollHeight` 1759 in a 700 px viewport. Now every scroll container is `position: relative`.

## The new layout

**Wide (≥1101 px).** Three columns under the top bar: the navigation (left, full height), the centre, and the side column (right, full height: the managed agents when shown, then the inbox). The centre is a flex column: the scene above, and the **dock** (the main area: the Harmonizer or Waykeeper conversation, or the Steward view) at the bottom, between the two side columns.

- **Split, not overlay.** The scene shrinks above the dock; the dock never covers it. With an overlay, the scene's own overlays (breadcrumb bottom-left, True scale bottom-right, fps meter, labels, hover card, popovers) would sit under a translucent chat and fight it for the pointer. Picking would also have to ignore the hidden part of the canvas. With the split, every overlay stays inside `.pnl-scene` (its own smaller box), the camera frames what you can actually see, and "no panel covers another" holds by construction. The canvas follows its parent's size (R3F's resize observer), so dragging the handle resizes it.
- **Column widths.** Scene shown: navigation 180–220, side column 300–360 (280–340 without the managed agents). At ≥1700 px: 200–240 and 340–420 (300–380). List mode: 200–260 and 260–360 (240–320). The old fourth column at ≥1700 px is gone: the conversation no longer needs one.
- **The dock's bar:** the eyebrow and title ("Talking to · Harmonizer", "Watching (read-only) · Steward of …"), the state pill (a Steward's "blocked on you" beacon first), an "N new" badge for replies that arrived while minimised (`role="status"`, "N new replies"), the current activity (ellipsised), "← Harmonizer", the Waykeeper's controls strip (pause/resume inline; More opens below, or upwards when the bar is low on the screen — measured when it opens), and the **Minimise / Restore** button (`aria-expanded`, `aria-controls="pnl-dock-body"`, named "Minimise the conversation" / "Restore the conversation"). In the dock, the chat's own head line (state + activity) is hidden because the bar shows them.
- **Height.** A handle on the dock's top edge (`role="separator"`, `aria-orientation="horizontal"`, `aria-valuenow` in percent): drag it, or focus it and use ↑/↓ (±5 %), Page Up/Down (±10 %) and Home/End (25 % / 75 %). The height is a share of the centre, clamped to **25–75 %** (default 45 %). A drag is saved when it ends.
- **Minimised:** only the bar is left; the scene takes the rest. The body stays mounted and laid out but collapsed (`height: 0; visibility: hidden`, `inert`, `aria-hidden`; not `display: none`, which dropped the thread's scroll position), so the thread, where it was scrolled to, its live subscription and the "N new" count survive. Drafts are kept per agent in the conversation store. Restore brings back the last height. The thread keeps to its bottom when its box changes height (resize, restore).
- **Remembered per browser:** `localStorage['galactic.panel.dock'] = {"open": bool, "size": 25–75}`, in try/catch and validated on read, like the scene's and the managed agents' choices (decisions 62, 69).
- **List mode (scene hidden):** the dock is the whole centre, with no handle and no minimise button. There is nothing for it to give the space to.
- **Inbox.** Showing or hiding the managed agents only changes the side column's content; the inbox stays in the side column and never overlaps anything.

**Stacked (≤1100 px, `STACKED_LAYOUT_QUERY`, both modes).** One scrolling area holds the scene (40dvh, at least 200 px), then the navigation and the side column: side by side at 761–1100 px, one under the other at ≤760 px. The dock sits under that area, with the same bar, handle (sized against the whole area), and minimise/restore. Minimised, its bar is pinned at the bottom of the viewport, above the bottom safe area the shell pads for (`env(safe-area-inset-bottom)`, P3-12). On the phone the bar is one row: no eyebrow, and the button is a 44 × 44 icon (▾ / ▴) whose name stays spoken. The minimise works in list mode too, because the navigation and the inbox share the screen with the chat. The compact top bar's "N waiting" button still scrolls the inbox into view inside the stack. React renders a different tree on each side of 1100 px, so crossing it remounts the scene and the chat (see Deferred).

**No page scroll anywhere.** `.pnl` is `height: 100dvh; overflow: hidden`. `.pnl-body` (`flex: 1 1 0; min-height: 0; overflow-y: auto`) holds the grid, or the settings, history or first-run page, which now scroll inside it. The grid has one `minmax(0, 1fr)` row. Every column scrolls on its own (`overscroll-behavior: contain`).

## Proposed SPEC decision (for §7, next free number — 71 at the time of writing)

| 71 | Docked conversation | **The chat docks under the scene and minimises; the page never scrolls** (2026-10-03, P4-10; refines §4.2, decisions 62, 67, 69): the panel is exactly the screen's height and never scrolls as a page; each column scrolls on its own. On wide screens the navigation is on the left and the side column (managed agents when shown, then the inbox) on the right, both full height. Between them the solar-system scene fills the centre, and the conversation (or the Steward view) is docked at the bottom of the centre, under the scene, which shrinks to make room; nothing covers anything. The dock's bar names who is selected and shows its state, its current activity, the Waykeeper's controls, and, while minimised, how many replies came in. A button minimises the dock to that bar and restores it. A handle on its top edge (drag, or arrow keys) sets its height, between a quarter and three quarters of the centre. Minimised or open, and the height, are remembered per browser (a device preference). With the scene hidden, the conversation fills the centre and does not minimise. At 1100 px and below, the scene, the navigation and the side column scroll together above the dock, which minimises there too, its bar staying at the bottom of the screen above the phone's home bar. Hiding the managed agents changes only the side column. This replaces decision 69's "beside the scene the inbox moves under the conversation" and "at four columns the scene takes the freed column". |

## Screenshots (headless Chrome over CDP, SwiftShader WebGL2, the harness above; 800 px tall unless noted)

Every width (320, 390, 760, 1100, 1280, 1440, 1700, 1920, 2560) was checked with scene shown/hidden × managed agents shown/hidden × dock open/minimised (72 page loads, run twice: after the layout change and after the containing-block fix). Every load had `document.scrollingElement.scrollHeight == innerHeight` and `scrollWidth == innerWidth`. No pair among the top bar, navigation, scene, dock and side column intersected, after clipping each box to its scroll containers, and no box ended outside the viewport. Also checked: 1280 / 1920 / 390 × 560 tall; the settings page at 1440 and 390 × 700 (`scrollHeight` 700, the page body scrolling 2714 / 3495 px inside); dragging the handle with real mouse events (up to 75 %, down to 25 %, saved as `{"open":true,"size":75}` / `25`); a Waykeeper and a Steward selected.

- **320 / 390, scene, dock open:** compact top bar; scene 320 px; the navigation's first row peeking under it in the stack (scrollable); the dock (337 px) has the handle pill, "Harmonizer · working · Editing…" and a 44 px ▾ button in one row, the last reply, the typing line, and the composer with Send, all in view. **Minimised:** a 57 px bar at the bottom ("Harmonizer · working · working: Editing…" + ▴); the stack (scene, navigation, managed agents, inbox) scrolls above it.
- **760:** the same stack, one column, with the side column under the navigation.
- **1100:** wide top bar (two rows); scene 320 px across the full width; navigation (260 px) and side column side by side under it in the stack; the dock under the stack (322 px open, 44 px bar minimised: "TALKING TO Harmonizer · working · Editing src/session.ts … ▴ Restore").
- **1280 / 1440:** three columns. Navigation 220, the scene above the dock in the centre (at 1440 × 900: scene 467, dock 384), side column 340–360 full height (managed agents, then the inbox; with them hidden, the inbox alone from the top). The breadcrumb and "True scale" sit at the scene's bottom edge, just above the dock's handle. Minimised: the scene 807 px tall, the bar 44 px.
- **1700 / 1920 / 2560:** the same three columns with a 240 px navigation and a 380–420 px side column; the scene and the dock are 1040–1940 px wide.
- **List mode, wide:** navigation, the conversation as the whole centre (751 px tall, no handle, no minimise button), side column; the composer at the bottom of the centre.
- **Waykeeper (1440):** the bar wraps to a second row for the controls strip (project · Pause, agent · Pause, More), then Minimise; the plan/question cards and the composer in the body. **Steward (1280):** "WATCHING (READ-ONLY) Steward · …", "blocked on you" and the state in the bar; the Steward view (status, facts, transcript) scrolls inside the dock.

## Tests

`apps/web/src/panel/docked-chat.test.tsx` (31 tests; the scene's three.js module stubbed, WebGL "available"):

- placement: nav | centre | side; the scene and then the dock inside the centre; the bar's title, activity and minimise button (`aria-expanded`, `aria-controls`)
- minimise / restore: classes (`is-open` / `is-minimised`, `pnl-grid-dock-open` / `-min`), the hidden body still holding the chat, no handle while minimised, persistence across reloads in both directions
- a draft survives minimise and restore; the "N new replies" count (text chunks only) while minimised, gone on restore
- keyboard resize with clamping (↑, End, ↑ past the max, Home, ↓ past the min, Page Up), the CSS variable, persistence, back at the last height after minimise + reload + restore
- pointer drag against a mocked centre box (75 %, clamped to 25 %, saved only on pointer-up)
- `clampDockSize` / `readDockPrefs` validation (bad JSON, out-of-range or wrong-typed size); a browser without storage
- the scene's overlays (breadcrumb, scale toggle, labels layer) are inside the scene area and not in the dock, and neither contains the other
- a Waykeeper's bar carries its controls strip; a Steward's bar shows "blocked on you"
- layout classes for all 8 combinations of scene × agents × dock, wide (list mode: no minimise, no handle, body shown even if the stored choice is "minimised"; the inbox always in the side column, never in the centre) and stacked (stack = [scene?, nav, side], dock after it, minimise available); the phone with the compact bar
- CSS rules read from the sheets: `.pnl` is `100vh`/`100dvh` with `overflow: hidden` and no `min-height`; nothing resets it to `height: auto` or `min-height: 100vh`; `.pnl-body` and `.pnl-grid` are `flex: 1 1 0; min-height: 0`; no `grid-template-rows` in panel.css has a fixed length; `.pnl-thread` has no `max-height` or `calc(100vh …)`

No existing test needed changing: the `main` landmark ("main area"), the regions and the button names stayed the same. Gates from the repo root: build, typecheck, lint, format:check and test all green (protocol 67, server 845 + 1 skipped, web 731). three.js is still only in the lazy `SolarScene` chunk.

## Deferred

- Crossing 1100 px remounts the scene (a new WebGL context) and the chat (since the review fixes a draft survives: it is in the conversation store), because the two layouts are different trees. Resizing a window across the breakpoint is rare. A CSS-only stacked layout would need the navigation and the side column in one scroller, which the wide layout cannot have.
- Selecting another agent (in the scene or the navigation) while the dock is minimised keeps it minimised; the bar's title changes. Auto-restoring could be friendlier, but it would undo the user's choice while they explore the map. Worth asking Cosmin.
- The Steward view keeps its own status header in the dock (state and activity appear twice while open). Its transcript (`.stw-log`, 60vh cap) and the whole view scroll inside the dock body; making the log fill the dock like the chat thread would be a follow-up.
- No keyboard shortcut to minimise or restore.
- At the 25 % minimum on a short window the thread showed only a line or two; the review fixes added a 160 px floor (within the 75 % maximum).
- Cosmin's running app was not loaded (it needs his token); the reproduction used the same code in the harness.

## Review fixes (2026-10-03, branch `p4-10-fixes`)

- **More menu (blocker).** The blanket `.pnl-dock-bar .ctl-menu { bottom: 100% }` sent the menu up out of sight in list mode (the bar at the top of the centre) and in the stacked layout. `placeMenu` (`controls.tsx`) now measures when the menu opens: below its row unless the room below is less than its height and the room above is larger; capped to that room (`max-height`, scrolls inside) and shifted sideways to stay on screen. Headless Chrome at 390 / 1100 / 1280 / 1920 × 800, list mode (dock open and stored-minimised), scene with the dock open and minimised: below everywhere except a minimised bar at the bottom (above); the menu fully in the viewport and topmost at its centre and corners in all 16 cases; `scrollHeight == innerHeight` and `scrollWidth == innerWidth` before and after opening.
- **Drag performance.** The drag writes `--pnl-dock-size` and the handle's `aria-valuenow` straight onto the elements and commits to state once, on pointer-up (test: 40 moves, no React commit, at most two on release, one storage write). `SceneArea`, `Navigation` and `SideColumn` are memoised (`useManagedAgentsVisibility` and `useDockPrefs` return stable objects); the R3F `Canvas` debounces resizes by 50 ms, so the canvas is CSS-stretched during a drag and the renderer/composer resize once it pauses.
- **Scroll position on minimise.** See above; the thread also remembers where the user left it while visible and puts it back when its box regains height, ignoring scroll events while it has no height. Checked in Chrome (thread scrolled to 400, minimise, restore: 400, at 1280 and 390).
- **Drafts.** Per agent in `useConversationStore.drafts`: switching agents keeps each, remounting the chat (crossing 1100 px) keeps it, sending clears it. The single-tree layout spike (`display: contents` on the stack above 1100 px, so the scene and the chat would not remount) was **not attempted**: the wide grid needs the navigation and the side column as grid items while the stacked layout needs them inside one scroller, and moving the scene would still remount it; too risky for this batch. Crossing the breakpoint still remounts the scene (a new WebGL context).
- **Nits.** On the phone the open dock's bar starts under the 14 px handle (`padding-top: 14px`), so the handle never takes a tap meant for the 44 px buttons. The landmark is named "Conversation with <name>" ("Steward · <task>" for a Steward). The open dock has a pixel floor: `max(var(--pnl-dock-size), min(160px, 75%))`. The "N new" count is an `UnreadReplies` badge mounted only while minimised and keyed by the agent, so its baseline is taken on mount (no setState during render or in an effect). The bar shows the status record's **current activity**, not a typing indicator; the thread's own "<name> is working: …" line is the closest thing to one.
- Tests: docked-chat 42 (was 31), controls-strip 11 (was 8); web 745.
