# Phase 2.5, batch 4 (wave 4: P25-10 history view; P25-09 dogfood pending) — review

Branch `p25-wave4-dogfood` against `phase-2.5`, 2026-10-03. P25-10 was added while preparing the dogfood run: SPEC §4.2's history view was missing. One agent built it; the decision (SPEC 61) was written before the review. An independent review found no blocker: SQL parameters bound and `LIKE` escaped, paging across projects and tasks without gaps or duplicates at a shared instant, partial indexes matched verbatim with `INDEXED BY`, bearer guard, redaction parity, actions matching the state table and decision 56's confirmations. A fix agent closed its findings:

| # | Finding | Fix |
|---|---|---|
| 1 | A cancelled question's reason scanned every `question.cancelled` event | 0008 adds `events_type_question`; plan test asserts the search |
| 2 | New history never appeared until Refresh, which blanked the list | "New items — refresh" hint from the stream; refresh keeps rows until the new page arrives; the remaining limit documented |
| 3–4 | "Withdrawn" also covered questions ended with their agent; a dead "open again" branch | "withdrawn or ended" (SPEC 61 updated); removed |
| 5–9 | redeclared query types, `LIMIT` in SQL text, `aria-label` on rows, any `RangeError` → 400, notes gaps | protocol `z.output` types, `LIMIT ?`, `aria-labelledby`, `CursorError` (also for `/conversation`), notes |

Gates on the merged branch: build, typecheck, lint, format:check green; protocol 64, server 842 (+1 skipped), web 198.

P25-09 (the dogfood run) is open: it needs Cosmin running a real project through the panel (checklist in `P25-09-dogfood.md`).
