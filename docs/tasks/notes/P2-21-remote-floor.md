# P2-21: Remote floor on every policy write

From the wave-3 review (finding 4). Before this task only `POST /api/agents` floored a remote client's policy. Every other `permissionPolicy` write took the policy as given, and since the gate reads `project.permissionPolicy` live, such a write loosened running agents at once.

## What was built

- **One function.** `policyForWrite(policy, { origin, autoApproveRemote })` (`apps/server/src/domain/permissions.ts`) is the only place a written policy is judged:
  - it returns the policy unchanged when `origin === 'local'` or `autoApproveRemote` is set;
  - otherwise it returns `noLooserThan(policy)`: the stricter of the policy and the global default, per category.
- **Every write goes through it.**
  - `createProject` and `updateProject` (`domain/projects.ts`): `parsePolicy(policy, write)` validates, then floors. Both functions take a trailing `write: PolicyWrite = {}`.
  - A project `control.edit` (`domain/control.ts`): the panel can now set or clear `permissionPolicy` (it could only rename before). The edit is checked and floored *before* `control.edit` is emitted, so the event carries what was applied, not what was asked. A task edit with a policy is refused (`invalid`).
  - `POST /api/agents` presets (`http/agent-routes.ts`): the inline floor now calls `policyForWrite`.
  - Clearing (`null`, P2-20) needs no floor. It returns to the global default, which is the floor itself.
  - `Workspaces.prepareProject` calls `updateProject` without a policy, so nothing is floored there.
- **The command surface carries the origin.**
  - Protocol: `RequestOrigin = 'local' | 'remote'` (`enums.ts`) and `WriteOptions { origin?: RequestOrigin | undefined }` (`commands.ts`).
  - `DomainCommands.createProject(input, write?)`, `updateProject(id, changes, write?)` and `control(target, action, by, write?)` take it as an optional last argument. The change is additive: existing callers compile unchanged.
  - `Commands` adds `autoApproveRemote` from `CommandsOptions`. `composeRuntime` gets it through `ComposeOptions.autoApproveRemote`, and `index.ts` passes `config.autoApproveRemote`.
- **The REST routes say where the request came from.**
  - `originOf(req)` (`http/security.ts`) is `isRemoteRequest(req) ? 'remote' : 'local'`.
  - `POST /api/control` passes it to `commands.control`.
  - `POST /api/agents/:id/send` passes it to `runtime.send`, which records it on `message.sent`.
- **`message.sent.origin`** is optional and set only on user messages that came through REST. Agents' and system messages carry none.
  - Event fixture: unchanged (it is an agent's message, so it carries no origin). A protocol test parses a user message with `origin` and refuses an unknown value.
  - Web reducer: `message.sent` is already a no-op fold.
  - Conformance: unaffected (no rows change).
- **REST policy edit:** chosen as `POST /api/control` with `{ action: 'edit', changes: { permissionPolicy } }` on a project, consistent with the existing panel route, rather than a new `PATCH`. `ControlActionBody`'s edit takes `permissionPolicy: PermissionPolicy | null`.
- No migration.

## Decisions

- **An unknown origin is floored.** A write that nobody marked `local` counts as remote, failing closed the way `isRemoteRequest` does. The consequences:
  - a brain that does not pass an origin can never loosen a policy;
  - a test or internal caller that wants a looser policy passes `{ origin: 'local' }`. Three existing tests were updated this way.
- **The floor is the global default, not the project's current policy.** A remote client may tighten a project's policy at will. It may also relax a stricter-than-default project policy, but never below the global default in any category.
- **A brain turn's origin** is `originOfMessages(messages)`:
  - `local` only when every message in the turn is `origin: 'local'`;
  - `remote` when any message is remote;
  - unknown otherwise (an agent's or the system's message is in the turn). Unknown is floored.

Proposed SPEC text (append to decision 31, or make it decision N):

> **Decision N — Every policy write is floored for remote clients** (2026-10-02, P2-21). A project's permission table set or changed from a remote client — at creation, by a panel edit, or by the Harmonizer or a Waykeeper acting on a remote user's message — is held to the global default in every category unless the server is configured with `autoApproveRemote`. A write whose origin is unknown (an agent acting on its own or on another agent's message) is treated as remote. Clearing a project's table (back to the global default) is allowed from anywhere. The panel's edit records the table as applied.

Proposed TECHNOLOGY §8 text (replace "— today on the `POST /api/agents` presets"):

> … floored at the global default with `noLooserThan` (the stricter of the two per category). Every `permissionPolicy` write goes through `policyForWrite(policy, { origin, autoApproveRemote })` (`domain/permissions.ts`): `createProject`, `updateProject`, a project `control` edit and the `POST /api/agents` presets. The command surface takes the origin as an optional `WriteOptions { origin: 'local' | 'remote' }` last argument; a missing origin counts as remote. The REST routes pass `originOf(req)`, and `POST /api/agents/:id/send` records it on `message.sent.origin`, so a brain acting on a user's message writes with that message's origin (`originOfMessages` over the turn: `local` only if every message is).

TECHNOLOGY §7 (protocol vocabulary): add `RequestOrigin`, `WriteOptions` and `message.sent.origin?`.

## The seam for brains (P2-08, P2-10)

A brain tool that writes a policy (`createProject` with `permissionPolicy`, `updateProject`, `control` edit) passes the origin of the turn it acts on:

```ts
const origin = originOfMessages(turnMessageSentEvents); // from domain/permissions.ts
await commands.updateProject(projectId, { permissionPolicy }, { origin });
```

`turnMessageSentEvents` are the `message.sent` events the runner folds into the turn (`brains/runner.ts` already collects their ids). If a tool passes nothing, the write is floored. That is safe, but then a local user cannot loosen a policy through the Harmonizer. `apps/server/src/http/agent-routes.test.ts` ("records a message's origin, and a brain's write for a remote message is floored") checks the seam at the command level.

**Merge note:** a brain test that creates a project with a looser-than-default policy through `commands` without `{ origin: 'local' }` now gets the floored table.

## Deferred

- The brain tools themselves must pass the origin (P2-08 / P2-10, at merge).
- WebSocket commands do not exist yet. When the WS surface accepts commands (Phase 2.5/7), it must pass `originOf(upgradeRequest)` the same way.
- P2-18's panel policy editor should use `POST /api/control` edit, and can show the returned `project.updated` table so a remote user sees the floor applied.
- The SPEC §8 open question (should the global default be a floor for local writes too?) is unchanged.
