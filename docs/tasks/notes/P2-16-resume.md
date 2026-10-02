# P2-16 — Hierarchy restart and resume

Branch from `p2-wave6-resume-console` (worktree `agent-a7f5b49f9c7fc01f6`). No migration, no new event type: the protocol, its fixtures and the web reducer are untouched.

## What was built

| Where | What |
| --- | --- |
| `runtime/agent-runtime.ts` | `reopen(agentId, {tools, systemPrompt, prompt, freshPrompt, mailbox})`: resumes from `sessionRef`; if the runtime cannot resume (no ref, no `resumeSession`, a failed resume) and `freshPrompt` is given, it opens a fresh session on the **same agent row** (`agent.interrupted{resume failed}` then `agent.spawned`). With `mailbox`, the agent is a brain from the moment its `Live` exists, and its undelivered messages are not redelivered raw. `setBrainResumer(fn)`: startup `recover()` and `recoverAgent()` (the panel's `POST /api/agents/:id/recover`) hand a Harmonizer or Waykeeper to it. Recovery and shutdown interrupt the **deepest agents first** and resume the **shallowest first** (supervisors before their Stewards). A resumed session's first message is `RESUME_PROMPT` (a short notice), not the original spawn prompt. `TurnEnd.resumed` marks the first turn of a resumed session. |
| `brains/runner.ts` | `BrainRunner.resume(definition, placement, agentId, opts)`: subscribes, rebuilds the mailbox from the log at the same seq (`requeue`), adds the definition's start notes, and calls `runtime.reopen` with the definition's tools and prompt. There are two first prompts: "your session as the X was resumed" and "a new session starts here, seeded from the database". `note(line)` adds a line to the next turn that is not tied to an event. `BrainDefinition.startNotes(ctx)` gives lines for the first turn of a start or a resume. **Fix (asked by the coordinator, from P2-18):** tool calls in a brain's first turn wait until the brain's agent id is known. Before this, a Waykeeper started from the Harmonizer's `spawn_waykeeper` failed with "the brain has not been spawned yet". |
| `brains/requeue.ts` | The mailbox at the crash, rebuilt from the log (algorithm below). |
| `runtime/compose.ts` | `defineBrains({harmonizer, waykeeper}, opts)` registers the resumer. `runnerOf(id)`. `announceRecovery(report)` puts the recovery line into the running Harmonizer's next turn (`recoveryNote`). Every runner it starts or resumes calls `reports.resend(id)`. The Steward reports get a history: the log, statuses, and the last transcript text. |
| `runtime/steward-reports.ts` | `owesReport(log, stewardId)` (a small state machine over the log). `resend(supervisorId)`. A resumed Steward's first turn reports only if a report is owed. |
| `domain/question-service.ts`, `questions.ts` | An interruption keeps the questions a brain opened through a tool (`meta.source: command`). Only an end for good cancels them. |
| `brains/harmonizer/closure-tools.ts`, `index.ts`, `prompt.ts` | `closureNotes` is the Harmonizer's `startNotes`. `startHarmonizer` returns the runner of the Harmonizer already running. The prompt gains an "After a restart" section. |
| `brains/promotion.ts` | A waiting card's clock counts from its approval in the log. `start()` pauses the Stewards of a card made before the flow subscribed, except those someone else paused or resumed after the card was made. |
| `adapters/fake/fake-adapter.ts` | A resumed **brain** whose first turn is done takes the resume prompt as a new turn, as the SDK does. A scenario the adapter instance never saw (a scripted brain from an earlier life) is asked of `scenarioFor` again. Stewards behave as before. |
| `brains/testing/harness.ts` | `crash()` simulates a kill -9: the mailboxes are lost, the adapter stream is cut, reports and timers stop. `recover()` resumes and wraps every resumed brain in a `HarnessBrain`. |
| `index.ts` | It builds the Harmonizer deps and `defineBrains` **before** `recover()`, then calls `startHarmonizer` and then `announceRecovery(recovery)`. |

### Tests (+13 server tests, 750 → 763)

- `brains/resume.test.ts`: the **kill -9 drill**. The setup is a Harmonizer, a Waykeeper on a git project, a Steward asking a clarification, an idle Steward that has reported, two `ask_user` questions and a pending card. The crash comes right after a user line to the Waykeeper and an answer to the Harmonizer. After recovery, all 4 agents are resumed, the brains through their runners, the Harmonizer and the Waykeeper before the Stewards. Every agent is `idle`, `working` or `waiting_for_input`. Each brain's first turn folds exactly what it missed. The late message is delivered once. The re-asked question is held by the resumed Waykeeper. The open `ask_user` question survived. No duplicate agent, no second Harmonizer, the card is still pending, and the report was not sent twice. A scripted tool call works on both brains. The Harmonizer says "recovered: 4 resumed, 0 need attention" and the line is in its transcript. Four more tests: the re-seeded fresh session on the same row; a Steward cut short mid-work reports when its resumed turn ends; closure requests reach the next Harmonizer, and the stale question is withdrawn; the panel's resume action brings a brain back as a brain.
- `brains/requeue.test.ts` (3), `runtime/steward-reports.test.ts` (+1 resend), `brains/promotion.test.ts` (+3: a card made before the flow; the user's resume is respected; the clock counts from approval; two of them fail on the old code), `brains/runner.test.ts` (+1: first-turn tool call of a brain started inside another brain's tool; it failed before the fix).
- Changed expectations: `question-service.test.ts`. A shutdown now interrupts the Steward before its Waykeeper, so its question is cancelled and never reassigned to the user. `harmonizer.test.ts`: the "running" result now carries the runner.

## The requeue algorithm (for TECHNOLOGY §5.2)

The cut is where the brain's knowledge ends. It is the latest of three points:

- the brain's last turn message (`message.sent` from the system) that has a `message.delivered`;
- an `agent.interrupted` that was followed by `agent.spawned`, meaning a session reset or an earlier resume;
- the brain's `agent.created`.

After the cut, the turn that began there ran the brain's tools. Up to the brain's next `agent.idle` or end, that turn keeps only events with an actor (`by`, `answeredBy`, `sender`, `from`, a question's asker) other than the brain. After that turn, every event the wake table lets through is kept, except those the brain itself is the actor of. The runner's own turn messages and the messages already delivered are skipped. The subscription and the cut are taken at the same seq.

## Decisions (proposed text, ready to paste)

**SPEC §7, decision N — Brains resume as brains** (refines 8 and 32): after a restart (or the panel's "Resume session"), the Harmonizer and every Waykeeper come back on their own agent row through their runner, with their tools, system prompt and mailbox. They are resumed from the saved session where the runtime can. Otherwise they get a fresh session seeded from the database ("your previous session could not be resumed"). They are never resumed as bare sessions. Supervisors are resumed before their Stewards, so a re-asked question finds its holder running. Shutdown and recovery interrupt Stewards first, so their questions are cancelled before their supervisors' held questions would move up. A brain's first turn after the resume folds in what it had not consumed: the events after the last turn it received, minus its own effects, plus the messages it never got. Every resumed session (a Steward's too) receives a short "the server restarted, continue" notice instead of its original task prompt.

**SPEC §7, decision N — Tool-asked questions survive a restart** (refines 21): a question a brain opened through a tool (`ask_user`, `ask_closure`, `ask_confirmation`, a Waykeeper's own question) does not belong to its session. A restart or a session reset keeps it open, and the resumed brain hears the answer in its mailbox. It is cancelled only when the brain ends for good (stopped, finished, failed). Questions an agent asked from inside its session are still cancelled with the interruption and asked again (decision 21).

**SPEC §7, decision N — The recovery report** (decision 8, SPEC §5): after recovery and the Harmonizer's start, the server adds one line to the running Harmonizer's next turn: "the server restarted — recovered: N agents resumed, M need attention", naming each one that needs attention with its state and reason. The Harmonizer tells the user in its chat ("recovered: N resumed, M need attention"). Interrupted agents keep the panel's resume action. The server's console prints the same counts.

**SPEC §7, decision N — Work carried over a restart** (P2-11, P2-12, P2-13 leftovers):

- A Steward's report its supervisor could not receive (no running supervisor when the turn ended) is sent again, marked "sent again", when the supervisor comes back.
- A resumed idle Steward does not report a turn twice. One whose work the restart cut short reports when its resumed turn ends.
- A closure request recorded while no Harmonizer could relay it is a line in the next Harmonizer's first turn. A stale "Anything else?" question from an ended Harmonizer is withdrawn so the new Harmonizer asks again.
- A promotion card's waiting time counts from its approval, across restarts.
- At start, the Stewards of every card still waiting for the user are paused, including a card made before the flow ran. A Steward that someone else paused or resumed after the card was made is left as they set it.

**TECHNOLOGY §4 (recovery), append:**

> *Hierarchy resume (P2-16).* The composition registers the brain definitions (`defineBrains`) before `recover()`. `AgentRuntime.recover()` interrupts the live agents deepest first, then reopens the interrupted ones shallowest first. An agent whose role has a definition goes through the brain resumer (`BrainRunner.resume`); any other agent goes through `reopen`. `reopen` tries `resumeSession(sessionRef)` with `RESUME_PROMPT`, or the brain's resume prompt. With `freshPrompt`, a refused or failed resume falls back to `adapter.spawn` on the same row. A brain's `Live` has its mailbox from creation. `POST /api/agents/:id/recover` takes the same path. One Harmonizer at a time holds on both paths.

**TECHNOLOGY §5.2 (brain runner), append:** the requeue paragraph above, plus:

> `BrainDefinition.startNotes(ctx)` gives lines for the first turn of a session that starts or resumes (the Harmonizer: unrelayed closure requests). `BrainRunner.note(line)` adds a line that is not an event (the recovery report). A tool call in a brain's first turn waits for the brain's agent id: the adapter may start that turn before `spawnAgent` returns.

**TECHNOLOGY §5.3 (questions), one sentence:** `endAgentQuestions(…, 'interrupted')` keeps a brain's command-sourced questions (`meta.source: command`) open. Every other end cancels them.

## Shared files touched (small, additive)

- `apps/server/src/index.ts`: the brain definitions and the Harmonizer deps move before `recover()`; `announceRecovery` runs after `startHarmonizer`; the console says "Harmonizer resumed".
- `apps/server/src/runtime/compose.ts`: `defineBrains`, `runnerOf`, `announceRecovery`, `recoveryNote`; `startBrain` keeps the runner and re-sends missed reports; the report history.
- `lib.ts`: not touched. Nothing in `apps/web` or `apps/server/src/http`.

## Deferred / known limits

- If the old Harmonizer cannot be resumed and a new one replaces it, the old one's open `ask_user` / `ask_confirmation` questions stay open, and the new Harmonizer does not hear their answers. Closure questions are the exception: they are withdrawn and asked again.
- Requeue limits:
  - An event without an actor, committed by someone else during the brain's own last turn, is dropped. The seed shows its effect.
  - After a second crash, events committed between an earlier resume's cut and its reopen (recovery noise) can be folded twice.
- The recovery note is a turn of its own, after the Harmonizer's resume turn. It is not folded into that turn.
- A paused Steward's turn end (an interrupted turn) counts as an owed report for `owesReport`. A pause the user made does not survive a restart (unchanged). Only promotion cards pause again.
- The fake adapter tracks only first-turn steps for resume. Message turns of a fake session are not resumed mid-turn.
- `RESUME_PROMPT` now reaches real SDK Stewards on resume, in place of their original task prompt. P2-19's real run should confirm that a resumed Steward continues sensibly.
- Not done: resuming a *finished* session (P2-10's sent-back Steward is still a new agent).
