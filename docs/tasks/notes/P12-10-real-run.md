# P12-10 — Local real run (Steward launch flags)

**Status: not yet run — awaiting Cosmin.** The run drives Cosmin's own Chrome and posts a
screenshot to a GitHub PR, which is outward-facing, so it waits for his go-ahead (SDD ruling,
2026-11-05). Everything below is the procedure; fill in **Result** when it has been run.

Plan Task 10, step 5: a real Waykeeper and a real Steward take one screenshot of a local page
and attach it to a PR in a scratch repository. Local only; never part of CI.

## Prerequisites

- Claude Code CLI with `--chrome`, the Claude in Chrome extension installed and connected
  (as in `P12-01-chrome-spike.md`), subscription login.
- A **scratch** GitHub repository Cosmin owns (e.g. `<cosmin>/galactic-chrome-scratch`), cloned
  locally, with `gh` logged in. Nothing else on GitHub is touched.
- Chrome logged in to GitHub as Cosmin (the screenshot upload goes through the PR page).
- The batch branch `p12-1-launch-flags` built (`pnpm build`).

## Procedure

1. **Local page.** In the scratch repository add `site/index.html` with a visible heading
   (e.g. "Launch flags real run") and serve it: `npx serve site -l 5173` (any static server
   on `http://localhost:5173`).
2. **A PR to attach to.** On a branch `real-run`, change the heading, push, and open a PR in the
   scratch repository (`gh pr create --fill`). Note its URL: `<scratch PR>`.
3. **Mission Control.** Start the server on the real runtimes (no `GALACTIC_HARMONIZER=fake`, no
   `GALACTIC_STEWARD_RUNTIME` override), open the web UI on the Mac.
4. **Project.** Ask the Harmonizer for a small project on the scratch repository's folder, e.g.
   "In the scratch repo, take a screenshot of http://localhost:5173 and attach it to `<scratch
   PR>`." Approve the proposal card and the Waykeeper's plan card (one task).
5. **Launch card.** The Waykeeper should call `spawn_steward` with `launchFlags`. Expect a
   **launch** card: command `claude --chrome`, the task's worktree as working directory,
   "controls your Chrome browser", a reason, an expected use naming `http://localhost:5173` and
   `<scratch PR>`, and a check ("the PR has a screenshot of the page"). Buttons exactly
   **Approve and start**, **Start without flags**, **Deny**. Answer **Approve and start**.
6. **Steward runs.** The Steward card shows the `--chrome` badge. Its Chrome calls
   (`tabs_create_mcp`, `navigate` to `localhost:5173`, `computer` `screenshot`, `navigate` to
   `<scratch PR>`, `upload_image`/`file_upload`, the comment submit) should mostly be judged
   **consistent** — no card.
7. **Off-script probe (optional, recommended).** Tell the Steward through its clarification or a
   chat line to also open `https://news.ycombinator.com`. Expect an **off-script** permission
   card (the call, the expected use, the precedents, the judge's reason) with exactly
   **Approve and continue** / **Stop the Steward** and no "Allow similar". Answer
   **Approve and continue** once; a second visit to the same host should pass without a card.
8. **Final check.** When the Steward finishes, the Waykeeper should verify the check (the PR has
   the screenshot) and report it to the user through the Harmonizer.
9. **Clean up.** Close the scratch PR, stop the static server, close the Chrome tab.

## Expected log events (in order, from `GET /api/events` or the History view)

1. `question.opened` — `kind: launch`, `holder: user`, `context.launch.command: "claude --chrome"`.
2. `question.answered` — `answer: "Approve and start"`, `answeredBy: user`.
3. `question.launch_used` — `{questionId, taskId, agentId: <Waykeeper>}`.
4. `agent.spawned` — the Steward; its row's `meta.launch` holds the flags, expected use, check,
   approval id and `precedents: []`.
5. For each consistent Chrome call: `permission.decided{decision: allow, decidedBy: {agent:
   <Waykeeper>}, reason: "consistent with the Steward's approvals: …"}`, then `agent.tool_call`.
6. If step 7 was done: `agent.needs_input` + `question.opened` (`kind: permission`,
   `context.offScript`), `question.answered "Approve and continue"`, `agent.updated{changes:
   {meta}}` (the precedent), `agent.tool_call`; later the same host is a `permission.decided
   allow`.
7. `agent.finished` (or `agent.idle` then the Waykeeper's stop) and the Waykeeper's report.

Also check: no Chrome call ran before its verdict (each `agent.tool_call` for an
`mcp__claude-in-chrome__` tool follows its `permission.decided` or its answered question), and
the judge's model calls do not show up as agents.

## Things this run verifies that the fake tests cannot

- `tools: []` and `strictMcpConfig: true` are accepted by the real SDK for the scope judge
  (open from P12-05).
- The scope judge's real verdicts and latency (well under the 20 s timeout).
- Whether `upload_image` or `file_upload` works on GitHub's comment box (P12-01 §5, unverified).

## Result

Not yet run — awaiting Cosmin.
