# Phase 2.5, batch 2 (wave 2: P25-03, P25-04, P25-05, P25-06) — review

Branch `p25-wave2-panel-ui` against `phase-2.5`, 2026-10-03. Four parallel agents in worktrees; each merge conflicted only on `Panel.tsx`'s imports (resolved as unions; the old P2-18 console imports dropped). At the merge the chat's inline cards were pointed at P25-06's shared `ProposalView` / `QuestionView`, so a card in a thread and in the inbox is one component and the thread's own folding went. An independent review confirmed the `turn` flag is backward compatible, nothing redeclares a protocol type, the replay-vs-snapshot conformance still holds and the Steward view allows nothing beyond decision 13 / 48. A fix agent closed its findings, each with a test:

| # | Finding | Fix |
|---|---|---|
| 1 | Proposed decisions not in SPEC/TECHNOLOGY, and code already cited them (a comment said decision 52 when 52 says the opposite) | SPEC 54–58, TECHNOLOGY §6.3 "The chat" and "Shared cards", §7 vocabulary; SPEC §2.4 / §4.2 now follow decision 48; notes corrected (the Steward view does not render the shared clarification component; a 5th inbox group) |
| 2 | A snapshot catch-up did nothing for a thread with no history (live entries carry no cursor): a report sent during a disconnect was lost until remount | the thread rereads its newest page; past the 20-page cap it restarts from the newest page instead of leaving a hole |
| 3 | After a log change the chat stayed on "Loading…" | `logId` in the open effect's deps |
| 4 | A Steward's question was routed by `supervisorId`, so a replaced Waykeeper's thread showed it | routed by role and project (as plan cards and decision 32) |
| 5 | Work with no agent yet (queued task, unspawned project) had no card, so no cancel / edit (§4.3) | work-only cards with the work's controls |
| 6 | Duplicated `staleLine`, cost and wall-clock formatters between the Steward view and the cards (different formats) | the shared ones |
| 7 | "Waiting for you" meant two numbers (top bar: questions; inbox: questions + cards) | one `waitingForUserCount` |
| nits | stale Panel doc comment, dead `managedAgents`, the live transcript cap trimming paged-back Steward history | all fixed |

Deferred: moving `console/hierarchy`'s shared pieces (`Controls`, `EditForm`, `shared`) under `panel/` (the dependency points back into the console); old unmarked turn prompts still show (a one-off migration could mark them); markdown in replies, a thread size cap, tools/thinking in the brain chat, earlier Harmonizer sessions, search (P25-03 notes).

Gates on the merged branch: build, typecheck, lint, format:check green; protocol 61, server 828 (+1 skipped), web 144.

Decisions recorded: SPEC 54 (turn prompts are not conversation), 55 (where a card shows in the chat), 56 (managed-agents cards), 57 (the Steward view), 58 (inbox order and the waiting count).
