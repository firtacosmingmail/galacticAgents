# P25-09 — Dogfood run

Run a real small project through the panel for a few days **without opening `/debug`**. Log every friction point below as it happens (date, what you tried, what happened, how bad). Blocking items get fixed in this task; product changes go to SPEC §7 / §8.

## How to run

```bash
pnpm dev        # server + web; the Harmonizer runs on real Claude (your subscription)
```

Open the panel URL the server prints (with its token). On this install the first-run wizard shows once (decision 60): check the settings or press Skip. Then turn on desktop notifications in the top bar.

## Checklist — SPEC §4.2–4.3 from the panel only

| # | Do this | Where | OK? |
|---|---|---|---|
| 1 | Ask the Harmonizer for the status of everything, of a project, of a task | Harmonizer chat | |
| 2 | Start a new project; approve its work card (try editing size / body / workspace / trust level first) | chat → inline card, or inbox | |
| 3 | Approve, edit or reject the Waykeeper's plan card | Waykeeper chat or inbox | |
| 4 | Ask for a standalone task (asteroid) and a task added to the project | Harmonizer chat | |
| 5 | Answer a permission question; answer a clarification from the inbox, from the supervisor's chat and from the Steward view | inbox / chat / Steward view | |
| 6 | Watch a Steward work: transcript, tool calls, thinking, cost, caps | Steward view | |
| 7 | Pause / resume / stop an agent; pause / stop / cancel a task and a project; edit a task's description or priority | managed-agent cards | |
| 8 | Confirm or decline a promotion | card | |
| 9 | Close the project after "Anything else?"; archive early, pin, reopen | chat / cards / history (P25-10) | |
| 10 | Find archived work and a past question with its answer | history view (P25-10) | |
| 11 | Desktop notifications: a question, a finished task, a restart with interrupted work | desktop | |
| 12 | Restart the server mid-task (Ctrl-C, `pnpm dev`): the Harmonizer reports what came back | Harmonizer chat | |
| 13 | Change a setting (a cap, the permission table); see "restart to apply" where it applies | `/settings` | |
| 14 | A full day of real work without opening `/debug` | — | |

## Friction log

| Date | What I tried | What happened | Severity (blocking / annoying / cosmetic) |
|---|---|---|---|
| 2026-10-03 | Look for a Waykeeper's question in the Harmonizer window | Not there (by decision 55) — only in the Waykeeper chat and the inbox | annoying → fixed |

## Fixes made

- 2026-10-03 — Waykeeper questions were not visible in the Harmonizer window (only in the project's thread and the inbox). Now a project's clarification that reached the user also shows as a card in the Harmonizer chat (same card; SPEC decision 55 amended). Permission questions stay out of it.
