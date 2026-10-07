# Phase 9 wave 2 review (P9-04, P9-05, P9-06, P9-07)

Review of `phase-9...p9-wave2-declare-detect-copy-serve`, 2026-10-08, security first. The four
tasks were integrated on `p9-wave2-integrate` first (one copy interface, one options shape, one
roots helper, Rescan wired, a staggered startup scan, copies for paths added by hand). One blocker,
reproduced. Fixes on `p9-wave2-review-fixes`, merged into the batch branch; gates green afterwards
(protocol 116, desktop 28, server 1684 + 6 skipped, web 1729), drills 38, e2e 11.

## Blocker (fixed)

- **B1 — copies followed a symlinked parent.** A folder declared in a worktree, whose parent was
  swapped for a link to `~` before the merge, had the real `~/Documents` copied into the project.
  Copies now re-run `checkPath` with the row's rules right before copying, copy files only through
  `openChecked` (`O_NOFOLLOW_ANY`), and walk folders entry by entry with the same rules (secret
  names, hard links, stray owner/time per entry); skipped entries are recorded.

## Should-fix (all fixed)

1. Secrets and hard links inside copied folders are skipped (per-entry rules) and listed.
2. Adding a path from outside the project is Mac-only, even with `autoApproveRemote` (SPEC 131).
3. Brains' stray window is the task's Stewards' earliest start; brains can't declare strays for a
   project.
4. Detected commands keep their (redacted) script body so a run's confirmation can show it and flag
   changes (P9-08/P9-10); Yarn scripts run as `yarn run <s>`.
5. Detected bodies and descriptions are redacted.

## Nits (fixed)

`info/exclude` appended under a lock with escaped patterns; `--literal-pathspecs`; folder renames
never replace; case-insensitive user-folder guard that respects a tracked `deliverables/`; no
format/bidi characters in detected names; 64 live tickets per client; orphan copies documented;
server tools allowed only from the in-process `galactic` server (by the SDK's reported source).

## Left open

- Off macOS, copies rely on `O_NOFOLLOW` + `(dev, ino)` only.
- Panel display of skipped entries and run bodies: P9-09 / P9-10.
