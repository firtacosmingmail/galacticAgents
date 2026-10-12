# P9-17 review ("Allow similar" for a project's work)

Review of `p9-17-impl`, 2026-10-12, security first. Two blockers. Fixes on `p9-17-review-fixes`
(from `p9-17-impl`); gates green (protocol 122, desktop 79, server 1857 + 6 skipped, web 1861),
`pnpm e2e` 18/18.

## Blockers (fixed)

- **B1 — `guarded` only covered paths inside the workspace.** A category rule for "outside the
  workspace" made from a harmless outside read then allowed writing `~/.claude/settings.json`,
  `~/.mcp.json`, `>> ~/.zshrc` or a LaunchAgents plist; the deliverables folder outside the
  workspace, another repository's `.git/hooks`, `~/.gitconfig` and `~/.config/git` were never
  guarded. `guardedWriteReason` now judges every edit path and every command write target wherever
  it is: configuration segments (below the cwd or workspace, or anywhere on the path outside them),
  the deliverables folder, shell start-up files, `~/Library/LaunchAgents` and `/Library/Launch*`,
  `~/.ssh`, `~/.gitconfig`, `~/.config/git`, `~/.claude.json`, `~user`. Defence in depth: a call
  outside the workspace matches only an exact or a folder rule (read and write apart), and an edit
  folder rule never matches a guarded physical path (a symlink into `.git/`).
- **B2 — prefix and category rules made from an outside call covered the whole computer**
  (`cat /tmp/x` → `cat`, `git -C / status` → `git`). Outside the workspace only "exactly this" or
  the folder is offered; the server refuses the other scopes (it drafts from the same options), and
  a stored prefix or category rule never matches an outside call.

## Should-fix (all fixed)

1. S1: each previewed option carries a digest of the rule; `allow-similar` sends it back and gets
   409 `stale` when the rule drafted again differs.
2. S2: curl's uploads (`-d/--data*/--json @f`, `--data-urlencode n@f`, `-F n=@f`, `-T`, `-K`) are
   read targets; the card names every file curl sends.
3. S3: no prefix for shells and interpreters (or a bare `npx`); `npm`/`pnpm`/`yarn`/`make` prefixes
   warn that they run scripts the agent can change.
4. S4: the peer guard on answering a permission request and on dismissing a question (the desktop
   app, Mission Control's parent with no marker, and the panel pass).
5. S5: SPEC §8's run-capability question extended: a speed bump for answers and rules too.
6. S6: the project and the rule are checked before the answer; one transaction when no session
   waits; otherwise "allowed once; the rule was not stored", shown on the card.
7. S7: one resolver (`projectIdOf`, the task's project as fallback) for the table, the workspace and
   the rules.
8. S8: an offline preview builds the gate's context with the deliverables folder and aliases.

## Nits (fixed)

The prefix preview says "every command of the line starts with …"; labels say "(and any further
arguments)"; TECHNOLOGY §8 documents Grep/Glob following links inside a ruled folder and the
gate→open time-of-check gap.
