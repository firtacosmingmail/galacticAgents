# Phase 2.5, batch 3 (wave 3: P25-07, P25-08) — review

Branch `p25-wave3-notify-settings` against `phase-2.5`, 2026-10-03. Two parallel agents in worktrees; P25-07 merged first and P25-08 merged it in and mounted `NotificationSettings` on the settings page (one `Panel.tsx` top-bar conflict, both controls kept). The decisions were written into SPEC/TECHNOLOGY before the review (59, 60, §4.6, §8, §6.3). An independent review found no blocker: every §4.5 trigger is covered by `notificationOf`, dedup holds across reload / reconnect / a second tab, the permission prompt opens only on a click, the marker is local-only, decision 51's local-only writes and env locks hold, the policy editor matches §3.6 plus `unclassified` (49) and reset sends `null` (50). A fix agent closed its findings, each with a test that fails without its fix:

| # | Finding | Fix |
|---|---|---|
| 1 | A tab with stale preferences could claim an id and not show it, so nothing showed anywhere | decide on the current stored prefs (`storage` events, re-read at decision time), then claim |
| 2 | Storage that reads but cannot write: seq never advanced, repeats and 24 h replays on every reload | `storageBroken`: the ledger lives in memory from the first failed write |
| 3 | A refused "Skip setup" was invisible before the last step | error and "continue without saving" next to Skip on every step |
| 4 | A remote client got the wizard on every load though it may not finish it | `SettingsResponse.writable` (same rule as PATCH); a `limited` client gets the panel with a note (decision 60) |
| 5 | A stored fractional wall-clock cap (90 000 ms) blocked saving any other cap | decimal minutes, bounds from the protocol schema, only changed caps sent |
| nits | inbox scroll after navigating from `/settings`, live notifications kept until closed, best-effort wording, failed-backfill note, lenient `setupCompletedAt`, no panel flash while settings load, short tokens fully masked | all fixed |

Deferred: a folder browser for the projects root; a runtime-problem banner after setup (candidate for P25-09); a real QR code (Phase 7); re-running the wizard on demand; service-worker / phone push (Phase 7); hiding notifications while the tab is focused (SPEC §8).

Gates on the merged branch: build, typecheck, lint, format:check green; protocol 61, server 833 (+1 skipped), web 191.
