# P2-11 — Steward lifecycle

Built in a worktree branched from `p2-wave5-flows`, 2026-10-02, in parallel with P2-09, P2-12 and P2-13. No migration, no new event type: a report is an ordinary `message.sent` from the Steward to its supervisor.

## What was built

| File | What it does |
| --- | --- |
| `apps/server/src/brains/steward-prompt.ts` (new) | `stewardPrompt(brief)`: the one Steward template. Order: `lead` (a send-back), the supervisor's `instructions`, `---`, the task's facts (id, priority when not normal, description; project name and id or "a standalone task"; who it reports to; working directory; branch and worktree, serialised workspace, or "this folder may be someone's working copy" for an asteroid), the project's other tasks (open ones first, at most 8, archived and itself left out), then `stewardEtiquette()`. The first line stays the supervisor's, so fake Stewards still pick their `scenario:` from it. |
| `apps/server/src/runtime/steward-reports.ts` (new) | `stewardReports(runtime, tables)`: on each Steward turn end, it sends the turn's last text to the supervisor as a `message.sent`. The message comes from the Steward and reads `Task <id> ("<description>"): the Steward ended its turn. Its report: …`. It is cut at 4,000 characters. `reportText()` builds the text. The existing `message.sent` wake rule wakes the supervisor ("agent … reported: …"), and the runner marks the message `message.delivered`. |
| `apps/server/src/brains/steward-tools.ts` (new) | `tell_steward {agentId, text}` sends one of the caller's own running Stewards a queued message (never an interrupt) that starts its next turn. It is the supervisor's answer to a "Not done" or a waiting report. Both brains have it. |
| Tests (new) | `brains/stewards.test.ts` holds the 4 acceptance tests. `runtime/steward-reports.test.ts` (5 tests) covers the report rules; the interrupted and queued cases were mutation-checked. `brains/steward-prompt.test.ts` has 4 tests. |

### The report rules (`TurnEnd`, `AgentRuntime.onTurnEnded`)

The runtime keeps each live agent's current turn: its last non-empty `text` output, and whether the turn was cut short. Starting a new turn (inbox delivery) resets it. On every `agent.idle`, after the event is logged and before the next queued message is delivered, listeners get `{agent, text (redacted), interrupted, queued}`. Here `interrupted` means an interrupt (the runtime's or an interrupting message's), a pause, a stop or cap stop under way, or an ended agent. A report is sent only when all of these hold:

- the agent is a Steward;
- the turn was not interrupted;
- no message is queued for it, because its next turn starts at once and that turn's end reports;
- its current supervisor (read from the table, so a hand-over from P2-12 is respected) has a brain mailbox.

So supervisors are not woken on every idle tick: one wake per completed Steward turn.

**Finished without a report:** when a Steward's `agent.finished` has no `result`, the runtime fills it with the turn's last text. The existing `agent.finished` wake rule then shows it to the supervisor (`finished: "…"`). Finishing is its own report, so no turn-end message is added on top.

### Verified end to end (spawn in its worktree with the project's policy and caps)

`stewards.test.ts`, project case:

- A temp git repository with a project policy that denies `network`.
- A real Waykeeper `spawn_steward`.
- The Steward's agent row has `cwd` = its worktree, `meta.workspace` = the project's, `meta.permissionPolicy` = the project's table, and the default caps.
- Its `WebFetch` is denied by the gate with no question asked.
- It commits and ends its turn with `Done: …`.
- The Waykeeper is woken once by the report, which carries the last line only. It runs `merge_task` (the file is on the base branch) and then `close_task` (the task is `completed` and the idle Steward is `stopped`).
- Asteroid cases (real Harmonizer, card-approved scratch folder):
  - a done report → `close_task`;
  - a `Not done:` report → `tell_steward` → a second report → close;
  - `finish` without a result → the last text is the `result` → close.

No gap was found in placement or policy, so no fix was needed there.

## Decisions (proposed text, ready to paste)

**SPEC §7, decision N — Steward reports (2026-10-02, P2-11).** A Steward reports by ending its turn. Its final message is its report to its supervisor, opening with "Done:" (what changed, how it was checked, what is left) or "Not done:" (what stops it). The server delivers that last message to the supervisor: the Waykeeper for a project task, the Harmonizer for an asteroid task. The supervisor decides: the task is done (merge, then close), or the Steward is in fact waiting for input, which the supervisor gives it, or escalates to the user and relays the answer. These do not count as reports: a turn cut short by an interrupt, a pause or a stop, and a turn followed at once by more queued work. A Steward that ends without any final text is reported as "ended its turn without a report". A Steward that finishes reports through its result, or its last words when it gives none. Stewards ask clarification questions through their runtime's question tool, never in prose. They never ask permission in prose: the permission gate decides each tool call.

**SPEC §2.3, last sentence, replace with:** "When it stops (its turn ends) it reports to its supervisor with a final message ('Done: …' or 'Not done: …'); the supervisor decides whether the task is closed, or gives the Steward what it is waiting for."

**TECHNOLOGY §5 (brains), new paragraph:**

> *Stewards (P2-11).*
> - **Prompt.** Every Steward's first prompt comes from one template, `brains/steward-prompt.ts`. It is used by the Waykeeper's `spawn_steward` and send-back respawn, and by the Harmonizer's asteroid `spawn_steward`. In order it holds: the supervisor's instructions, the task's facts and project context (worktree and branch, the project's other tasks), and the etiquette (ask through the question tool, never ask permission in prose, report on stopping).
> - **Reports.** `AgentRuntime.onTurnEnded` gives every `agent.idle` with the turn's last text output, whether the turn was cut short, and the queued-message count. `runtime/steward-reports.ts` turns a Steward's completed, unqueued turn into a `message.sent` from the Steward to its current supervisor, when that supervisor has a brain mailbox. The existing wake rule wakes only the supervisor. No new event type and no wake rule on `agent.idle` were added.
> - **Finished without a result.** A Steward's `agent.finished` without a `result` gets the last text as its result.
> - **`tell_steward {agentId, text}`.** The supervisor's queued reply to its own running Stewards. It never interrupts.

**IMPLEMENTATION_PLAN Phase 2:** no change.

## Shared files touched (small, additive)

- `runtime/agent-runtime.ts`:
  - `Live.turn`, filled from text output and reset on delivery and idle, with the interrupt marks;
  - `TurnEnd`, `onTurnEnded(listener)`, `hasMailbox(agentId)`;
  - the empty-`result` fill for Stewards.
- `runtime/compose.ts`: builds `reports` (`ComposedRuntime.reports`) and disposes it on shutdown and dispose.
- `brains/waykeeper/prompt.ts`:
  - `stewardPrompt(task, project, where, instructions, {related?, lead?})` is now a wrapper over the template;
  - the "Done means judged done" line now covers reports and `tell_steward`.
- `brains/waykeeper/tools.ts`:
  - `spawn_steward` passes the project's tasks as `related`;
  - the send-back respawn builds its prompt with `lead` (the send-back text), so its first line is still the note, followed by "The task, as its first Steward was given it: <instructions>".
- `brains/waykeeper/index.ts` and `brains/harmonizer/index.ts`: `...STEWARD_TOOLS` added to the tool lists.
- `brains/harmonizer/tools.ts`: `defaultStewardPrompt` now calls the template (with the Harmonizer as supervisor); `deps.stewardPrompt` stays as the override seam.
- `brains/harmonizer/prompt.ts`: the asteroid-report line now covers reports and `tell_steward`.
- `brains/index.ts`: exports the two new brain modules.
- `brains/waykeeper/waykeeper.test.ts`:
  - the serialised test now has a rule for the held Steward's empty report;
  - the send-back assertion follows the template's wording.

## Notes for the merge

- **P2-12 (hand-over).** A report goes to the Steward's supervisor *at the time of the report*, so `moveTask` re-parenting needs nothing more. A paused Steward's idle is not a report.
- **P2-13 (closure).** `close_task` and closure stop Stewards. A stop under way marks the turn interrupted, so a stopped Steward sends no report.
- **P2-17 (caps).** Nothing changes: a cap stop counts as an interrupted turn. Caps refusals in `spawn_steward` reach the model as before.
- **P2-09.** No interaction.

## Deferred / known limits

- **Report to a supervisor with no mailbox, or not running.** The report is not sent. The task's derived state (`awaiting_closure`) and the supervisor's seed ("idle" Steward) still show it. P2-16 (hierarchy resume) may want to re-raise reports for idle Stewards whose supervisor came back.
- **What counts as the report.** The last text output only: an earlier multi-message summary is not concatenated, and a report is cut at 4,000 characters (the whole text stays in the transcript). With the Claude SDK, the last text block equals the turn's `result`.
- **No "Done:" parsing.** The server does not read the prefix. The supervisor's model judges, which is what SPEC §2.7 asks for.
- **`tell_steward` reaches direct reports only.** A sub-project's Stewards are told by their own Waykeeper.

## Tests

`pnpm test`: protocol 50, server 669 passed + 1 skipped, web 31. `build`, `typecheck`, `lint` and `format:check` are green. The new Steward, Waykeeper and Harmonizer files passed 3 consecutive runs.
