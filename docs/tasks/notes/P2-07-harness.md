# P2-07 — Scripted fake-LLM harness for brains

Built on the branch from `p2-wave3-permissions-harness`. There is no migration and no protocol change. Everything lives under `apps/server/src/brains/testing/` and is test-only, except one additive step kind in the fake adapter.

## What was built

| File | What it does |
| --- | --- |
| `adapters/fake/scenario.ts`, `fake-adapter.ts` | A new `FakeStep` kind, `{kind: 'script', run(io)}`. `io.toolCall(name, input)` goes through the gate exactly like a `tool_call` step and resolves to `{status: 'ran', output, text}` (the server tool's raw handler value) or `{status: 'denied', reason}`. `io.output(text)` emits text. If the turn is cancelled, the next `io` call rejects with `FakeTurnCancelled`. This is the seam that lets a step depend on earlier tool results. The existing `tool_call` and `permission` steps behave as before (the private `toolCall` now also returns the result). |
| `brains/testing/script.ts` | `BrainScript`: turn rules (`once`, `times`, `on`), matchers (string, RegExp, function, `firstTurn`, `turnIndex(i)`), `TurnContext` (`call`, `try`, `say`, `mentions`, `transcript`), `ToolRefused`. |
| `brains/testing/transcript.ts` | `BrainTranscript`, the model-side record of each brain. For every turn it holds the prompt, the rule that answered it, every call with its input and outcome (ok, value, error code, turn ended), what the brain said, script errors and cancellations. `render()` gives a readable dump. `toOutcome()` reads the runner's tool envelopes. |
| `brains/testing/harness.ts` | `brainHarness(opts)` → `BrainHarness`: a composed runtime over `:memory:` with a fake adapter. Each spawn that carries server tools (every brain) is driven by its script. Spawns without tools (Stewards) still run `scenario:<name>` prompts. It provides `startBrain`, `startHarmonizer`, `tell`, `settle`, `until`, `verify`, `done`, `report` and `dispose`. `HarnessBrain` wraps the runner and its transcript. |
| `brains/testing/canned.ts` | `tool(name, handler, opts?)`, `brainDefinition(role, tools, opts?)`, `harmonizerDefinition(tools?)`, `latch()`. |
| `brains/testing/harness.test.ts` | Tests of the harness itself: results chained within a turn and across turns, script selection by specificity, and the readable failure messages. |
| `brains/testing/example.test.ts` | **The worked example to copy.** One test has a Harmonizer that creates a task, asks the user, then uses the answer. The other has a Waykeeper under the Harmonizer whose question the Harmonizer holds and answers. |
| `brains/runner.test.ts` | P2-06's ten runner tests moved onto the harness. They are equivalent and stricter: each one ends with `h.done()`, so an unexpected wake now fails the test. The Waykeeper under test runs under a Harmonizer, so the tests keep passing after P2-20. |

`scripted-brain.ts` (P2-06's minimal version) is removed. Its only user was `runner.test.ts`.

## API

```ts
import { brainDefinition, brainHarness, tool, firstTurn } from './testing/index.js';

const createTask = tool('create_task', async (input, ctx) =>
  (await ctx.commands.createTask({ description: (input as { description: string }).description,
                                   projectId: ctx.projectId })).value);

const h = brainHarness();                       // afterEach: await h.dispose()
const hq = await h.startHarmonizer();           // lenient, script-less supervisor (or pass {definition, script})
const project = (await h.commands.createProject({ name: 'CSV', workspace: '/w/csv' })).value;
const wk = await h.startBrain(
  brainDefinition('waykeeper', [createTask, closeTask]),
  { runtime: 'fake', projectId: project.id, supervisorId: hq.agentId },
  { script: (s) => s
      .once('add the export', async (t) => {
        const task = await t.call<Task>('create_task', { description: 'write the export' });
        await t.call('close_task', { taskId: task.id });      // a later call uses an earlier result
      })
      .on(/finished/, (t) => t.say('noted')) },
);
wk.tell('add the export');
await h.done();                                  // settle() + verify()
wk.assertCalls(['create_task', 'close_task']);
expect(wk.calls('create_task')[0]).toMatchObject({ ok: true, input: { description: 'write the export' } });
```

- **Rules.** Each turn prompt is matched against the rules in registration order. The first rule that matches and still has uses left runs its body, and the turn ends when the body returns. `once` (exactly one turn) and `times(n, …)` are expectations: if one never matches, `verify()` reports it. `on` may match any number of turns, zero included. Matchers: a string means "the prompt contains it". A RegExp is tested against the prompt. A function receives `TurnInfo` (`agentId`, `role`, `projectId`, `index`, `n`, `session`, `first`, `prompt`). The ready-made ones are `firstTurn` and `turnIndex(i)`.
- **Strictness.** Scripts are strict by default: a turn that no rule answers is a problem. The exception is a session's first prompt (allowed unless `allowFirst: false`). Pass `{ strict: false }` per script (`scriptOptions`) or for the whole harness (`brainHarness({ script })`). A brain with no script at all is silent and lenient. A strict script with no rules is how you assert "this brain is never woken", for example by a permission question (P2-08 acceptance).
- **Calls.** `t.call(tool, input)` resolves to the tool's result. For a turn-ending tool, that is the value inside its envelope. A refusal (a `DomainError` code, `turn_ended`, a gate denial) rejects with `ToolRefused`, which the harness records as a script error so `verify` fails. To inspect refusals, use `t.try(tool, input)`, which resolves to the full `ToolOutcome`. Calling a tool the brain does not have is a readable script error, not a stuck permission prompt. Results from earlier turns are in `t.transcript.last(tool)` / `t.transcript.calls(tool)`.
- **Assertions inside a body.** A Vitest `expect` that fails inside a body is recorded as a script error of that turn and surfaces in `verify()` together with the transcript.
- **Which script drives which brain.** `h.script(selector)` takes a role or `{role?, projectId?, agentId?}` and returns the same script on every call. Per brain, the most specific script wins (agentId > projectId > role). `startBrain(..., { script })` binds a script to `{role, projectId}` of that brain. Without the `script` option the brain falls back to whatever `h.script()` registered. So a role-wide script also covers brains that tools spawn later.
- **Waiting.** `h.settle()` resolves when every brain started through the harness is idle with an empty mailbox for three consecutive `setImmediate` ticks (one brain's turn may wake another). `brain.waitForTurns(n)`, `h.until(check, {what})` and `brain.settled()` (the runner's own) cover the rest. All waits poll on `setImmediate` rather than timers. The 2 s `timeoutMs` exists only so a hung test fails with the transcripts.
- **Failures.** `HarnessFailure.problems` is the list of problems. `message` is the list followed by every brain's rendered transcript, for example:

  ```
  brain harness: 1 problem
    - waykeeper a-… (project p-…): unexpected turn 2, no rule matched; it said: "Since your last turn: / 1. the user said: \"are you awake?\" / "
  waykeeper a-… (project p-…): 2 turns
    turn 1 (session 1, first prompt) [unscripted]
      │ You are the waykeeper. A new session starts here.
      …
      → close_task {"taskId":"t-missing"}
        ✗ not_found: no task t-missing
  ```
  Runtime `onError` reports are problems too, unless `failOnErrors: false`.
- **Access.** `h.composed` (the full `ComposedRuntime`), plus `h.log`, `h.commands`, `h.runtime`, `h.statuses`, `h.queries`, `h.adapter` and `h.errors`. `brain.runner` gives the `BrainRunner` with its `turns`, `pending()` and `requestReset()`.

## Decisions

- **Turn bodies are async functions, not step lists.** Chaining results ("use the id `create_task` returned") needs code between two tool results, and the model's tool loop is code too. To keep the fake adapter generic, it only gained the `script` step. It knows nothing about brains or scripts.
- **A brain is "a spawn with server tools".** The runner always adds `carry_summary`, so every brain has at least one tool and a Steward never does. This replaces P2-06's "any role but steward" rule. A brain's session refs are now `fake:scripted-<n>:…`: one scenario name per session, so `resumeSession` (P2-16) finds the right scenario.
- **No runner change.** The harness reads `runner.state` and `pending()` to decide whether a brain is settled.

No TECHNOLOGY text is needed for the harness. If you want a line, it fits in TECHNOLOGY §5 (testing brains):

> **Brain tests (P2-07).** Brains are tested without Claude through `apps/server/src/brains/testing/`. A `BrainScript` stands in for the model: turn rules match the turn prompt, and their async bodies call the brain's real tools (through the runner, the gate and `DomainCommands`) and chain their results. A `BrainTranscript` records every prompt, call, result and refusal, and `verify()` fails on an expected turn that never came, a turn nobody expected, or a refused call. The fake adapter's `script` step is the only seam.

## Findings for P2-08 / P2-10

- **A brain is not woken when a question it asked itself is answered.** The `question.answered` rule wakes the brain only when it held the question or one of its supervised agents asked it. When a Harmonizer's `ask_user` question (held by the user) or a Waykeeper's own question (held by the Harmonizer) is answered, nothing reaches the asker: Stewards get their answers through the adapter, but brains are not blocked. `example.test.ts` adds the rule through `wakeRules` (`question.originAgentId === brainId`). P2-08/P2-10 should add it to `WAKE_RULES`. `question.cancelled` likely needs the same rule.
- A brain that asks through `openQuestion` gets its supervisor as the holder, so a Waykeeper's "ask" is in effect an escalation to the Harmonizer. Only the Harmonizer's questions reach the user directly.
- If P2-08 starts Waykeepers from inside a tool (`spawn_waykeeper`) through a starter wired in compose, `h.settle()` does not know about those runners. Their turns are still scripted and recorded, but `settle` does not wait for them. Use `h.until(...)`, or expose the runner so the harness can track it.

## Deferred

- No fake clock: retention and timer tests (P2-13) still pass `now` through compose themselves.
- No canned Harmonizer or Waykeeper tool sets. Those are P2-08/P2-10's real definitions, and their tests should run them.
- A script body cannot emit `finish`/`fail` for its brain. Stop the brain through `commands.stopAgent`, or use `adapter.crash(agentId)`.
