# One Screen at a Time on Phones — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At phone width the panel shows one main screen at a time — the chat (default), the inbox, or the managed agents — switched from two top-bar buttons; desktop and tablet are unchanged.

**Architecture:** A small module store `panel/phone-view.ts` (like `inbox-visibility.ts`, so non-React callers — `revealInbox`, notification clicks — can open the inbox) holds `'chat' | 'inbox' | 'agents'` and owns a history entry like the nav sheet (Back closes the view). `Panel.tsx` stops putting the side column in the phone stack, lets the dock fill the screen in phone list mode, and renders `PhoneFullView` as an overlay over the grid (the grid becomes `inert` but stays mounted, so the composer, its draft and the thread's scroll survive). `CompactTopBar` swaps "N waiting" for an Inbox button with a dot and adds a Managed-agents button.

**Tech Stack:** React 19, TypeScript, Vitest + Testing Library (jsdom, `vi.stubGlobal('matchMedia', …)` as in `TopBar.test.tsx:26-40`), vitest-axe, Playwright e2e (`e2e/tests`).

**Spec:** `docs/superpowers/specs/2026-10-18-question-sets-and-phone-single-screen-design.md`, Part 2.

**Ticket:** P8-18 (added to `docs/tasks/PHASE_8_HARDENING.md`). Branch `p8-18-phone-single-screen` from `main` (Phase 8 is merged into `main`; P8-17 did the same). Commits `P8-18: …`.

## Global Constraints

- "Phone" = `COMPACT_TOP_BAR_QUERY` (`(max-width: 760px)`) **and** `route === 'panel'` — the existing `sheeted` flag in `Panel.tsx`. 761–1100px (stacked) and wider: no change.
- Inbox button: a dot while `waitingForUserCount(world) > 0` (held-by-supervisor items do not count); a count next to it is fine.
- Opening a view never unmounts the conversation; the composer draft already lives in the conversation store (`Panel.tsx` MainArea comment) — it must survive open/close and rotation.
- Back (browser / Android gesture) closes an open view, never leaves the app or changes the selection.
- The open view is not persisted: every load lands on the chat.
- With the scene shown on a phone: scene on top, docked chat below (today's dock, handle and minimise); the inbox and agent cards are no longer in the stack under the scene; the two buttons still open their full views.
- The page never scrolls (decision 71); each view scrolls on its own.
- A push/desktop notification click for a question, on a phone, opens the inbox view.
- Questions are answered inside the inbox view; it does not navigate to the asker's chat.
- Docs in the same work: SPEC §7 decision **140** (amends 67, 71, 75, 94, 117); TECHNOLOGY's web-layout paragraph; `docs/tasks` bookkeeping.

## Review Focus

1. **Rotation / resize while a view is open** — crossing 760px must drop the view (back to chat), take its history entry back once, and on a wide screen show the side column normally. → test in Task 1 (`usePhoneView` inactive) and Task 3.
2. **Nav sheet and a view at once** — opening the ☰ sheet while the inbox view is open (or the reverse) must not leave two history entries or a stuck `inert`. Rule: opening one closes the other. → test in Task 3.
3. **Inbox hidden per browser (P4-12 `inbox.visible === false`)** — on a phone the Inbox button still opens the full inbox regardless of that desktop preference, and the menu no longer offers "Show/Hide inbox" / "Show/Hide managed agents". → test in Task 2.
4. **The question card moves out from under the focus** — answering the last waiting question inside the inbox view leaves focus inside the view (the existing `useFocusRescue` fallback), not on `body`. → test in Task 3.
5. **Draft survives** — type in the composer, open inbox, Back, the text is still there (and after a rotation to wide and back). → test in Task 3 and e2e in Task 4.

---

### Task 1: The phone-view store

**Files:**
- Create: `apps/web/src/panel/phone-view.ts`
- Test: `apps/web/src/panel/phone-view.test.ts`

**Interfaces:**
- Produces:
  - `export type PhoneView = 'chat' | 'inbox' | 'agents'`
  - `export interface PhoneViewControl { view: PhoneView; open(view: Exclude<PhoneView, 'chat'>): void; close(): void }`
  - `export function usePhoneView(active: boolean): PhoneViewControl` — `active` is Panel's `sheeted`; when it turns false the view resets to `'chat'`.
  - `export function openPhoneView(view: 'inbox' | 'agents'): boolean` — for non-React callers; returns `false` (does nothing) when no phone panel is mounted/active.
  - `export function phoneViewActive(): boolean`
  - `export const PHONE_VIEW_ID = 'pnl-phone-view'`

- [ ] **Step 1: Write the failing tests** (`phone-view.test.ts`, render a probe component with `usePhoneView`):
  - `starts on chat and opens the inbox`: `view === 'chat'`; after `open('inbox')` → `'inbox'`; `history.state` has `phoneView: true`.
  - `Back closes the view`: open, then `history.back()` + dispatch `popstate` → `'chat'`, and the selection-related history entry is untouched (`history.length` back to before).
  - `close() takes its entry back once`: open → close → close again calls `history.back` exactly once (spy).
  - `switching inbox → agents keeps one entry`: open('inbox'), open('agents') → one pushed entry.
  - `inactive resets`: rerender with `active=false` → `'chat'` and the entry is taken back; `openPhoneView('inbox')` returns `false`.
  - `openPhoneView works from outside React` while a probe is mounted active → probe shows `'inbox'`, returns `true`.
  - `a leftover entry after reload is cleared`: start with `history.replaceState({phoneView: true}, '')` → mount → `history.state` is `null` and view is `'chat'`.

- [ ] **Step 2: Run** `pnpm --filter web test -- phone-view` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement `phone-view.ts`.** Module store (`listeners`, `current`, `activeCount`) read with `useSyncExternalStore`, mirroring `inbox-visibility.ts`; the history handling copies `nav-sheet.tsx`'s pattern (`enterSheetEntry` / `leaveSheetEntry` / `backPending` / `popstate` listener) with the state key `phoneView`. No localStorage.

- [ ] **Step 4: Run** the same command — Expected: PASS.

- [ ] **Step 5: Commit** `P8-18: phone view store with its own history entry`.

---

### Task 2: Top-bar buttons on phones

**Files:**
- Modify: `apps/web/src/panel/TopBar.tsx` (`TopBarProps`, `CompactTopBar`, `useOpenInbox`)
- Modify: `apps/web/src/panel/panel.css` (compact bar section near `:1131`)
- Test: `apps/web/src/panel/TopBar.test.tsx` (extend)

**Interfaces:**
- Consumes: `PhoneViewControl` (Task 1), `waitingForUserCount` (`inbox-model.ts`).
- Produces: `TopBarProps.phoneView?: PhoneViewControl` — present only on a phone panel; class names `pnl-phone-inbox` and `pnl-phone-agents` (used by Task 3/4 tests and `focusAfterRemoval` selectors).

- [ ] **Step 1: Write the failing tests** (compact `matchMedia`, `phoneView` passed):
  - `shows an Inbox button with a dot while something waits`: world with one open user-held question → button named `/inbox, 1 waiting/i` with an element `.pnl-phone-dot`; with none waiting → button `Inbox`, no dot.
  - `a supervisor-held question lights no dot`.
  - `the Inbox button opens the inbox view` → `phoneView.open` called with `'inbox'`; pressed state `aria-pressed="true"` when `view === 'inbox'`, and pressing again calls `close()`.
  - `the managed-agents button opens the agents view` (`aria-label="Managed agents"`, not "Agents" — that name belongs to the nav sheet button).
  - `no "N waiting for you" text button and no Show/Hide inbox or managed-agents in the menu when phoneView is given`; without `phoneView` (compact but not panel route) the old bar is unchanged.
  - axe clean.

- [ ] **Step 2: Run** `pnpm --filter web test -- TopBar` — Expected: FAIL.

- [ ] **Step 3: Implement.** In `CompactTopBar`, when `phoneView` is given: render the two buttons after `PhoneIndicator` (managed agents, then inbox), drop the waiting button and the two toggles from the menu. `useOpenInbox` (also used by the wide bar) calls `openPhoneView('inbox')` first and falls back to `revealInbox()`. Buttons ≥44px tap target, matching `.pnl-menu-button`.

- [ ] **Step 4: Run** the same command — Expected: PASS.

- [ ] **Step 5: Commit** `P8-18: inbox and managed-agents buttons in the phone top bar`.

---

### Task 3: The panel shows one screen at a time

**Files:**
- Create: `apps/web/src/panel/PhoneFullView.tsx`
- Modify: `apps/web/src/panel/Panel.tsx` (layout flags, stack contents, `SideColumn` split, overlay)
- Modify: `apps/web/src/panel/inbox-reveal.ts` (`revealInbox`, `revealQuestion`)
- Modify: `apps/web/src/panel/notifications/focus.ts` (`focusTarget`)
- Modify: `apps/web/src/panel/panel.css`
- Test: `apps/web/src/panel/phone-single-screen.test.tsx` (new), adjust `docked-chat.test.tsx` / `inbox-closed.test.tsx` / `panel-tweaks.test.tsx` cases that assert the old phone stack.

**Interfaces:**
- Consumes: Task 1 (`usePhoneView`, `openPhoneView`, `phoneViewActive`, `PHONE_VIEW_ID`), Task 2 (`TopBarProps.phoneView`).
- Produces: `PhoneFullView({ view, onClose, children }: { view: 'inbox' | 'agents'; onClose: () => void; children: ReactNode })` — a `role="region"` labelled "Inbox" / "Managed agents" with a header (`h2`, ✕ button `aria-label="Close the inbox"` / `"Close managed agents"`), Escape closes, focus moves to the `h2` on open and back to the top-bar button on close. `SideColumn` is split so its two sections render on their own: `ManagedAgentsSection` and `InboxSection` (same markup, same `INBOX_ID`, same `useFocusRescue`).

Layout rules in `Panel` (with `phone = sheeted`):
- `phone && !showScene`: the stack holds only `SceneOffer`; the dock is not collapsible (no handle, no minimise) and fills (`pnl-grid-dock-fills` no longer needs `!side`).
- `phone && showScene`: stack holds the scene only; dock as today (collapsible).
- `phone`: `SideColumn` is never in the stack; when `view !== 'chat'`, `PhoneFullView` renders over `.pnl-body` with `InboxSection` (ignores `inbox.visible`) or `ManagedAgentsSection` (ignores `agents.visible`), and the grid gets `inert` + `aria-hidden`.
- Opening the nav sheet closes the view, and opening a view closes the sheet.

- [ ] **Step 1: Write the failing tests** (`phone-single-screen.test.tsx`, compact + stacked `matchMedia`, panel route, fake world with a Harmonizer, a Waykeeper, one waiting clarification):
  - `phone list mode: the chat fills, no inbox or agent cards on screen` — no `#pnl-inbox`, no `.agc`; no dock handle; no minimise button.
  - `the Inbox button shows the inbox full screen and ✕ returns` — region "Inbox" visible, grid `inert`; ✕ → region gone, focus on `.pnl-phone-inbox`.
  - `the draft survives`: type "Also make sure the tests" in the composer, open inbox, Back (`popstate`), composer value unchanged; also after switching `matchMedia` to wide and back.
  - `answering in the inbox view keeps focus in the view` (answer the only clarification → focus inside the region).
  - `the managed-agents view lists the cards` (`.agc` present inside region "Managed agents").
  - `scene shown on a phone: today's dock` — scene present, dock handle and minimise present, no inbox in the stack.
  - `nav sheet and view exclude each other` — open inbox view, open sheet → view closed; one history entry pushed overall.
  - `revealQuestion on a phone opens the inbox view and focuses the card`.
  - `a notification click for a question on a phone opens the inbox view` (`focusTarget({kind:'question', id})`).
  - `tablet (stacked, not compact) is unchanged` — side column still in the stack.
  - axe clean with the view open and closed.

- [ ] **Step 2: Run** `pnpm --filter web test -- phone-single-screen` — Expected: FAIL.

- [ ] **Step 3: Implement** the layout rules above, `PhoneFullView`, the `SideColumn` split, and: `revealInbox` / `revealQuestion` call `openPhoneView('inbox')` before looking for `INBOX_ID`; `focusTarget` on a phone (`phoneViewActive()`) treats a `question` or `proposal` target as `inbox: true` and opens the inbox view instead of `scrollInboxIntoView`.

- [ ] **Step 4: Run** `pnpm --filter web test` — Expected: PASS (update older phone-stack assertions to the new layout; do not delete their intent: tablet assertions stay).

- [ ] **Step 5: Commit** `P8-18: one screen at a time on phones`.

---

### Task 4: End-to-end, docs and the board

**Files:**
- Create: `e2e/tests/11-phone-single-screen.spec.ts`
- Modify: `docs/SPEC.md` (§4.2 phone paragraph; §7 decision 140), `docs/TECHNOLOGY.md` (web layout paragraph next to decisions 71/117), `docs/IMPLEMENTATION_PLAN.md` (Phase 8 list), `docs/tasks/PHASE_8_HARDENING.md`, `docs/tasks/README.md`

- [ ] **Step 1: Write the e2e** at a 390×844 viewport with the fake adapter (follow `e2e/tests/10-chat-replies.spec.ts` setup): chat fills; a clarification appears → Inbox button has the dot; open inbox, answer it, dot goes; type a draft, open inbox, `page.goBack()` → draft still there and still on the panel URL; open managed agents and close with ✕; at 1280×800 the inbox is in the side column.
- [ ] **Step 2: Run** `pnpm --filter e2e test -- 11-phone` — Expected: PASS.
- [ ] **Step 3: Docs.** Decision 140 "**One screen at a time on phones**" (2026-10-18, Cosmin's request, P8-18; decisions 67, 71, 75, 94, 117): Cosmin's words ("I want to have only one main screen, either the chat box with the selected agent … or the inbox"), the rules from Global Constraints, and the calls marked as Claude's (dot = waiting only, Back closes, not remembered, notification → inbox). Amend the text of 67/71/75 by reference, not rewrite.
- [ ] **Step 4: Gates** — `pnpm build && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` all green.
- [ ] **Step 5: Commit** `P8-18: done — one screen at a time on phones` (status `done (<date>)`, Done line listing files and tests, README row).
