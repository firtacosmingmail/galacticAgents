# Phase 9 wave 3 review (P9-08, P9-09)

Review of `phase-9...p9-wave3-runs-panel`, 2026-10-08, security first. One blocker. Fixes on
`p9-wave3-review-fixes`, merged into the batch branch; gates green afterwards (protocol 119, desktop
28, server 1733 + 6 skipped, web 1777), drills 40, e2e 12.

## Blocker (fixed)

- **B1 — an SVG shown from a `blob:` URL ran as the app** when opened in a new tab (panel origin →
  token → runs). SVGs are rasterised to PNG through a canvas (fallback: a `data:` URL, opaque
  origin); never a `blob:` SVG. The app pages now send a Content-Security-Policy (`script-src
  'self'`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`, …); e2e fails on any
  CSP violation.

## Should-fix (all fixed)

1. A deliverables folder or worktree replaced by a link is no longer a root (`trustedFolder`); runs'
   cwd and Reveal use the same check.
2. An edited command line is logged redacted (the real line runs); control characters and masked
   secrets refused.
3. The run preview classifies an edited line and returns a confirmation token bound to the
   deliverable, its version and the line (HMAC, 15 min); start/restart require it.
4. The marker sweep spares shared per-user daemons (ssh mux, agents, watchman, Gradle/Kotlin, nx,
   turbo, …); residual risk stated in SPEC 130.
5. Terminal agents: spinner redraws are no longer flushed per frame on quiet (the flaky test's real
   cause).
6. Restart checks it can start before stopping the run.

## Nits (fixed)

One process snapshot per tick and markers every 15 s, environments dropped after matching; output
paged (256 KB) and capped (64 MiB/run), 16 subscriptions per socket; safe links for URL rows;
missing `writable` means local-only; stdin wording; a run's folder is the project or its
deliverables folder only (SPEC 129); memoised highlighting.

## Left open

- The run dialog in the panel (P9-10) must use the preview's confirmation token.
- Browser behaviour of "open image in new tab" on the `data:` fallback is reasoned, not tested.
