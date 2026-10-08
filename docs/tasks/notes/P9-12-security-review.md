# P9-12 security review (Phase 9, whole phase + wave 4)

Review of `main...phase-9` at c33c75a (2026-10-08) against the TECHNOLOGY §9.9 checklist, focused on
wave 4 (P9-10, P9-11), which no wave review had seen. **No blocker.** Fixes: see "Fixed" at the end.

## Should-fix

**S1 — The Run dialog does not reliably show the exact command; stored lines are not checked like
edited ones.** The line was shown only in a single-line input; agent lines were refused only for
`\0\r\n`; hand-added/edited lines not checked; a start checked the stored line only for NUL.
Scenarios: `pnpm dev` + 200 spaces + `; payload` hidden in the field; bidi/format characters; a
remote PATCH with a newline merged by the browser input while `sh` runs two commands. Fix: validate
every stored line in the domain (control + `\p{Cf}\p{Zl}\p{Zp}`), re-check at start, and show the
full line in a wrapping read-only block with invisible characters made visible.

**S2 — "What it runs" is neither current nor complete.** The body comes from the last scan (stale if
the folder changed since), `pre<name>`/`post<name>` hooks are dropped, bodies are cut at 4000
characters, a PEM header masks to the end of the string, warnings are computed on the line only,
and a hand-edited detected row still shows the file's body. Fix: re-read the manifest at preview and
bind the body's hash in the confirmation (start answers `stale` if it changed), include hooks, show
"truncated"/"part hidden" notices, classify the unredacted body, and drop the body when the line
was edited.

**S3 — The bearer token is a way to run any command outside the permission gate.** A Steward that
obtains the token (the `/health` speed bump) can mint a confirmation for any line and start it as
an unmarked process. The confirmation token is a staleness/UX guard, not a boundary. Fix: say so in
REMOTE_ACCESS §4 and TECHNOLOGY §9.9; refuse start/restart/edited previews from a TCP peer carrying
`GALACTIC_AGENT_ID` (a speed bump); record a §8 question.

## Nits

- N1 confirmation reusable for 15 minutes; cwd not bound. N2 run-folder check/spawn race. N3
  detection error messages quote file contents unredacted. N4 hand-added lines not checked for
  secrets. N5 the dialog shows an agent's title verbatim as the question. N6 copy walks hold the
  repository lock with no budget. N7 a large run backlog can overflow the socket's send buffer at
  the maximum `maxBytesPerRun` setting.

## Checked and OK

Paths end to end (declare → copy → serve → open → run cwd); file and app headers and CSP; tickets;
remote rules match §9.9 (open, reveal, IDE, app, outside-path add, start, restart are Mac-only even
with `autoApproveRemote`; reads, preview, output, subscribe and stop open to the phone); the run
environment (allow-list, no token or keys, no agent marker, stdin closed); no shell strings beyond
`/bin/sh -c <line>`; redaction of output, logged lines, titles, descriptions, bodies; run process
attribution and identity-checked cleanup; panel XSS (Markdown `skipHtml`, highlight.js, rasterised
SVG, `safeLink`, xterm http(s) links after a confirm, counts-only label marks and notifications);
the desktop shell's `on_new_window` (deny, http(s) to the browser, rate-limited); the confirmation
token's HMAC; resource limits; agents cannot start, stop or restart runs.

## Fixed

On `p9-12-fixes-e2e` (2026-10-08).

- **S1** — `commandLineProblem` (`packages/protocol`): one visible line — no control character
  (tab and newline included), no `\p{Cf}` / `\p{Zl}` / `\p{Zp}` / private-use / lone surrogate,
  no space but the plain one, no `[redacted:…]` mask. The domain checks it in `addDeliverable`
  and `updateDeliverable` for every writer (agents, by hand, remote), the routes trim the line,
  and the run service checks the line again at every preview (a `refusal`) and start (400
  `invalid`), so a row written before is never run. The Run dialog shows the whole line in a
  wrapping read-only block above the field (`pre-wrap`, `overflow-wrap: anywhere`): a run of 3+
  spaces as `␠×n`, a tab as `⇥`, anything invisible as `⟨U+XXXX⟩` (`lineSegments`).
- **S2** — the preview re-reads the detected script from the run's folder with the scan's
  parsers (`commandBodyOf`), with the `pre`/`post` hooks for npm, Yarn classic and Bun; the body
  is shown redacted with `bodyTruncated` / `bodySecretHidden` notices ("open the file"), the last
  scan's body when it differs (`scannedBody`), and every line of it is classified unredacted by
  the permission engine (warnings merged, reasons redacted). The confirmation binds the body's
  sha256 (with the line, version and folder); a start re-reads it and answers 409 `stale` when it
  changed. A line edited by hand (in the row or the dialog) gets no body and `bodyMissing`
  ("Edited by hand"). `run.started` keeps the body as read at the start.
- **S3** — documented in `docs/REMOTE_ACCESS.md` §4 and TECHNOLOGY §9.9 (a token holder can run
  any command); the speed bump `http/peer-guard.ts`: a start, restart or edited-line preview over
  loopback whose peer (`lsof` by the connection's ports) or an ancestor carries
  `GALACTIC_AGENT_ID` / `GALACTIC_RUN_ID`, or runs below Mission Control, is 403 `agent_peer`;
  an unidentified peer is allowed and logged (decided: refusing would refuse the user's own
  panel whenever `lsof` is slow or missing). SPEC §8 (2026-10-08): a run-only capability.
- **N1** — a confirmation starts one run (remembered until it expires; a restart's own start
  uses it, a second restart with it is `unconfirmed`); the folder is bound in the MAC.
- **N2** — the folder's `(dev, ino)` and path are checked again right after the fork; a change
  ends the run `stopped` / `folder_changed`. What the shell did in that instant is a known limit
  (TECHNOLOGY §9.8 "As reviewed").
- **N3** — JSON and TOML parse problems give the line and column only (no snippet, no code
  frame); every detection problem is redacted before it is logged or returned.
- **N4** — a command line added or edited by a person (or an agent) that looks like a secret is
  refused: "read it from the environment or a file you keep instead".
- **N5** — the dialog's heading quotes the title (`Run “…”?`); an agent's title is said to be
  the agent's words, "declared by <agent>".
- **N6** — `MERGE_COPY_BUDGET`: 100 000 entries and 120 s per merge for all its copies inside the
  repository lock; past it a deliverable is marked missing with the reason and the supervisor is
  told (`mergeBudget` option for tests).
- **N7** — `run.subscribe` sends the newest 1 MiB of the backlog (`RUN_BACKLOG_BYTES`); the panel
  reads the start over REST as before and says when the middle is not shown.

End to end: `e2e/tests/09-deliverables-flow.spec.ts` — the scene harness prepares a real project
folder (`prepare: true`, detection scans it) and its Steward declares an image and a text file
through the agents' declaration service (`/dev/harness/agents/:id/declare`); both show in the
Steward view and the project's Deliverables; the detected `package.json#dev` runs a fixture
server from the Run dialog (exact line, the script as the file says), its output and port show,
Stop ends it; a page loaded under a non-loopback host name (its own browser,
`--host-resolver-rules`) lists the deliverables, offers no open and no Run ("on the Mac"), and
its own `runs` / `open` calls get 403 `remote_control`. Conformance and export/import cover the
scan's body, the run's body, an edited run, `folder_changed` and a refused line.
