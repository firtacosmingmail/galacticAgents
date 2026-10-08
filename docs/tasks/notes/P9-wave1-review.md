# Phase 9 wave 1 review (P9-01, P9-02, P9-03)

Review of `phase-9...p9-wave1-model-paths-opener`, 2026-10-07, security first. One blocker,
reproduced. Fixes on `p9-wave1-review-fixes`, merged into the batch branch; gates green afterwards
(protocol 116, desktop 28, server 1522 + 6 skipped, web 1729).

## Blocker (fixed)

- **B1 — a parent folder swapped between `realpath` and `stat` let an outside file be read.**
  `checkPath` now uses `lstat` on the resolved path and re-resolves it; files are opened with
  macOS `O_NOFOLLOW_ANY` (refuses a link in any component); race tests for the stat and open steps.

## Should-fix (all fixed)

1. **IDE hijack** — Spotlight hits from a project could pose as an IDE, and `open -b` let
   LaunchServices choose any copy. IDEs count only from `/Applications` / `~/Applications`, must
   pass `codesign` with the vendor's Team ID (JetBrains `2ZEFAR8TH3`, Microsoft `UBF8T346G9`), and
   launch with `open -a <path>`.
2. **App fingerprint** now covers the whole bundle (lstat walk incl. ctime) and files' ctime.
3. **Code that runs on open** — extension-less executables and launcher/installer types
   (`.webloc`, `.dmg`, `.mobileconfig`, …) need the confirmation; the opener refuses them itself.
4. **Hard links** refused for agent declarations (`hard_link`).
5. **Secret names** extended (App Store keys, `.envrc`, keystores, `.pgpass`, `.htpasswd`,
   Terraform state, KeePass, VPN profiles, Azure/gcloud config).
6. **Agents** cannot restore a row the user removed and reach only their own task's / project's
   rows (domain second line under the tools).

## Nits (fixed)

One remote refusal code (`remote_control`), mapped to 403 from the domain; agents cannot start
runs; a clear import error for runs without their deliverable; guarded queries; async, capped
`treeSize`; top-level plist keys only; the stray ctime limit documented.

## Left open

- Cursor and Zed Team IDs to record when installed.
