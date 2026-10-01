# P2-04: Permission routing

## What was built

- **One decision function.** `createPermissionGate` (`apps/server/src/runtime/permission-gate.ts`) is still the only code that turns a tool call and a policy into allow, ask or deny. It now returns a `RuntimeGate`, which has two entry points:
  - `check()` is what adapters call, unchanged. It reserves against the tool-call cap.
  - `decide()` gives the same decision without the cap reservation and without `onDeny`. It also returns the category (`action`) behind any verdict.
  - Before this task, `allow` and `deny` were already settled in the adapters' hooks and only `ask` turned into `agent.needs_input(kind: permission)`. The runtime now judges any permission request a second time with the same gate, so the hook and the question path cannot disagree.
- **Live project policy.** The gate takes `policy` as a value or as a function, and reads it on every check, parsing each distinct value once. `AgentRuntime.policyOf(agentId, req)` returns:
  - the table of the agent's project (`agents.projectId`, else `req.projectId`);
  - the global default when that project has no table;
  - the spawn request's policy only for an agent outside any project (the P1 panel's presets, recovery from `meta.permissionPolicy`).
  - The merge follows decision 22 unchanged (per-category override, unknown values ask, an invalid table asks for everything). A policy edit now applies to the next tool call of agents that are already running. Before, the table was copied when the agent spawned.
- **Routing** (`AgentRuntime.rulePermission`). An `agent.needs_input(kind: permission)` that carries a `toolCall` goes through `live.gate.decide(rawCall)`. The decision uses the raw input; the log keeps the redacted copy.
  - **allow**: no question row is opened and `agent.needs_input` is not logged. The runtime logs `permission.decided{agentId, questionId, toolCall, decision: 'allow', action, decidedBy: system}` and calls `adapter.answer(questionId, 'allow')`.
  - **deny**: the same, with `decision: 'deny'` and a `reason`. The adapter gets `deny: <reason>`.
  - **ask**: a request without a `toolCall` counts as ask. The question opens as before, held by the user (`holderFor`). If the adapter did not name the policy category, the runtime fills `permissionAction` from the gate.
- **Refusals in the hook are logged too.** The gate's `onDeny` callback reports every refusal it makes on its own: a policy deny or a failed check. A tool-call cap refusal is not reported, because the cap logs it as the agent's failure. The runtime logs these as `permission.decided{deny}` with no `questionId`. A refusal made before `agent.spawned` is held back and logged just after it.
- **New event `permission.decided`.** It has a protocol schema, a fixture, and an exhaustiveness case in `events.test.ts`. The web reducer has a no-op fold: the event creates no rows, so the conformance walk is unchanged. `WAKE_RULES` has no rule for it.
- **Remote-client seam.** Nothing in the server told a remote client from the local page before this task. It now has three pieces:
  - `isRemoteRequest(req)` in `http/security.ts`. A request counts as local only when it arrives over a loopback connection, its `Origin` (if present) is a loopback name, and it carries no `tailscale-user-login` header. Anything else counts as remote, so a doubtful request gets the stricter rules.
  - A config flag, `ServerConfig.autoApproveRemote`. It is set by `autoApproveRemote` in `config.json` or by `GALACTIC_AUTO_APPROVE_REMOTE=1|true|0`, and is off by default.
  - `noLooserThan(policy, floor = default)` in `domain/permissions.ts`, which takes the stricter of the two tables in each category. When a remote client calls `POST /api/agents` and the flag is off, the policy it chose is cut down this way. Today that is the only place a client chooses a policy.
- **Tests:**
  - `runtime/permission-routing.test.ts` (8 tests). An allowed action never creates a question, with an ungated adapter and with the gate in the hook. A denied action is refused, logged and creates no question, on both paths. An asked action gives a user-held permission question, and `wakeLine` returns nothing for the Waykeeper or the Harmonizer on any event in that question's life. `permission.decided` has no wake rule. A policy change does not re-evaluate an open question but applies to the next call. An agent outside any project keeps its spawn policy. The tool input is logged redacted.
  - `permission-gate.test.ts` (+3): live policy, `onDeny` but not for cap refusals, `decide()`.
  - `permissions.test.ts` (+1): `noLooserThan`.
  - `security.test.ts` (+1): `isRemoteRequest`.
  - `config.test.ts` (+1): the flag.
  - `agent-routes.test.ts` (+1): a remote spawn's policy is floored.

## Decisions (proposed text, ready to paste)

**SPEC §7, decision N: Permission routing.** A permission request is decided before any question exists, by the agent's project's current policy table (decision 22's merge over the global default). `allow` runs the call and `deny` refuses it at once. Both are answered by the system, logged, and leave no question. Only `ask` opens a question, and the user holds it from the start. No supervisor's mailbox ever sees it (decision 7). A change to a project's table applies to the next tool call of the agents already working there. A permission question that is already open is **not** re-evaluated: the user's card stays until the user answers it, so a looser table never silently approves a card the user may be reading. To approve it the user answers it, or a later identical call goes through under the new table. A remote client (Phase 7) cannot set up auto-approvals: unless the server is configured with `autoApproveRemote`, a policy it chooses is held to the global default in every category.

**TECHNOLOGY §3.1, append (permission gate).** The gate is the one place a permission is decided. Adapters call `check()` from their hooks. The runtime calls `decide()` (no cap reservation) on every `agent.needs_input(kind: permission)` that carries a `toolCall`, before a question is opened:
- `allow` or `deny`: the adapter is answered (`allow` / `deny: <reason>`), `permission.decided{agentId, questionId?, toolCall (redacted), decision, action?, reason?, decidedBy: system}` is logged, and no question row or `agent.needs_input` is logged;
- `ask`: the user-held question opens as before.

The gate reads the policy on every check. It uses the agent's project's `permissionPolicy`, then the global default, and only for an agent outside any project the policy it was spawned with. The gate reports its own refusals through `onDeny` (not cap refusals), and the runtime logs those as `permission.decided{deny}` without `questionId`. An adapter whose runtime asks about calls itself (PTY, ACP) may therefore emit permission requests without consulting the gate.

**TECHNOLOGY §8, append (remote clients).** `isRemoteRequest(req)` counts a request as local only when it comes over a loopback connection, has no non-loopback `Origin` and no Tailscale identity header. Everything else is remote. `autoApproveRemote` (in `config.json`, or `GALACTIC_AUTO_APPROVE_REMOTE`) is off by default. While it is off, a policy a remote client chooses is floored at the global default with `noLooserThan`, the stricter of the two tables per category. Today that applies to the `POST /api/agents` presets. An answer to a permission question from a remote client is an explicit user decision and is accepted.

**TECHNOLOGY §7 (vocabulary), add.** `permission.decided`: the policy decided a permission without the user (allow or deny). No question row.

## Deferred

- **Answer source.** `question.answered` does not yet record whether the user answered from a remote client. Add `source: 'local' | 'remote'` when Phase 7 adds remote clients. `isRemoteRequest` is the place to derive it from.
- **Other places that set a policy.** The ops console (P2-18) and any Harmonizer tool that creates or edits a project's `permissionPolicy` on a remote user's behalf must apply the same floor. They should take the request's source, as `POST /api/agents` does. The SPEC §8 question about a global floor (decision 22) is still open.
- **Ordering of hook refusals.** A refusal in the hook is logged synchronously from the gate. The adapter's own events go through the runtime's event pump, so a refusal can land a few events before earlier events that are still queued. The refusal itself is never lost.
- **`Commands.recordAgentEvent`** (events that do not come from a live session) still opens a user-held question for every permission request. Without a session, nothing can answer the adapter, so it fails closed.
- **SDK adapter wording.** A system `deny` reaches the model as "The user refused: deny: …". A cosmetic change to the adapter's message can wait.
