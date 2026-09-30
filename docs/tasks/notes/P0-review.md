# Phase 0 review (2026-09-30)

Reviewed at commit `cd98ecd`. Verified on a fresh clone: `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check` and `pnpm test` (37 + 41 + 18) all green; web suite run 5× without flakes; `galactic start` serves the built page, `/health` withholds the token from a foreign `Origin`, a bad `Host` gets 403, `POST /dev/events` appends and refuses `agent.output`. `better-sqlite3@13` really does ship prebuilds, so no install script is needed.

Overall the phase is in good shape: the protocol package is the single vocabulary as intended, the one-write rule is real (nested commands join the transaction, a throw rolls back rows and events), the security checks are tested, and the resume test exercises the real client against the real server. The items below are what should change before Phase 1 builds on it.

## Must fix

### R1 — A page reload with a persisted `lastEventId` loses the world
`session.ts` sends `hello{lastEventId}` from `localStorage` on a fresh page load, but the derived world is not persisted: the store starts from `emptyWorld()`, the server replays only the events after `lastEventId` (or just `caught_up`), and the page never receives a snapshot. Reproduced: one project on the server, reload → page shows 0 projects. It is invisible in today's demo because `agent.progress` events change nothing in the world.
Fix (simplest, correct): keep `lastEventId` in memory only (reconnects within a page's life still resume exactly); drop the `localStorage` key. A fresh load always gets a snapshot, which is cheap. Alternative if reload-resume is really wanted: persist `{seq, world}` together and send `lastEventId` only when a world with that seq was restored. Update `App.test.tsx` ("resumes from the saved seq") accordingly.

### R2 — `EventLog.publish` is not re-entrancy safe
A subscriber that runs `runCommand` while being notified (a projection or a brain mailbox will do exactly this in Phase 1) makes other subscribers see events out of order. Reproduced: command emits 1 and 2; subscriber A reacts to 1 with a command emitting 3; subscriber B sees `[3, 1, 2]`. A WebSocket session would then drop 1 and 2 (`lastSent` guard) and the client only recovers by detecting the gap and reconnecting.
Fix: a `publishing` flag and a drain loop — events committed while publishing are appended to the queue and delivered after the current batch, so every subscriber always sees strict `seq` order. Add the test above to `event-log.test.ts`.

### R3 — `pnpm dev` (and `pnpm test`) fail on a fresh clone
`@galactic/protocol` resolves to `dist/`, which does not exist until `tsc` has run; `tsx watch` and Vite both crash before the protocol watcher emits (reproduced). The README quickstart happens to run `pnpm build` first, but the "Development" section says `pnpm dev`.
Fix: `"dev": "pnpm --filter @galactic/protocol build && concurrently …"` (or point Vite/tsx at `packages/protocol/src` via `exports` conditions). Consider a root `pretest` that builds protocol, or state in the README that `pnpm build` precedes `pnpm test`.

## Should fix now (cheap now, a migration or a protocol change later)

### R4 — `seq` must be monotonic forever
`events.id INTEGER PRIMARY KEY` without `AUTOINCREMENT` reuses the rowid of the newest row after it is deleted. Retention pruning removes the oldest rows, so it is unlikely, but the protocol promises "strictly increasing seq". Make it `AUTOINCREMENT` while migration 0001 is the only one (the table is empty everywhere).
In the same spirit, give the log an identity: a `logId` in `settings`, returned in `snapshot` and `/health`, sent back in `hello`; a mismatch (database deleted/replaced while a tab is open) yields a snapshot instead of replaying an unrelated history. Record in `TECHNOLOGY.md` §6.3.

### R5 — `/dev/*` routes are always on and can desynchronise snapshot and replay
`registerDevRoutes` runs whenever a log exists, including under `galactic start`. `POST /dev/events` appends any domain event without the matching row mutation (e.g. `project.created` with no `projects` row), so a resuming client and a snapshotting client disagree. Gate the routes behind `GALACTIC_DEV=1` (off in `galactic start`), or restrict the route to the harmless `agent.progress` / `agent.idle` demo events.

### R6 — The `/health` token hand-out will not survive a reverse proxy
The token is returned when the TCP peer is loopback and the `Origin` is any allowed host. Tailscale Serve (Phase 7) connects from loopback with `Origin: https://<mac>.<tailnet>.ts.net`, an allowed host, so every tailnet peer would get the token. Hand it out only when the `Origin` (if present) is itself a loopback host name (`localhost`, `127.0.0.1`, `[::1]`), never for the configured extra hosts; note it in `TECHNOLOGY.md` §8.

### R7 — Decide where the status projection lives before P1-05
`apps/web/src/state/reduce.ts` is a second implementation of the projection the server will build for `snapshot.statuses` (and it currently ignores `agent.spawned` for unknown agents and never adds to `world.agents`). If the two drift, snapshot and replay give different worlds. Decide now: one projection function (in `packages/protocol`, pure, event → state) used by both the server snapshot builder and the client reducer. Add the decision to `TECHNOLOGY.md` §4/§6.3 and reference it from P1-05.

### R8 — `agent.needs_input` cannot describe a permission question
`AgentNeedsInput.question` carries only `{kind, text, options?}`, while `QuestionContext` also has `toolCall` and `permissionAction`, which a permission question needs for the policy table. Reuse `QuestionContext` in the event before the adapter work starts (P1-01/P1-02).

### R9 — No home for the per-project `PermissionPolicy`
`CreateProjectInput.permissionPolicy` exists, `Project` has no such field and there is no table. Decide (a `permission_policy` JSON column on `projects` is the obvious choice) and add migration 0002 with P2, but record the decision now so nobody parks it in `meta`.

## Hygiene

- The working copy contains an untracked `package-lock.json` and an npm-layout `node_modules` (no `.pnpm`, no `@galactic` links): someone ran `npm install` at the root. Delete both, `pnpm install`, add `package-lock.json` and `yarn.lock` to `.gitignore`, and add `"preinstall": "npx only-allow pnpm"` (or at least `engines.pnpm`).
- `.npmrc` says better-sqlite3 needs its build scripts (`enable-pre-post-scripts=true`); the last commit says the opposite and is right. Remove the stale line/comment.
- `apps/web/tsconfig.json` turns `exactOptionalPropertyTypes` off, unlike the other two packages; either fix the few sites or note why.
- `TECHNOLOGY.md` §7 lists `Agent{…, role, runtime, sessionRef, supervisorId, bodyId}`; the phase file claims `taskId`/`projectId` were recorded there. Add them.
- Small server nits: attach a no-op `'error'` listener to the raw upgrade socket before `deny()` writes to it (an EPIPE there is an unhandled error); clear the hello timer on socket `close`; `galactic start` prints "Token generated" after the banner.
- Small web nits: on a `4401` close the page keeps the stale token (after a config reset the user is stuck until "Forget token") — forget and re-discover automatically; `emitFake` ignores a non-2xx response.
- Exit-criteria row 2 is still "not clicked through in a real browser". Do it once, and while doing it emit a `project.created` (through `/dev/events` with a matching row, or wait for R5) and reload the page — that is the R1 check.

## Suggested tasks

Append to `PHASE_0_FOUNDATIONS.md` as P0-12 … (added 2026-09-30), or fold into Phase 1 wave 1:
- P0-12 Memory-only `lastEventId` (R1) + App test.
- P0-13 Re-entrant publish in `EventLog` (R2) + test.
- P0-14 `pnpm dev`/`pnpm test` build protocol first (R3).
- P0-15 `events` AUTOINCREMENT + log identity in `hello`/`snapshot`/`health` (R4).
- P0-16 Dev routes behind `GALACTIC_DEV` (R5); `/health` token only for loopback `Origin` (R6).
- P0-17 Repo hygiene (lockfile, `.npmrc`, `.gitignore`, `only-allow`).
- Decisions to record in `TECHNOLOGY.md` before P1: shared projection (R7), `needs_input` shape (R8), permission-policy storage (R9).
