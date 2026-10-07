# P8-15 — Hidable navigation sheet on phones

Branch `p8-15-nav-sheet`, from `p8-wave5-composer-mobile` (5a40d66). Cosmin's request: on the
phone the left navigation (the Harmonizer, the projects, the asteroids) should be a sheet that
slides in from the left and hides again, instead of a block in the stacked page.

## Design

- **Where.** Only below the compact width (`COMPACT_TOP_BAR_QUERY`, ≤ 760 px, the breakpoint of
  the compact top bar, decision 67, and of list-mode-by-default, decision 94) and only on the
  panel route. Tablets (761–1100 px, still stacked) and desktops are unchanged: the navigation
  stays in the stack / the left column (checked in jsdom and in a 820 px screenshot).
- **Components** (`apps/web/src/panel/nav-sheet.tsx`):
  - `useNavSheet(active)`: plain component state, closed on every load and whenever the phone
    layout goes away (a rotation, a wider window). **Not persisted** — a navigation drawer left
    open would cover the page on the next visit; every load starts hidden.
  - `NavSheetButton`: first item of the compact bar, before the brand (the side the sheet comes
    from). 44 × 44, a sidebar glyph (distinct from the menu's three bars), `aria-haspopup="dialog"`,
    `aria-expanded`, `aria-controls` while open (axe flags a reference to the closed, aria-hidden
    sheet). Name "Agents"; with questions waiting for the user (the Harmonizer row's "N for
    you"), an amber dot and the name "Agents, N waiting for you". The bar already shows the
    count, so the button carries a dot, not a second number.
  - `NavSheet`: a fixed overlay (`z-index` 1010, over the app's notices, which are inert behind
    it) with a scrim and a panel `min(320px, 85vw)` wide, safe-area aware, holding the same
    `<Navigation>` (so rows, "⋯" actions, "Show closed" and arrow keys work as before). Always
    mounted on a phone (open rows and scroll position survive); closed it is translated off
    screen, `visibility: hidden`, `inert` and `aria-hidden`.
  - `useEdgeSwipe`: document-level touch listeners (capture, passive).
- **Open:** the button, or a one-finger swipe that starts within 24 px of the left edge and goes
  ≥ 48 px right, mostly sideways (|dx| > 1.5 |dy|). Two fingers never count. Touch events, not
  pointer events: the browser cancels a pointer once it starts scrolling, a touch it does not.
  Mouse input never swipes.
- **Close:** a selection (any plain click on a link in the sheet, including the row already
  selected; any route/selection change too), a tap on the scrim, Escape, the × button, or a
  one-finger swipe ≥ 48 px to the left on the sheet or the scrim (the panel has
  `touch-action: pan-y pinch-zoom`, so vertical scrolling and zoom stay the browser's).
- **Dialog semantics:** `role="dialog"`, `aria-modal="true"` while open, labelled "Agents" (a
  visible "Agents" heading with the × beside it). On open the focus goes to the selected row
  (else the first row), then everything outside the sheet (each sibling of it and of its
  ancestors up to `<body>`) becomes `inert`; Tab and Shift+Tab wrap inside the sheet, and a
  focus that lands outside (browsers without `inert`) is pulled back. On close `inert` is removed
  and the focus returns to the "Agents" button (if it was in the sheet or lost; a tap elsewhere
  keeps its own focus). Escape is the sheet's only after anything inside that takes it first (a
  row's "⋯" actions, a confirmation: they `preventDefault` / stop it); `aria-modal` also keeps a
  replay's page-wide Escape away (`ReplayBar`'s `PAGE_LAYERS`).
- **Reduced motion:** the sheet gets `is-still` from `REDUCED_MOTION_QUERY` (no transition), and
  its own `@media (prefers-reduced-motion)` block; the panel-wide P5-04 rule applies too.
- **Scene:** the canvas keeps `touch-action: none` everywhere. A touch that starts in the 24 px
  edge zone *over the canvas* has its `pointerdown` stopped at the document (capture), so it
  does not start an orbit while it opens the sheet; the rest of the canvas orbits as before
  (decision 92). Taps elsewhere in the edge zone are untouched (no overlay element).
- **Layout around it:** with the navigation out of the stack, a phone in list mode with both
  side sections hidden would leave an empty band above the dock: `pnl-grid-dock-fills` lets the
  dock take the whole height then. The compact bar now has six items; at ≤ 399 px its gap is
  4 px, at ≤ 374 px its side padding 8 px and the brand 13 px (measured: the menu button's right
  edge at 320 / 360 / 375 / 390 / 414 px is 314.7 / 352 / 371.5 / 378 / 402 — all inside).

## Found on the way

Under reduced motion the panel-wide P5-04 rule (`transition-duration: 0.01ms !important` on every
`.pnl *`, property `all` by default) makes descendants *transition* the inherited `visibility`:
the rows stayed `visibility: hidden` for a frame or two after the sheet opened, and Chrome
dropped the `focus()` (seen in Playwright, not in jsdom). Fixed with `transition: none` on the
sheet's descendants (under reduced motion only, since the review), plus a one-frame retry of the
focus. Any other component that reveals
content by `visibility` and focuses it at once would hit the same thing.

## Tests

- jsdom `apps/web/src/panel/nav-sheet.test.tsx` (12): hidden on load and out of the stack;
  button name and dot; open as a modal (focus on the selected row, page inert, Tab/Shift+Tab
  wrap, escaped focus pulled back); selection closes (also of the current row) with focus back
  on the button and the dock showing the selection; Escape / scrim / × close; Escape in a row's
  actions is theirs first; edge swipe opens only from the edge, sideways, far enough, one finger;
  swipe left closes; an edge touch on a canvas is kept from the scene; reduced motion (class and
  stylesheet); not persisted across a remount; tablet and desktop unchanged; dock fills.
- axe (`a11y/axe.test.tsx`): phone width with the sheet closed and open — no serious/critical
  findings (the existing moderate "region" on the "Show scene" row is unchanged).
- Playwright `e2e/tests/06-phone-nav.spec.ts` (390 × 844, `isMobile`, `hasTouch`): the button
  opens the sheet, the focus is on the selected row, tapping a project closes it with the focus
  back on the button and the dock on the Waykeeper; a scrim tap closes; a swipe from the edge
  (CDP `Input.dispatchTouchEvent`) opens it, one from mid-screen does not, a swipe left closes.

## Screenshots (headless Chrome, iPhone UA, 390 × 844 @2x)

`scratchpad/shots-p815/`: closed in list mode (the button with its dot left of the brand, the
stack starting with "Show scene" and the managed agents); open (sheet ~320 px over a dimmed
page, the Harmonizer row focused/selected); after selecting a project (closed, the dock on the
Waykeeper); with the scene shown, closed and open (the scene's legend and scale toggle under the
scrim); mid-slide frames without reduced motion; 320 px closed and open; dock filling with both
side sections hidden; tablet 820 px unchanged; light theme. Chrome's mobile tap highlight shows
briefly as a blue square on the button in the mid-slide frames (the browser's, not the sheet).

## iOS Safari's back swipe

Not testable in emulation: Chrome has no edge-swipe navigation. On a real iPhone in a Safari
tab, the system's back gesture also starts at the left edge; when there is history to go back
to, Safari is expected to take the gesture (the page gets `touchcancel`) and go back — within
the app (selections are history entries), so the user lands on the previous selection rather
than in the sheet. Installed as a PWA (standalone, P7-01) there is no back swipe and the edge
swipe is the sheet's. The button is the primary way; the swipe is a convenience. **To check on
a real iPhone**: Safari tab vs. installed app, with and without history.

## Review fixes (2026-10-07, branch `p8-wave5-review-fixes`)

SPEC decision 117 and TECHNOLOGY §2.4 updated.

- **S2 — the system's Back.** The user's phone (Samsung S24, One UI gesture navigation) takes a
  swipe from either edge as Back before the page sees it, so the edge swipe mostly navigated back:
  with the sheet open, Back changed the selection, or at the installed app's first entry left the
  app. Now opening pushes `{navSheet: true}` (same URL; not if the top entry is already the
  sheet's); `popstate` while open closes it (selection untouched, focus back on the button);
  closed any other way (scrim, ×, Escape, swipe, the current row, leaving the phone layout) it
  calls `history.back()` once — `backPending` guards a second call before the `popstate`, and a
  sheet reopened meanwhile pushes its entry again when that `popstate` arrives; a selection made
  in it is a `navigate` that *replaces* the sheet's entry (`state/store.ts`: an entry with
  `navSheet` on top is replaced, not pushed over), so Back after it goes to the previous
  selection. A sheet entry found on load (a reload) is turned into a plain one. The "Agents"
  button stays the primary way. Tests: jsdom history (Back closes and keeps the selection; ×
  and Escape take the entry back; a selection then Back goes to the previous selection; the
  current row takes the entry back) and Playwright `page.goBack()` with and without reduced
  motion.
- **N3** — `.pnl-nav-sheet-panel * { transition: none; }` only inside `@media
  (prefers-reduced-motion: reduce)`; the e2e checks the focus on the selected row under reduced
  motion too.
- **N4** — a selection in the sheet puts the focus on the new page's title (`main h1`, decision
  81), with a few frames' grace while the dock renders; other closes still go to the button.
- **N5** — `inertOutside` also makes inert what is added beside the page while the sheet is open
  (a `MutationObserver` on each ancestor's children), undone on close. The sheet stays where it is
  in the tree (a portal at body level would leave the `.pnl` scope its styles and variables need).
- **N6** — Tab stops skip elements without client rects (CSS-hidden), where the browser has
  layout (jsdom has none: the check is skipped there; a test stubs `getClientRects`).
- **N7** — an edge swipe that starts on a horizontally scrollable element (overflow-x auto/scroll
  and wider content) is that element's.
- The swipe e2e no longer seeds a project: the harness's seven planets are all taken by the time
  the new Back test seeds one.

## Decision 117 (not yet in SPEC §7)

(Superseded: decision 117 is in SPEC §7, reworded by the review for Back and the focus after a
selection.)

| 117 | The navigation as a sheet on phones | **On a phone the navigation slides in from the left and hides** (2026-10-07, P8-15; refines decisions 67, 71, 81, 92, 94): at 760 px wide or less the panel's navigation (the Harmonizer, the projects, the asteroids) is not part of the page: it is a sheet, hidden by default, that slides in from the left over the dimmed page. The top bar's first item, an "Agents" button (with a dot while something waits for the user), opens it, and so does a one-finger swipe that starts at the screen's left edge; it closes when something is selected in it, on a tap on the dimmed page, on Escape, on its close button and on a swipe to the left. While open it is a modal dialog: the focus moves to the selected row, stays in the sheet, and goes back to the "Agents" button on close. With the system's reduced-motion setting it appears and goes without sliding. Whether it is open is never remembered: every load starts with it hidden. Gestures on the scene are unchanged, except that a touch starting at the very left edge belongs to the sheet. Wider screens keep the navigation where it was. |
