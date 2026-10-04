# P5-06 — Controls for the Harmonizer

SPEC decision 82 (Cosmin, from P5-05's checklist row §4.2.42h / follow-up F2): the Harmonizer's dock offers Pause and Resume like any agent's, and a confirmed **Restart Harmonizer**; never a plain Stop; "Resume session" only for an interrupted Harmonizer.

## What was built

### Server — `POST /api/harmonizer/restart`

- `apps/server/src/brains/harmonizer/restart.ts` — `harmonizerRestarter(host, opts)` returns the restart function; `index.ts` wires it with the boot runtime (`GALACTIC_HARMONIZER`), the projects root and the Harmonizer's deps, and passes it to `buildApp` (`restartHarmonizer`), which registers the route in `http/agent-routes.ts`.
- Sequence: the live Harmonizer's runner is disposed (so the withdrawals do not wake it for a turn) → the user questions it asked through a tool (`ask_user`, `ask_confirmation`: clarification, `meta.source: command`, not a project's closure question) are withdrawn by `system` → it is stopped with `by: user` → `startHarmonizer` starts a fresh one on the same runtime and working directory.
- **One live Harmonizer:** the old one is stopped (and gone from `liveAgents`) before the new one is started; the user's stop means `keepHarmonizer` does not start another one beside it; a second restart while one is under way is refused (409).
- **Questions (decision 45):** withdrawn questions are named in the new Harmonizer's first turn ("ask again if it still matters"); the closure question is cancelled with the stop and `closureNotes` relays the closure request again; questions the old one *held* (a Waykeeper's, escalated) move on as on any stop (P2-03) — to the next living holder, i.e. the user.
- **The user informed:** `StartHarmonizerOptions.notes` (new) puts lines first in the new Harmonizer's first turn, once: "the user restarted the Harmonizer from the panel: the previous one (…) was stopped and you are a fresh one, seeded from the database. Tell the user in one line that the Harmonizer was restarted and is ready".
- **Runtime choice:** the live one's; else the newest Harmonizer row's (one stopped from the ops console, interrupted or failed); else the boot setting; with none (`GALACTIC_HARMONIZER=off` and no Harmonizer ever) → 409 `refused`. The scene harness's dormant stand-in is never taken for the Harmonizer.
- **Auth decision:** bearer-guarded like every `/api` route, and open to any authenticated client (remote too), consistent with `POST /api/agents/:id/stop` and the panel's controls — it is a control action, not a settings write. Documented in TECHNOLOGY.md ("Restarting the Harmonizer").
- Protocol: `RestartHarmonizerResponse {agentId, replaced?}` in `packages/protocol/src/rest.ts`; web `api.restartHarmonizer()`.

### Panel — the Harmonizer's dock bar

- `HarmonizerControls` in `apps/web/src/panel/controls.tsx`, rendered by `MainHeader` in `Panel.tsx` for the Harmonizer (keyed by its id): "Pause the Harmonizer" / "Resume the Harmonizer" (`POST /api/control` on the agent, via `useControls`), "Resume session" only while it is `interrupted`, and "Restart Harmonizer" (offered in every state, so the user is never left without one) behind an inline confirmation.
- The inline confirmation was factored out of `ControlFeedback` into `ConfirmBox` (same behaviour: focus on "Keep" — decision 81 — Escape keeps, focus back to the opener), now shared by the cards, the strip and the Harmonizer's controls.
- No Stop and no "More" menu for the Harmonizer. The selection stays `{kind: 'harmonizer'}`, which resolves to the newest running Harmonizer (`currentHarmonizer`), so the dock follows the new id as soon as the stream brings it. Works with and without the scene (the dock bar is the same in both).

## Tests

- `apps/server/src/brains/harmonizer/restart.test.ts` (4): stops the old one as the user and starts one fresh one on the same runtime (one live, `control.stop{by: user}`, `keepHarmonizer` armed does not add another, first prompt says restarted); withdraws its `ask_user` question and names it once, closure relayed again; a concurrent second restart refused; no Harmonizer → refused without a runtime, started on the default, and after a user stop restarted on the last one's runtime.
- `apps/server/src/http/harmonizer-restart-route.test.ts` (4): 401 without the token (nothing stopped), 200 with the new id and `replaced`, 409 when it cannot start one, 404 without a restarter.
- `apps/web/src/panel/controls-strip.test.tsx`: P4-09's "… and not for the Harmonizer" became "the Harmonizer gets its own controls, not this strip" (pause + restart, no stop, no More); new describe "the Harmonizer's controls in its dock bar" (3): pause/resume, "Resume session" only when interrupted, the confirmation (starts on Keep, Escape/Keep send nothing, Yes posts the restart).
- `apps/web/src/conformance/spec-4-2.test.tsx`: row §4.2.42h, three tests × two modes (with the scene / list mode): pause and resume, resume session, restart confirmed with the dock following the new Harmonizer.

## Checklist

`docs/tasks/notes/P5-05-checklist.md` row §4.2.42h is ✓ / ✓. The checklist's header counts (77 rows: 75 ✓, 1 ✗, 1 partial) and follow-up F2 are left for the coordinator to update when P5-06 and P5-07 merge (the same lines carry §4.3.25, P5-07's row): with this task §4.2 has no ✗ left.

## Notes

- The new Harmonizer is a new agent row with an empty chat; the old conversation stays in its row's history.
- Pause of the Harmonizer is the plain agent pause (adapter-level); it is not replaced while paused.
