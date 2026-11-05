# P12 batch 1 (`p12-1-launch-flags`) — review notes

Batch: P12-01 … P12-10 (Steward launch flags). Branch `p12-1-launch-flags` from phase branch `agent-launch-flags`.
Process: one implementer per task, then a spec-and-quality review of each task, then a whole-branch review and one fix wave. Gates on the final head: build, typecheck, lint and format:check are green. Tests: protocol 199, desktop 80, server 2492 passed / 13 skipped, web 2053.

## Notable findings fixed in review

- **P12-01:** the probe's safety guard was a denylist. It became a host allowlist bound to the probe's own tab and checked offline with a self-test. The recorded spike runs used the weaker guard.
- **P12-03:** `launchFlags` and the stored `launch.flags` could differ between spawn and resume. They must now be the same set.
- **P12-05:** the scope judge could load user or plugin MCP servers. It now sets `strictMcpConfig`, and injection tests were added.
- **P12-07:** marking an approval as used wrote the row with no event. It now records `question.launch_used`, which survives replay. Migration 0018 widens the `questions.kind` CHECK; the CHECK change was missed in P12-02.
- **P12-09:** the legacy console offered Allow/Refuse and free text for these cards. It now shows the fixed answers and the card details.
- **P12-10:** the one-Chrome rule only looked at the caller's own Stewards. It now looks at every live Steward.
- **Final review:**
  - An agent started without `--chrome` that still had Chrome tools went through the ordinary policy. The gate now denies those calls, and every other Claude session starts with `--no-chrome`.
  - A late verdict could act on a call already withdrawn by an interrupt. It is now dropped, and the judge's reason is redacted.
  - "Stop the Steward" now stops even when the adapter's answer fails.
  - The runtime is checked before an approval is used.
  - Flags must be unique.
  - The adapter has its own flag-to-argument table.

## Left open (minor, not blocking)

- One-Chrome check can race across projects. Two Stewards could share the browser, but each is still judged.
- The approved `cwd` is not asserted at spawn.
- The first `spawn_steward(launchFlags)` call doesn't check whether Chrome is busy.
- Denying leaves the pre-created worktree. This is harmless.
- `requestLaunch` scans every question.
- The legacy console has no busy guard. The server refuses a second answer.
- `dispose()` does not cancel checks still in flight.
- The non-Claude adapters ignore `launchFlags`. The runtime refuses first.
- Small cosmetic items.

## Not yet verified (P12-10 real run, waits for Cosmin)

- Whether the SDK accepts the judge's `tools: []` and `strictMcpConfig`.
- How good and how fast the judge's verdicts are.
- `--no-chrome` on the SDK's bundled CLI. The installed `claude` lists it; the bundled binary was not checked.
- Uploading a screenshot to a GitHub PR.

Procedure: `docs/tasks/notes/P12-10-real-run.md`.
