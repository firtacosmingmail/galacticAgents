# P3-12 — Top bar on small screens

Cosmin, from his phone: "on mobile the menus on the top are mixed in each other, a better design is needed there, maybe a hamburger menu, or something better suited for mobile."

## Why the controls overlapped

The top bar is a wrapping flex row. Its links (brand, History, Settings, Ops console) are `NavLink`s and carry `.pnl-link`, the navigation's row style, which has `flex: 1; min-width: 0`. In a bar too narrow for one row, the browser shrank those links to nothing before it wrapped anything, and their text spilled over the neighbouring controls. At 390 px "GalacticAgents" sat on top of "live", "History" ran into "Settings", and "Ops console" was clipped at the edge. The same overlap showed at 1100 px (brand over "live"). At 1440 px the same rule stretched History, Settings and Ops console over the free space.

## What was built

- **`panel/TopBar.tsx`**: the top bar, moved out of `Panel.tsx` with the scene toggle. `TopBar` picks one of two bars with `useMediaQuery(COMPACT_TOP_BAR_QUERY)`, so only one set of controls is ever in the DOM.
  - **Wide bar**: the same markup as before, in the same order. The one visible change is the CSS fix below.
  - **Compact bar** (`max-width: 760px`): one row, 52 px tall, sticky at the top of the page:
    - the **GalacticAgents** link, which goes back to the Harmonizer (44 px tall touch target);
    - a **connection dot**: green when live, red when disconnected or unauthorized, grey otherwise (`role="img"`, `aria-label="connection: live"`, the state in `title`);
    - the **"N waiting for you"** beacon as a button (44 px tall). It is shown only when N > 0, as on the wide bar. Below 375 px it reads "N waiting"; the full words stay in its `aria-label`. Tapping it scrolls the inbox into view and focuses it. From the settings or history page it first goes back to the panel's main view, then reveals the inbox once it has mounted (the first-run gate can delay it).
    - a **menu button**: 44×44, three bars drawn in CSS, `aria-label="Menu"`, `aria-expanded`, `aria-controls="pnl-top-menu"`.
  - **The menu**: a full-width sheet that drops under the bar (`role="region"`, `aria-label="menu"`), scrolling on its own if it is taller than the screen. Its contents, top to bottom:
    - a summary line (connection state, open questions, blocked) as text;
    - Hide/Show scene, or "3D scene unavailable — list mode" plus Retry;
    - Notifications: *state*;
    - History;
    - Settings;
    - Forget token;
    - Ops console, last, smaller and muted.

    Every item is a real button or link, a full-width row at least 44 px tall. The current page's link gets the blue marker.
  - **Menu behaviour**:
    - Opening the menu moves focus to its first item.
    - **Escape** closes it and gives focus back to the menu button. So do the button itself, a menu link, and the scene toggle.
    - A **tap or click outside** (pointerdown or mousedown) closes it and leaves focus where the user put it. This is the disclosure pattern; pulling focus back to the button would fight the tap.
    - **Tabbing out** of the menu closes it.
    - **Any navigation** closes it: a menu link, the brand, a click in the navigation or the scene. The menu watches the route and the selection.
  - **Notifications in the menu**: the popover had no room to float on a phone. The menu has `NotificationsDisclosure` instead: the same "Notifications: *state*" button, now a disclosure (`aria-expanded`/`aria-controls`) that unfolds the same `NotificationSettings` in place, without its heading. Using it does not close the menu. The wide bar keeps the popover. The one-word state moved into `useNotificationState()`, which both share.
- **`panel/use-media-query.ts`**: `useMediaQuery(query)` (built on `useSyncExternalStore`, kept current on `change`) and `COMPACT_TOP_BAR_QUERY`. Without `matchMedia` (jsdom), nothing matches, so the wide bar is the default and existing tests are unaffected.
- **`panel.css`**:
  - `.pnl-top .pnl-link { flex: none }` fixes the squeezing at every width.
  - The compact bar and menu styles.
  - Safe areas: `index.html` now has `viewport-fit=cover`. `.pnl` pads left, right and bottom with `env(safe-area-inset-*)` (with `box-sizing: border-box`, so the scene layout's `100dvh` still fits). Both bars pad the top with `max(…, env(safe-area-inset-top))`. The menu pads its bottom for the home bar.
- **`Panel.tsx`**: renders `<TopBar>`. The inbox section has `id="pnl-inbox"` and `tabIndex={-1}`, so the waiting button can focus it.

## The breakpoint: 760 px

Measured in headless Chrome with real content (the brand, "live", "2 waiting for you", the counts, Show scene, Notifications: off, History, Settings, Ops console, Forget token):

- The full bar needs about 1,130 px for one row. From 761 to 1,130 px it wraps cleanly into **two rows** (82–92 px tall) with nothing overlapping. That is fine on a tablet or a narrow desktop window, where direct buttons beat a menu.
- Below about 760 px it needs three or more rows, and on a phone it would take a fifth of the screen. 760 also sits just above the panel's own 720 px one-column breakpoint, and it is the minimum the task set.

## Screenshots (headless Chrome over CDP, 760 px tall viewport, throwaway page seeded with the domain fixtures plus a user-held question and a pending card; deleted afterwards)

Automated checks at each width: the top bar's children don't overlap, no control's text overflows its box, no control is off-screen, and the page has no horizontal scroll (`scrollWidth === clientWidth`).

| Width | Bar | What the screenshot shows |
|---|---|---|
| 320 | compact, 53 px | "GalacticAgents ●" on the left. "● 2 waiting" (amber) and the ☰ button on the right. No horizontal scroll. Menu open: a summary line "● live · 2 open questions · 1 blocked", then Show scene, Notifications: off, History, Settings, Forget token (all 44 px rows, aligned), and the small grey "Ops console" (40 px) last. The sheet ends at y = 372 over the navigation, with a shadow. |
| 375 | compact | Same; the beacon reads "2 waiting for you". With "Notifications" unfolded, the menu grows to y = 683: the Enable button (44 px), the eight "Notify me when" checkboxes and the per-browser note, then History… below. |
| 390 | compact | Same as 375. The open menu button is tinted blue (`aria-expanded`). |
| 430 | compact | Same, with more free space between the brand and the beacon. |
| 768 | wide, 2 rows (86 px) | Row 1: GalacticAgents · live · 2 waiting for you · 2 open questions · 1 blocked · Show scene · Notifications: off. Row 2: History · Settings · Ops console · Forget token. Nothing overlaps (before the fix, "Ops console" was cut off and History/Settings ran together). |
| 1024 | wide, 2 rows (92 px) | Row 1 ends at Settings; row 2 holds Ops console and Forget token. |
| 1100 | wide, 2 rows (86 px) | As at 1024. Before the fix, "GalacticAgents" overlapped "live". |
| 1440 | wide, 1 row (49 px) | The Phase 2.5 bar. The only difference from before: History, Settings and Ops console keep their natural widths at the right, instead of being stretched across the free space. |

With the scene requested (`scene=1`), the bars are identical at 320, 768 and 1440. Headless Chrome ran with `--disable-gpu` and no WebGL2, so the panel stayed in list mode.

Not P3-12: at 390 px and below, the navigation's "blocked on you" badge on a long asteroid row and the side column's inline answer box at 1440 run past their column's edge. These are clipped by their columns, so the page does not scroll sideways. Each column already scrolls on its own; nothing was changed there.

## Tests

`apps/web/src/panel/TopBar.test.tsx`: 11 tests, jsdom, through `<App>` and the fake socket like `Panel.test.tsx`. Width is controlled with a `matchMedia` stub whose `change` listeners the test fires.

- **Wide**: the header's children are the same ten elements, in the same order, as before P3-12, with no menu button, and the summary text is unchanged. Resizing to narrow switches to the compact bar and back.
- **Compact essentials**: the brand link (to `/`, and clicking it selects the Harmonizer), the connection indicator, the "2 waiting for you" button and the menu button (`aria-expanded=false`, `aria-controls` pointing at a hidden menu) are all present. History, Settings, Ops console, Forget token and Notifications are not in the bar.
- **The menu opens** with every other action, in order: the scene control (the "unavailable" note in jsdom), Notifications, History, Settings, Forget token, Ops console. The summary is inside the menu, and focus is on the first item.
- **Hide/Show scene** from the menu, with a stubbed WebGL context: it flips the stored preference, closes the menu and returns focus to the button.
- **Closing**: the button, Escape (focus back on the button), and an outside pointerdown all close the menu; a pointerdown inside keeps it open. Tabbing out closes it.
- **Navigation closes it**: the History link (route, URL, focus back on the button), a navigation made elsewhere through the store, and the Ops console link.
- **Notifications disclosure**: it unfolds the settings in place (`aria-expanded`, `hidden` region) and does not close the menu.
- **Forget token** works from the menu.
- **The waiting button** focuses the inbox region, both from the panel and from `/settings` (where it navigates back first).

Existing tests are unchanged (`Panel.test.tsx` and the rest pass as they were). Gates: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check` and `pnpm test` are green. The web suite has 52 files and 520 tests.

## Proposed SPEC decision (for §7; not added here — SPEC is not edited by this task)

> **67 | The top bar on small screens | Essentials in the bar, the rest in a menu** (2026-10-03, P3-12; refines §4.2, decisions 58, 59, 62): below 760 px wide, the panel's top bar is one row with only the essentials: the app name (back to the Harmonizer), a connection dot, the "N waiting for you" count (shown when N > 0; tapping it opens the inbox, going back to the panel's main view first if needed), and a menu button. Every other top-bar action is in the menu, in this order: a summary (connection, open questions, blocked), Hide/Show scene (or "3D scene unavailable" with Retry), Notifications (its settings unfold inside the menu instead of a popover), History, Settings, Forget token, and the ops console link, last and small. The menu closes on Escape, on a tap outside, when focus leaves it, and on any navigation. Wider screens keep every control in the bar, wrapping to a second row when needed. The panel respects the phone's safe areas (notch, home bar).

## Deferred

- **The real phone.** Safari on Cosmin's iPhone over the LAN (Phase 7 brings remote access; the P3-08 device run can include this). Things to check there:
  - the sticky bar while the page scrolls;
  - the menu over the scene;
  - the safe-area paddings in landscape (the notch side), now that `viewport-fit=cover` is on.
- **The scene's own overlays** (breadcrumb, True scale, fps meter) are not part of the top bar and were not touched.
- **Long project names** in the navigation and the side column's inline answer box can still run past their column at phone widths (clipped, not scrolling the page). That is a panel-polish item for Phase 5.
- **Swipe-to-close and an animated sheet** were left out to keep the menu simple and reduced-motion friendly.
