# Phase 8 wave 5 review (P8-13, P8-14, P8-15)

Review of `phase-8...p8-wave5-composer-mobile`, 2026-10-07 — Cosmin's interface requests: `/`
command list, ↑ message history, the phone navigation sheet. No blockers. Fixes landed on
`p8-wave5-review-fixes` and were merged into the batch branch; gates green afterwards (protocol
106, desktop 28, server 1356 + 4 skipped, web 1723), `pnpm e2e` 11/11.

## Should-fix (all fixed)

1. **Brains ran any slash command their session offered** — `/clear` from the phone would reset
   the Harmonizer behind its runner; `/init`, `/review` would make a brain do Steward work. Brains
   now offer and run only `/compact`, `/context`, `/cost`, `/usage`; Stewards keep their full list
   (SPEC 115).
2. **Android's back gesture** (Cosmin's Samsung S24) takes edge swipes before the page. Opening the
   sheet pushes a history entry, so Back closes it without changing the selection or leaving the
   installed app; the Agents button is the way in that always works (SPEC 117).
3. **Command detection after a restart** depended on a page having read the list; the runtime now
   reads it when a brain's session opens.
4. **Output of `/context` and `/cost`** was dropped; local-command output now reaches the
   transcript (exact shape to confirm with a real Claude run).
5. **IME Enter in the desktop app's WebKit** sent or inserted while composing; ignored now.

## Nits (fixed)

Clarification history excludes allow/deny answers; aliases kept (`/cost` = `/usage`); Enter on a
full command name sends it; a selection in the sheet focuses the page title (decision 81); late
banners become inert while the sheet is open; hidden tab stops skipped; swipes on horizontally
scrollable content left to it; recall anchored to message ids; the reduced-motion transition rule
scoped to reduced motion.

## Left open

- A real Claude run: what `supportedCommands()` returns and how a command turn's output arrives.
- On Cosmin's S24 (Chrome tab and installed app): the sheet, Back closing it, the edge swipe.
