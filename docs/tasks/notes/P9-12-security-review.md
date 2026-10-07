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
