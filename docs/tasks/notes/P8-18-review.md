# P8-18 final whole-branch review — 45920fb..d13269d

Reviewer: final code reviewer (read-only). One pass over the review package, plus reads of the
code it touches at HEAD (`nav-sheet.tsx`, `state/store.ts` navigate, `App.tsx` location sync,
`a11y.tsx` listKeys/OPEN_LAYER, `notifications/focus.ts`, `pwa/notification-clicks.ts`,
`phone/PhoneIndicator.tsx`, `panel.css`). No suites re-run; every finding below is from reading
the code. None needed a focused test to settle.

## Strengths

- `phone-view.ts` is a clean module store. It copies the nav sheet's history pattern
  (`enterEntry`/`leaveEntry`/`backPending`), and it keeps the `popstate` listener installed for
  good (the executor's ruling), which is the right call: an unmount part-way through a `back()`
  can no longer leave `backPending` stuck.
- `closePhoneViewThen` gets the order right: the sheet's push waits for the view's own
  `back()` to land. Listener order also works out: `App`'s `syncFromLocation` (registered in a
  layout effect) runs before phone-view's `onPop` (registered in a passive effect), so its
  `replaceState(null)` cannot wipe the `{navSheet:true}` entry pushed in `afterBack`.
- Crossing 760px: the `[isActive]` cleanup closes the view and takes its entry back once.
  `MainArea` keeps its place among the grid's children, so the conversation is not remounted.
  The draft also lives in the store. A wide screen goes back to `SideColumn` with the P4-09/P4-12
  prefs untouched.
- The `ManagedAgentsSection`/`InboxSection` split is tidy, and `InboxSection` keeps
  `useFocusRescue` on the `tabIndex=-1` region (Review Focus 4 is tested and holds).
- The Settings/History ruling (compact bar buttons on every page, `openPhoneViewWhenReady`) is
  sound and better than the plan.
- Docs: decision 140, the §4.2 line, the TECHNOLOGY paragraph and the IMPLEMENTATION_PLAN line
  agree with each other and with the code.

## Issues

### Critical

None.

### Important

1. **A link inside a full view changes the selection under the view, which stays open.**
   `Panel.tsx:113` / `Panel.tsx:207`; `state/store.ts:197`.
   - **What happens:** The managed-agents cards' names are `NavLink`s (`AgentCards.tsx:99`), and
     inbox cards carry "open agent" links (`CardLinksContext` is true for the whole panel).
     Tapping one runs `navigate()`. That changes the selection in the inert chat underneath while
     the opaque view stays up, so the phone user sees nothing happen. In the agents view, picking
     a Steward even swaps the list for a bare "Reports to" link with no heading. Tapping the
     menu's Settings/History links has the same history effect.
   - **History fallout:** `navigate` only replaces an overlay entry that is `navSheet`, so it
     pushes over `{phoneView:true}`. The view's entry is left in the middle of the history: the
     ✕ then cannot take it back, and a later Back lands on a dead entry (or reverts the selection
     and closes the view in one press). That contradicts decision 140's "Back never … changes the
     selection".
   - **Fix:**
     - Close the view on a route/selection change, as `NavSheet` does with its `location`
       effect. Take care not to undo `focusTarget`, which navigates and then opens the inbox.
     - Make `navigate`'s overlay check also cover `phoneView` (replace the entry instead of
       pushing).
     - Add a test: tap an agent link in the agents view, and the chat for that agent shows.

2. **The new `.pnl-phone-dot` rule collides with P9-16's phone indicator dot.**
   `panel.css:336` vs `panel.css:1293`; `TopBar.tsx:272`; `PhoneIndicator.tsx:43`;
   `PhoneAccessSection.tsx:90`.
   - **Inbox count dot:** Both rules are single-class selectors in the same file, so the later
     one wins. The count dot therefore gets `width/height: 8px`, `border-radius: 50%` and the
     muted grey background. The result is a grey 18×8 ellipse (because `min-width: 18px`) with
     its 18px line-height number spilling out, instead of the beacon-coloured 18px badge.
   - **P9-16 indicator (top bar, desktop included) and Settings → Access:** the new rule's
     `position: absolute; top/right: -5px`, `min-width: 18px`, padding and box-shadow now apply to
     that dot. It is pulled out of the flow onto the corner of the nearest positioned ancestor.
   - The e2e's `toBeVisible()` cannot catch this.
   - **Fix:** rename the new badge (e.g. `pnl-phone-count`) and update the tests and the e2e.

3. **Arrow-key navigation between cards (P5-04) is dead inside the full view.**
   `PhoneFullView.tsx:55`.
   - **Why:** The view's root carries `data-escape-layer`, and `listKeys` returns early whenever
     `target.closest('[data-escape-layer], .agc-confirm')` matches (`a11y.tsx:141`). Every inbox
     and agent card is inside that root.
   - **Who hits it:** a narrow desktop window (≤760px) or a phone with a keyboard.
   - **Fix:** drop `data-escape-layer`. `ReplayBar`'s `PAGE_LAYERS` already treats
     `[aria-modal="true"]` as a layer, so its Escape stays out of the way. Add a test: ArrowDown
     between two cards in the inbox view.

4. **A notification click from Settings or History on a phone does not open the inbox.**
   `notifications/focus.ts:75`.
   - **Why:** `focusTarget` navigates to the panel and then checks `phoneViewActive()`
     straight away. `active++` only happens in Panel's effect after the re-render, so the check is
     false on those pages. The click falls through to `scrollInboxIntoView`, which looks for an
     inbox that no longer exists on a phone, so nothing opens.
   - **Who hits it:** a PWA left on Settings when a push arrives, and the desktop app's
     `#focus=question:` path from those pages.
   - **Fix:** decide by `COMPACT_TOP_BAR_QUERY` (matchMedia) rather than `active`, and call
     `revealInbox()`. Its per-frame `bringInbox()` retry already opens the view once the panel
     mounts.
   - The test only covers a click made while already on the panel.

5. **The rotation test does not rotate.**
   `phone-single-screen.test.tsx:116`.
   - "…across the inbox, Back and a rotation" defines a mutable `width.phone` but never flips it.
     Its `matchMedia` stub has no-op listeners, so flipping it would not re-render anyway.
   - Review Focus 1 and 5 asked for a Panel-level test that crosses 760px with a view open: the
     view drops, the history entry goes once, the side column shows on wide, and the draft is
     intact after going wide and back. Only the hook-level test exists.
   - The behaviour looks correct when reading the code, but nothing proves it.
   - **Fix:** use a `matchMedia` stub whose `change` listeners fire (as `nav-sheet.test.tsx` /
     `stubMedia` patterns allow).

### Minor

1. **The view is announced as modal but does not act modal.** `PhoneFullView.tsx:52`.
   - `role=dialog aria-modal=true`, yet Tab leaves it for the live top bar, and nothing traps
     the focus.
   - For screen-reader users, `aria-modal` hides the top bar's Inbox/Managed agents/Menu buttons
     while the view is open. Only ✕ and Escape remain.
   - This is acceptable, but decide which it is. Either trap Tab and keep the dialog, or keep
     the bar reachable and accept the axe landmark rename instead (the executor's ruling chose
     dialog for axe's `landmark-unique`).
2. **Closing the view by crossing 760px loses the focus.** `PhoneFullView.tsx:37`. The cleanup
   focuses `.pnl-phone-inbox`/`.pnl-phone-agents`, which the wide bar does not have, so the
   focus falls to `body`.
3. **A sheet open when a beacon or notification opens a view leaves one dead history entry.**
   `Panel.tsx:129`. This is the executor's acknowledged ruling. A related focus wobble: while the
   sheet is still open, its `focusin` trap pulls the view title's focus back into the sheet, and
   its cleanup then focuses the ☰ button. `revealQuestion`/`revealInbox` refocus over the next
   frames, so the end state is acceptable.
4. **Opening a view during the first-run wizard or the settings-read gate does nothing visible.**
   `openPhoneView` succeeds (`usePhoneView` sits outside `FirstRunGate`), the entry is pushed and
   the button shows pressed, but `PhoneFullView` is inside the gate.
5. **The exclusion test does not check the history.** `phone-single-screen.test.tsx:175`. The
   plan asked it to assert "one history entry pushed overall"; it does not check
   `history.length` or `history.state`.
6. **The phase header will clash with the P8-19 branch on merge.** The board edit in the done
   commit sets the PHASE_8 header and README row to "P8-19 in progress (branch
   `p8-19-question-sets`)". P8-19's claim commit lives on another branch, so expect a merge
   conflict on those lines. Keep the merged result truthful.
7. **With the scene shown, the canvas keeps rendering under an opaque full view.** This costs
   battery on a phone. Pausing the scene while a view is open would be cheap.

## Recommendations

- Treat the phone view as an overlay in `navigate` exactly like the sheet, and give it the same
  "close on location change" rule. Those two lines fix Important 1 and most of the stray-entry
  minors.
- Avoid reusing generic class names across features (`pnl-phone-*` already belonged to P9-16's
  phone access).

## Declined to judge

- iOS Safari / Samsung One UI real-device Back gesture timing against two module-level
  `popstate` listeners. This needs a device; jsdom and Playwright do not reproduce gesture
  navigation.
- The visual quality of the CSS-drawn inbox/satellite icons. Icons are left to the builder in
  the spec.
- Whether `aria-pressed` toggle semantics on buttons that open a dialog is the preferred
  pattern. It is a design-system call, with no spec rule either way.

## Assessment

**Ready to merge?** With fixes.

**Reasoning:** The store, the history handling and the layout split are well built, and the
focus items 1–5 mostly hold. However, links inside the views silently navigate under an open
overlay (and leave a stray entry), the dot class breaks both the new badge and P9-16's
indicator, and the view kills P5-04's arrow keys. All three are small, contained fixes.
