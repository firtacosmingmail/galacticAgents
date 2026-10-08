# Phase 9 wave 6 review (P9-14, P9-15)

Review of `phase-9...p9-wave6-dismiss-tray`, 2026-10-08 — Cosmin's requests: dismissing outdated
questions, and permission requests in the Mac menu bar. No blockers; no path turns a dismissal
into an allow (Claude SDK deny, ACP reject_once/decline/refused hold, PTY "no", fake skip; races
serialised; versions bumped on cancel). Fixes on `p9-wave6-review-fixes`, merged into the batch
branch; gates green afterwards (protocol 122, desktop 57, server 1773 + 6 skipped, web 1842),
e2e 17.

## Fixed

- An answer to a dismissed or withdrawn question is `stale` "was already withdrawn"; the menu bar
  says "no longer waiting" instead of "could not answer".
- Superseding carries on past an adapter error.
- The menu answers only a permission request the world shows open and waiting on the user.
- A dismissed ACP hold is refused by an explicit flag, not by its reason text.
- A terminal dismissal that leaves the prompt up keeps its agent waiting.
- Question ids escaped in the answer/dismiss routes; one hashchange focus at a time.

## Left open

- A question the Harmonizer relayed as its own is not withdrawn when the original is dismissed
  (the Harmonizer is told; it has no tool to withdraw its own question).
- The menu bar has not been checked on screen (P9-13).
