# Steward launch flags — design

**Date:** 2026-11-05 · **Branch:** `agent-launch-flags` (from `main`) · **Status:** draft for Cosmin's review

## 1. Intent

Some Stewards need abilities that a normal Steward does not have. The first case: a Steward
fixing a UI bug has to take before/after screenshots and upload them to the PR. GitHub has no
API for image uploads, so the Steward needs a browser, which in Claude Code means starting the
session with `--chrome` (Claude in Chrome, driving Cosmin's own Chrome). More flags will follow,
so the mechanism is general and `--chrome` is its first entry.

Cosmin's words: "I decided it needed chrome, because that is what I use." The **Waykeeper**
decides when a Steward needs a flag, but Cosmin **reviews the launch command and the reason and
approves it** before the Steward starts. While the Steward works, the Waykeeper **watches live**
how it uses the extra access and **pauses it on the first off-script action**. Cosmin then
approves that action and lets it continue, or stops the Steward.

## 2. Goals

1. The Waykeeper can ask to start a Steward with extra launch flags, giving a reason and what
   it will check.
2. Cosmin approves each such launch on its own card before the Steward starts (option A from the
   brainstorm: one card per Steward, not folded into the plan card).
3. While the Steward runs, the Waykeeper checks every use of the extra access against the
   approved reason. The first use that falls outside it pauses the Steward and asks Cosmin.
4. When the Steward finishes, the Waykeeper checks that the extra access did the job it was
   approved for (e.g. the screenshots are on the PR) and reports to Cosmin.
5. Everything is logged as events: the request, the decision, every off-script pause and its
   outcome, and the final check.

## 3. Non-goals

- Free-form flags. Only flags in a server-side catalogue can be requested (see §5.1).
- Flags for the Harmonizer or the Waykeepers. Brains keep their fixed launch.
- "Always allow `--chrome` on this project". Each approval covers one Steward. This could be
  added later in the style of decision 138, but not now.
- Flags for runtimes other than Claude. The catalogue is per runtime, but only Claude
  (`claude-sdk`) entries ship now.
- Dollar or usage budgeting for flagged Stewards.

## 4. Anti-goals (a failure even if it works)

- **An agent widens its own access.** No LLM ever grants a flag, approves an action that is not
  consistent with something Cosmin approved for that same Steward, or edits the catalogue. The
  Waykeeper can only let through what Cosmin's approvals already cover; anything else goes to him.
  This is a deliberate, narrow exception to SPEC §2.6 ("permission questions are never answered
  by an LLM"). Cosmin's words: "If the request is consistent with an approval I gave previously
  to the same steward, then the waykeeper would approve the new action. If not, ask me."
- **The flag bypasses the rest of the permission policy.** Only the calls that use the flag's
  tools skip the policy table (Cosmin: the OK is "just the opening command"). Everything else a
  flagged Steward does (shell commands, file writes, `git push`, other network tools) goes
  through the per-project policy table and its rules (decision 138) exactly as for any Steward.
- **Flags that remove safety.** `--dangerously-skip-permissions`, `--permission-mode`,
  `--allowedTools`, `--mcp-config` and similar are never catalogue entries.
- **The Steward keeps running while the Waykeeper is still making up its mind.** "Pause"
  means the off-script action does not happen until Cosmin answers.

## 5. How it works

### 5.1 The flag catalogue

A fixed server-side catalogue (code, not settings, for now) lists the flags that may be
requested, per runtime. Each entry has:

- the flag as Cosmin sees it (`--chrome`) and how the adapter applies it (for the Agent SDK:
  `extraArgs: { chrome: null }`, like the existing `bare` opt-in which becomes
  `extraArgs: { bare: null }`)
- a one-line description of what it adds, shown on the card ("controls your Chrome browser")
- **which tool calls count as using it**, so the watch knows what to check. For `--chrome`:
  the Claude in Chrome tools (`mcp__claude-in-chrome__*`; the builder confirms the exact
  names against the installed CLI).

The first entry is `--chrome` on `claude-sdk`. A flag the catalogue does not have, or one
requested for a Steward on another runtime, is refused when it is requested, with a message the
Waykeeper can act on.

### 5.2 Requesting a flagged Steward

The Waykeeper's `spawn_steward` tool (`apps/server/src/brains/waykeeper/tools.ts`) gets an
optional `launchFlags` block:

- `flags`: catalogue names, e.g. `["chrome"]`
- `reason`: why this Steward needs them, in words Cosmin can judge
- `expectedUse`: what the Steward will do with them (this is the scope the live watch enforces,
  e.g. "open the local dev server and github.com to take screenshots and attach them to PR #…")
- `check`: what the Waykeeper will verify when the Steward finishes

With no `launchFlags`, `spawn_steward` behaves exactly as it does today. With them, the call does
not spawn: it records the request and returns at once (non-blocking, like other user-facing brain
tools). The task waits on Cosmin's answer. The Waykeeper's prompt explains when to ask for a flag
and that it must not ask "just in case".

The Waykeeper may need a flag only partway through a task, e.g. once the fix is done and
screenshots are due. My call: it then asks for a **new** flagged Steward for that task (or a
follow-up task); a running Steward's flags are never changed. Whether that should be a fresh
Steward on the same task or a separate small task is left to the builder, as long as the
one-Steward-per-task rule holds.

### 5.3 The approval card (option A)

A separate card in the Inbox, shown before the Steward starts, and a notification. It shows:

- the project, the task and the Waykeeper that asks
- **Why:** the Waykeeper's `reason`
- **Command:** the exact launch, e.g. `claude --chrome`, and the working directory (the task's
  worktree)
- **New compared to a normal Steward:** each flag with its catalogue description
- **Waykeeper will watch for / check:** `expectedUse` and `check`
- buttons: **Approve and start**, **Start without flags**, **Deny**

Answers:

- *Approve and start* starts the Steward with the flags.
- *Start without flags* starts a normal Steward and tells the Waykeeper the flags were refused.
- *Deny* starts nothing. The Waykeeper is told and decides what to do next: re-plan, ask
  differently, or report back.

It is a **permission**-kind decision: only Cosmin answers it (no rule, no LLM). Remote
approval follows the same `autoApproveRemote` rule as other permission cards (decisions 37, 90).
My call: the menu bar (decision 136) does not offer it, because the card has to show the command
and the reason.

### 5.4 The live watch

Every tool call that the catalogue says uses a flag (§5.1) goes through a **scope check** before
it runs, **instead of** the project's permission policy. Cosmin's approval of the launch card is
the only OK those tools need: no per-call permission cards. Calls that do not use a flag go
through the policy table as today.

1. The Waykeeper judges the call against **the Steward's approvals**: the launch card's
   `expectedUse`, plus every off-script action Cosmin has since approved for this same Steward.
   The verdict is **consistent** (the call runs) or **off-script** (the call is held).
2. Off-script: the call is held and the Steward **waits**. Cosmin gets a notification and a
   card showing what the Steward tried to do (tool and input, e.g. "navigate to
   https://news.ycombinator.com"), the Steward's approvals so far beside it, and the Waykeeper's
   one-line reason for flagging it. Buttons:
   - **Approve this action and continue**: the held call runs, the Steward goes on, and the
     approved action is added to the Steward's approvals.
   - **Stop the Steward**: the call is refused, the Steward is stopped, and the task follows the
     usual stopped-Steward path.
3. The watch keeps running for the Steward's whole life. Every later off-script call pauses
   again. An approved action widens the scope only as a precedent: the Waykeeper may let
   through later calls that are *consistent with* it (the same kind of action on the same
   target), never anything broader.

"Waits" means the held state a permission card already causes: the call blocks in the adapter,
and the Steward shows as waiting on Cosmin. My call: there is no `SIGSTOP` pause, because the
adapter's pause freezes the CLI process while its timers keep running.

Technical note for the builder: `PermissionGate.check` (`packages/protocol/src/adapter.ts`) is
synchronous and runs from the `PreToolUse` hook. The asynchronous scope check therefore belongs
in the `canUseTool` path, which is already async and can block: the gate returns `ask` for a
flag's tools, and `canUseTool` runs the scope check. The other option, an async gate, touches
every adapter.

How the Waykeeper judges in step 2 is left to the builder, under these constraints:

- The held call waits for the verdict; it never runs first and gets checked later.
- The verdict comes fast. The Waykeeper's mailbox runs one turn at a time, so a
  dedicated short check (a small, cheap model call with the approved scope and the call) is
  probably better than queuing a full Waykeeper turn. Deterministic pre-checks are fine where
  they are obvious, e.g. an allow-list of hosts derived from `expectedUse` that lets clearly
  in-scope navigation through without asking a model.
- If the check fails or times out, the call is treated as **off-script** (fail closed).
- Every verdict is logged; in-scope verdicts are not shown as cards.

### 5.5 The final check

When the Steward reports done, the Waykeeper (in its normal turn) verifies the `check`, e.g.
that the PR has the screenshots, and tells Cosmin the result through the Harmonizer like other
reports. A failed check does not block the merge by itself: the Waykeeper treats it like any
other task that did not meet its done criteria.

### 5.5a Publishing through the extra access (relation to decision 147)

Decision 147 says nothing goes out in Cosmin's name without his approval of the exact content.
For a flagged Steward, the Waykeeper takes that role inside the Steward's approvals. Cosmin's
example: when the Steward updates **one of his own PRs** (the PR of its task, or one the launch
card names), uploading the screenshots is consistent with the approval and the Waykeeper lets it
through. Posting a comment on **someone else's PR**, or anything outside what Cosmin approved, is
off-script and comes to him as in §5.4. This is recorded in SPEC as an exception to decision 147
for flagged Stewards. Publishing by other means, such as `request_publish` or a `git push`, is
unchanged.

My call: the exception covers only actions that use the flag's tools. Cosmin said "this applies to
other actions as well". I read that as "everything a flagged Steward does with its extra access",
not as a change to how every Steward's permission questions are answered. Widening it to all
Stewards would be a separate decision.

### 5.6 Restarts

The flags are stored on the Steward's agent row (in `meta` until the schema needs them, per the
repo rule). A Steward resumed after a restart (decision 44) is resumed with the same flags and the
same approved scope, without asking again. A held off-script call that a restart cancels is
handled like other questions a restart cancels: the Steward is told and asks again.

### 5.7 What Cosmin sees elsewhere

- The Steward's card in the panel shows a small flag badge (`--chrome`), and its reason on hover
  or in the detail view.
- The satellite needs no new look for now.

## 6. Constraints

- Nothing outside `apps/server/src/adapters` knows how a flag is passed to a runtime. The protocol
  (`SpawnOptions`) carries catalogue names; the adapter maps them.
- New types go in `packages/protocol`; schema changes come with a migration.
- One event per mutation, same transaction (the event log rule).
- Tests use the fake SDK and the scripted fake LLM; the real `--chrome` run is a local-only,
  tagged test.
- Docs: a new SPEC §7 decision (152; 151 was taken by P8-25) for the product behaviour, a TECHNOLOGY section for the
  catalogue, gate and scope check, and a task set in a phase file (the builder picks which phase
  or opens a new one).

## 7. Left to the builder

- How the scope check is implemented (deterministic pre-checks, a model call, or both), within
  §5.4.
- The exact event names and payloads.
- Card layout details beyond what §5.3 lists.
- A first spike to confirm that Claude in Chrome works in an Agent SDK session started with
  `extraArgs: { chrome: null }` (the installed CLI has `--chrome` and `--no-chrome`). If it does
  not, the design stops there and comes back to Cosmin.
- Whether a flag needed mid-task restarts the task's Steward or opens a follow-up task (§5.2).
- What happens when two flagged Stewards want the same Chrome at once. Since there's only one
  browser, the conservative default is to allow one `--chrome` Steward at a time and queue the
  others. The builder confirms how Claude in Chrome behaves with two sessions.

## 8. My calls (not discussed with Cosmin)

- The flags come from a fixed catalogue. Free-form flags are not allowed.
- Each approval covers one Steward. There is no "always allow" for now.
- A running Steward's flags never change; a later need means a new Steward.
- The approval is a permission-kind card: no rules, not offered in the menu bar.
- The scope check fails closed.
- "Pause" means a held call, as with a permission card, not the adapter's `SIGSTOP` pause.
- Approved off-script actions are precedents for consistent later calls (this reconciles
  "every off-script action pauses again" with "consistent with a previous approval →
  the Waykeeper approves").
- The publishing exception (§5.5a) covers only the flag's tools on flagged Stewards.
- A restarted Steward keeps its approved flags without asking again.
- A failed final check is reported, not a hard block.
