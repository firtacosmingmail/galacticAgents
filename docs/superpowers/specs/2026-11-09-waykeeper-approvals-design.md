# Waykeeper approvals — design

**Date:** 2026-11-09 · **Branch:** `agent-waykeeper-approvals` (from `agent-launch-flags`, PR #10) ·
**Status:** draft for Cosmin's review

## 1. Intent

Stewards doing real work raise a stream of permission cards that Cosmin approves by hand although
they plainly belong to the task. His example: a Steward doing a review asked again and again to run
`gh` commands, and to read outside its workspace. The project's Waykeeper knows the task and could
tell these belong to it.

Cosmin's words: "I want to be able to give the waykeepers the possibility to approve any access
requests. In this case I want the setting to be per waykeeper, and I want the waykeeper to decide if
the right/access that the steward requests is in the need of the task or not. If it is, then I want
it to approve it by themselves. If not, forward it to me." And: "If the command is needed for the
task and it does not run something harmful, it should be approved by the waykeeper."

What "harmful" means, in his words, is **out of line with what the Steward is doing**, not
dangerous in general:

- "a gh to write, when the purpose is to read";
- "a read in Desktop, when the steward needs to run in the folder with the code";
- "a request on an api when the steward does not need access there";
- "an action that is not consistent with the rest of the actions the steward made";
- "deleting files that the steward should not delete, or outside of its workspace".

On repeated approvals: "after 3 similar approvals, add a new button saying that this was previously
approved 3 times, do you want me to auto approve future actions?" The standing approval this button
creates covers **all Stewards in the project** (Cosmin, 2026-11-09). And: "the actions need to be
scanned well, because most of them are very complicated and long."

## 2. Goals

1. A per-project switch, **Waykeeper approves Stewards' requests**, off by default, turned on and
   off by Cosmin only.
2. With the switch on, a Steward's permission request that the table answers **ask** is first
   judged on Cosmin's behalf against the task, the Steward's own actions so far and the project's
   standing approvals. A request that fits is approved without a card; one that does not becomes
   the usual permission card, with the reason it was forwarded.
3. Every part of a command is judged, not just its first word.
4. After Cosmin approved **3 similar forwarded requests** in the project, the next similar card
   offers a button that turns the kind into a **standing approval** for every Steward of the
   project.
5. Cosmin sees every Waykeeper approval with its reason, and the project's standing approvals, and
   can remove any of them or turn the switch off.

## 3. Non-goals

- Overriding the table: what it allows runs as today, what it **denies** stays denied. Only `ask`
  verdicts are judged.
- The Waykeeper's own requests, the Harmonizer's, and asteroid Stewards' (they have no Waykeeper):
  they keep going to Cosmin.
- Other question kinds: clarifications keep their current flow; **spend** (decision 145),
  **publish** (decision 147), **launch** and **off-script** cards (decision 152) stay Cosmin's
  alone. Calls to a launch flag's tools stay with the launch-flag scope watch.
- Replacing "Allow similar" rules (decision 138): they stay, matched before the judge (a rule-allowed
  call never reaches it).

## 4. Anti-goals (a failure even if it works)

- A request approved because the judge failed, timed out, or answered something unreadable. Every
  failure forwards the request to Cosmin.
- A long command approved on its first part while a later part (`… && rm -rf …`, `| sh`, a `$(…)`)
  does something the task does not need.
- A Steward talking the judge into approving: text from the request, the task or earlier actions is
  data to the judge, never instructions.
- Approvals Cosmin cannot see afterwards, or a switch an agent (or a remote client) can turn on.
- A Steward visibly slower than with the switch off for requests the judge approves (the judge must
  be quick; see §5.3).

## 5. How it works

### 5.1 The switch

- A project setting `waykeeperApprovals: boolean`, default `false`, shown on the project's edit
  form and on its Waykeeper's card, next to the trust level. Cosmin's only, like the trust level
  (decision 49): a brain cannot set it, a proposal cannot preset it, and a write from a remote or
  unknown-origin client is refused unless `autoApproveRemote` (decisions 37, 51, 90). Turning it off
  is allowed from anywhere.
- It applies to the next request of the project's Stewards; an open card is not re-judged (as
  decision 31 does for a table change).
- A sub-project has its own Waykeeper and its own switch.

### 5.2 Where the judge sits

The permission gate stays pure and LLM-free (decision 7's gate). The judging happens in the runtime,
on the path that today turns an `ask` verdict into a permission question (decision 31):

1. Gate verdict `ask` for a Steward's call (after rules and `allowOnce` had their chance).
2. If the Steward's project has the switch on and the call is in scope (§3), the runtime holds the
   call and asks the **request judge** (§5.3). No question exists yet.
3. Verdict **approve**: the call runs; logged as `permission.decided{allow}` with
   `decidedBy` = the Steward's Waykeeper, the judge's reason, and (if one was used) the standing
   approval it relied on.
4. Verdict **forward**, an error, a timeout (20 s, as `SCOPE_JUDGE_TIMEOUT_MS`), a malformed answer,
   or the agent stopping meanwhile: the permission question opens as today, held by Cosmin, with a
   `context.waykeeper` block: the reason it was forwarded and the failing part of the command, if
   any. A withdrawn call (interrupt, stop) is dropped, as the scope watch does.

This reuses the launch-flags scope watch's shape (held call, timeout, fail closed, cancel race,
redaction) — the builder should share code with `ScopeWatch` / `createSdkScopeJudge` rather than
copy it.

### 5.3 The request judge

A one-shot model call like the launch-flags scope judge (`scope-judge.ts`): no tools, no settings,
no MCP servers (`settingSources: []`, `strictMcpConfig`), one turn, a small fast model (Haiku), the
untrusted inputs fenced as data. It gets:

- the task: title, description, and the Steward's role in the plan;
- the project's workspace path and the Steward's working folder;
- the Steward's **recent approved actions** (the last 50 calls the gate or the judge allowed for it,
  redacted, one line each — enough to judge "consistent with the rest");
- the project's **standing approvals** (§5.5);
- the request: tool, input redacted, the gate's categories, and for a shell command its **parts**
  (§5.4).

It answers `approve` or `forward`, a one-sentence reason, for `forward` the failing part, and the
**kind** of the request (a short normalised description such as "read-only `gh` query on this
repo's PRs") used for §5.5. The judge is told Cosmin's tests from §1 explicitly: read vs write
against the task's purpose, place (the workspace and the task's folders vs elsewhere), destination
(hosts and APIs the task needs), consistency with the Steward's actions, deletion. What it may never
approve is decided before it is called (§5.4a).

### 5.4 Splitting a command into parts

Cosmin: "the actions need to be scanned well, because most of them are very complicated and long."

The permission engine today reads `$(…)` and backticks as their own commands but treats `sh -c` /
`bash -c` bodies, heredocs fed to an interpreter, and `xargs` targets as **opaque** (`OPAQUE_RULES`,
`hiddenProgram` in `domain/permissions.ts`). *My call:* a new **splitter for the judge only**, built on
the engine's lexer, goes further: it splits a command into its parts — each command of a chain
(`&&`, `||`, `;`, pipes), each `$(…)` and backtick, the bodies of `sh -c` / `bash -c` (recursively),
heredoc bodies fed to a shell, and `xargs` targets — and classifies each part with the engine. The
gate's own verdicts and decision 49 are **unchanged**: the splitter only decides what the judge sees.

What the splitter still cannot see into is **opaque**: inline code for another interpreter
(`python -c`, `node -e`, a heredoc fed to `python`), and a script file the command runs. *My call:*
- inline code is given to the judge as text, fenced as data, and judged like any other part (it may
  approve plainly harmless code that fits the task, e.g. a `python -c` that parses JSON output);
- a script file the command runs is approved only if the task or the Steward's own earlier actions
  show what it is (the Steward wrote it in its worktree, or it is a script of the repository the task
  names); otherwise forwarded;
- a standing approval (§5.5) never covers an opaque part by itself: the part must pass on its own.

The judge approves a request only if **every part** passes. The forwarded card shows the parts, the
failing one marked.

### 5.4a What the judge may never approve

*My call*, matching decision 138's exclusions and Cosmin's "harmful" list. Decided in the runtime
before the judge is called (no model involved), so these always reach Cosmin:
- a **push** (the engine's `push` category, decision 49: `git push`, `gh pr create`, `gh pr comment`,
  `gh api -X POST`, …) or a screenshot or image upload — **unless Cosmin specifically asked for it in
  his own words** (§6). Only Cosmin's own text counts: the message he sent that led to the project or
  task, and his answers to its questions. A plan, task description or brief written by an agent does
  not. The server hands the judge Cosmin's words separately from everything else; the judge may approve
  a push only when it can quote the sentence that asks for it, and the quote is checked to appear in
  Cosmin's text. The quote is shown with the approval. A standing approval never covers a push;
- a **guarded** write (`Classification.guarded`: `.claude/`, `.git/`, `.husky/`, `.mcp.json`,
  `~/.gitconfig`, `~/.ssh`, shell start-up files, LaunchAgents/LaunchDaemons, another user's home,
  the project's `deliverables/` folder);
- a **delete outside the Steward's worktree**.

### 5.5 Similar approvals and standing approvals

- Each forwarded request carries the judge's **kind**. When Cosmin answers Allow once on a forwarded
  card, the server records `{kind, the request's one-line summary, the Steward, when}` for the
  project.
- When the judge forwards a request whose kind matches **3 or more** of Cosmin's recorded approvals
  in the project (the judge decides the match, given the recorded kinds and summaries; it lists the
  ones it matched), the card gets an extra button: **"Approved 3 times before — let the Waykeeper
  approve these"** with the matched examples shown.
- Pressing it approves this request and adds a **standing approval** to the project: the kind, the
  examples it came from, who added it and when. From then on the judge receives the project's
  standing approvals and may approve a request that matches one **and passes every other test** —
  a standing approval never covers a part that writes when the approval was for reads, a new
  destination, a deletion, or a push.
- Standing approvals belong to the project, apply to all its Stewards, and end when the project
  closes (as decision 138's rules do). Cosmin sees them on the project (next to its "Allow similar"
  rules) and can remove any; removal applies to the next request.

### 5.6 What Cosmin sees

- **Steward activity:** each Waykeeper approval appears in the Steward's transcript and activity as
  "Approved by <Waykeeper>: <reason>".
- **Forwarded cards:** the usual permission card, plus "The Waykeeper sent this to you: <reason>"
  and the command's parts with the failing one marked; plus the §5.5 button when it applies.
- **The project:** the switch, the standing approvals (removable), and a count of Waykeeper
  approvals with a link to the list.
- **The phone shows the same cards as the Mac** (Cosmin, 2026-11-09: "I want the same cards on phone
  as well"): the Waykeeper's reason, the command's parts, and the standing-approval button. Pressing
  it from the phone adds the standing approval like on the Mac. This is an explicit exception to the
  rule that a remote client cannot set up auto-approvals (decisions 31, 37, 90), limited to this
  button; the new SPEC decision records it. Turning the switch itself on stays Mac-only (§5.1).
- The menu bar shows forwarded cards as permission cards (Allow once / Deny), without the
  standing-approval button (decision 136: never "always" from the menu bar).

### 5.7 Events and storage

- Every decision is an event in the log, in the same transaction as its domain change: the
  approval (`permission.decided` with the Waykeeper as decider and the reason), the forward
  (the question's `context.waykeeper`), the recorded user approval of a forwarded kind, a standing
  approval added or removed, the switch turned on or off.
- Storage follows the existing pattern for project rules (decision 138): a table or the project's
  `meta`, with a migration for any schema change. The builder chooses.

### 5.8 Product decision

A new SPEC decision amends decisions 7 and 31: on a project where Cosmin turned the switch on, a
Steward's `ask` may be approved by a model judging on the Waykeeper's behalf, logged, and fails
closed to Cosmin. The table's `allow`/`deny`, push, money, publishing and launch flags are
unchanged. It also lets the phone add a standing approval from a forwarded card (§5.6).

## 6. Pushes (Cosmin, 2026-11-09)

"Pushes and screenshots should be coming to me, unless they are specifically asked by me in the
prompt." So pushes and uploads are forwarded by default; the judge may approve one only when
Cosmin's own words ask for it (§5.4a). A Chrome Steward's screenshot uploads keep going through the
launch-flag flow (decision 152), whose launch card Cosmin approves himself.

## 7. Left to the builder

- The model (Haiku-class by default), prompt wording, and the JSON shape of the verdict.
- Storage of the switch, the recorded approvals and the standing approvals (§5.7).
- How many recent actions the judge sees (≈50 is a guess) and how they are summarised.
- UI placement and wording within the panel's existing patterns.
- Whether the judge is attributed to the Waykeeper as a separate one-shot call (recommended, like
  the launch-flags judge) or runs a Waykeeper turn (slower; not wanted, §4).
