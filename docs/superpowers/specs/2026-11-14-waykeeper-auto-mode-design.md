# Waykeeper auto mode — design

Date: 2026-11-14. Builds on `2026-11-09-waykeeper-approvals-design.md` (SPEC decision 154, amended
by 158). Branch: `agent-waykeeper-approvals-fixes` (Cosmin: "On the same branch").

## 1. Intent

Cosmin, 2026-11-14: "an auto mode on the waykeepers … where the waykeeper would approve anything
that a steward would ask for, except pushing, sending or costly actions. For example pushing on
branches or sending messages or emails, or posting ads. I want this to be a check on the
waykeeper and I want, similarly to the other check, to log all the approved actions, by category."

Today's Waykeeper approvals judge each request against the task ("does it fit?") and, in real use,
still send Cosmin many cards he would have approved anyway. Auto mode trades that judgment for a
short, fixed list of what still reaches him: things that leave the machine to people or cost money,
and deletes outside the project. In exchange, he gets a log of everything that was approved, so
he can check after the fact and, where he finds something he would not have wanted, mark it
"Ask me next time".

Cosmin on the log: "I want to see if there were any actions that I would not have wanted
approved. If I would find any, I would want to mark those actions as approval needed even in
auto mode."

## 2. Goals

- A third setting of the project's Waykeeper approvals switch: **Auto**.
- In Auto, a Steward's `ask` request is approved unless it is on the "still comes to Cosmin" list
  (§4.2) or matches one of the project's "Always asks me" marks (§4.5).
- An **approvals log** on the project, grouped by category with counts (layout A, chosen in the
  mockups), every Waykeeper approval with its command, Steward, task and time.
- An **"Ask me next time"** button on each log entry younger than 10 days, which adds a mark.

## 3. Non-goals

- Auto mode does not change the gate: the policy table's `allow`/`deny`, the "Allow similar" rules,
  the symlink refusal (decision 158) and launch flags (decision 152) work as today. Auto mode acts
  only where the gate would ask.
- No Harmonizer or Waykeeper own-request auto-approval: Stewards' requests only, as decision 154.
- No dollar budgets (Phase 8's job); "costly" is judged per request.

## 4. How it works

### 4.1 The switch

- The project's switch becomes three settings: **Off**, **Only what fits the task** (today's
  behaviour, decision 154), **Auto**. Shown as today, in the project's permission section.
- Turning Auto on follows the existing switch's rules: Cosmin's only, Mac only (a remote client is
  refused unless `autoApproveRemote`), never set by a brain or a proposal. Turning it down (to "fits
  the task" or Off) works from anywhere. Applies to the next request; an open card is not re-judged.
- Storage: the existing `waykeeperApprovals` field changes from `true` to a mode (`'task' | 'auto'`,
  absent = off), with a migration that turns stored `true` into `'task'`. *Builder's choice of exact
  shape.*

### 4.2 What still comes to Cosmin in Auto

Decided before any model is called (deterministic):
- **Pushes and uploads**: the engine's `push` category and the existing `isPushOrUpload()`
  (`git push` to any branch, PR create/merge/comment, `npm publish`, `gh api -X POST`, …). *My call:*
  the existing exception still applies — a push Cosmin asked for in his own words, quoted verbatim
  (decision 154, P13-10), may be approved, because Auto must never be stricter than "fits the task".
- **Deletes outside the project** (Cosmin: "deletes outside of the workspace as well … in the same
  category") — and, as today, outside the Steward's worktree and scratch folder (`outsideCwd`),
  including every delete whose target cannot be placed (`rm -rf $X`, decision 158).
- **Guarded writes** (agent or git configuration, the deliverables folder): unchanged, they always
  come to Cosmin.
- **A command the engine cannot parse** (`opaque: 'unreadable'`: zsh-only syntax, decision 155;
  `eval`-like lines; anything unclassified) still comes to Cosmin, as today: it could hide a delete
  outside the project or a push. *My call (builder check).* Inline code and a script file the
  command runs (`opaque: 'inline_code' | 'script_file'`) are judged by the send/spend check (§4.3)
  like anything else — that is what "approve anything" means. A push mentioned inside them is still
  caught by the gate's raw-text detector (decision 49) and comes to Cosmin.
- **A matching "Always asks me" mark** (§4.5).

Judged by a model (the existing one-shot request judge, a different prompt):
- **Sending**: messages, emails, chat posts, comments, replies, form submissions, anything that
  delivers content to people or to an outside service on Cosmin's behalf — through `curl`, an MCP
  tool, a script, or anything else.
- **Costly**: spends money or a paid quota — posting or changing ads, purchases, paid API calls,
  starting paid cloud resources.

The judge answers only "does this send something or cost money?". Anything else is approved. It
forwards when unsure. *My call (builder check):* a send or a spend gets the same exception as a
push — the judge may approve it when Cosmin's own words ask for it, quoted verbatim and checked by
the server (decision 154's quote rule, P13-10). So the Auto judge receives Cosmin's words and the
task, returns a `quote` for a send/spend/push it approves, and the server's quote check covers
send/spend parts as well as push parts. This keeps Auto never stricter than "fits the task". A failure, timeout or malformed answer forwards, as today (fail closed).

### 4.3 The Auto judge

- Same machinery as `request-judge.ts` (one-shot, no tools, Haiku-class, inputs fenced as data,
  20 s timeout), with an Auto prompt: Cosmin's list above, examples on both sides (`gh pr view` and
  `curl GET` approve; `curl -X POST …/messages`, a Slack/Gmail MCP send, an ads API call forward),
  the command's parts as today.
- It still returns a short **kind** of the request, so a forwarded request can feed the
  standing-approval flow as today.

### 4.4 The approvals log (layout A)

- On the project, in the permission section below the switch: **"Approved by the Waykeeper"**,
  grouped by category, each group a collapsible row with its count; open a group to see its
  entries, newest first: the command (one line, redacted as today), the Steward's name and task
  short name ("Vega · Prospect list", decision 157), the time, and the Waykeeper's reason on
  hover/expand.
- **Where the category comes from** (*my call, builder check*): from now on the approval event
  carries every part's categories and opaque flag, and the log derives the category from them.
  Earlier approvals show under the single `action` their event recorded.
- **Categories**, one per entry, the request's strongest permission category, in this order:
  deletes, outside the project, network, unreadable scripts, edits, run commands, reads. *My call*
  (a request with several categories shows once, under the first that applies).
- The log shows **every Waykeeper approval**, in both modes, for the life of the project (it ends
  with the project, as standing approvals do). *My call.* The source is the event log
  (`permission.decided` with the Waykeeper as decider), as the existing approvals list in
  `StandingApprovals.tsx` already reads it.
- **"Ask me next time"** on each entry **younger than 10 days** (Cosmin). Older entries stay
  visible, without the button.
- Works on the phone like on the Mac (the panel is the same).

### 4.5 "Always asks me" marks

Pressing "Ask me next time" adds a mark to the project. A mark makes the Waykeeper forward, in
either mode, every later request that **implies** the marked one (Cosmin: "rm -rf node_modules
would imply a rm -rf node_modules/.cache because they are in the same folder. but rm -rf dist is
not implied"). The mark is built from the logged request with the same kinds the "Allow similar"
rules use (decision 138, `domain/permission-rules.ts`), turned around:
- **A delete, or another file action** (edit, outside-the-project read/write): the same
  **permission category** on that target **or anything inside it**, whatever command does it.
  `rm -rf node_modules` → catches `rm -rf node_modules/.cache`, `rm node_modules/x` and
  `git clean` inside it (all deletes there); not `rm -rf dist`, and not an edit inside
  `node_modules` (a delete does not imply an edit). *My call (builder check)*: this is what
  "implies" means.
- **A network action**: the same **site and its subdomains** (my guess, accepted): marking
  `curl https://api.posthog.com/…` catches every call to `api.posthog.com`, not `posthog.com`.
- **Any other command**: commands that **start with the same words** (my guess, accepted):
  `pnpm test` catches `pnpm test --watch`, not `pnpm build`.
- **An MCP or other non-Bash tool**: the same tool (its full name, which includes its server, e.g.
  `mcp__slack__post_message`), whatever its arguments. *My call (builder check).*
- A request with several parts is forwarded if any part matches a mark.

Marks are checked deterministically before the judge, like §4.2. They only stop the **Waykeeper**
from approving: Cosmin's own "Allow similar" rules and the table's `allow` still let a call through
first (they run in the gate, before the Waykeeper; *my call*, stated so it is not a surprise).

Marks are listed under the switch as **"Always asks me"**, each with its example command, when and
by whom it was added, and **Remove**. They belong to the project and end with it. Adding one
(stricter) and removing one work from anywhere, Mac or phone. *My call* for removal: it loosens
only back to Auto's own rules, which Cosmin already turned on. A forwarded card says which mark sent
it ("You asked to be asked: rm -rf node_modules").

**As built (P13-14–P13-16, 2026-11-14).**
- A folder mark's path inside the approving Steward's worktree or scratch folder is stored as `{worktree}/…` or `{scratch}/…` and expanded with the requesting Steward's own roots, so a mark applies to every Steward of the project; a mark made from an approval recorded without `cwd` takes the task's worktree (else the project workspace) as its cwd and worktree root, and the scratch root comes from that cwd (final review).
- A delete mark also covers deleting any folder that contains the marked one (`rm -rf .`, `git clean -fdx` from the worktree), because that deletes the marked folder. Edit and read marks cover only the path and what is inside it.
- Deriving a mark follows the approved command's own `cd`s; when one cannot be followed it falls back to a prefix mark. Only file-argument commands (`rm`, `rmdir`, `unlink`, `mv`, `cp`, `shred`, `trash`, `find` start paths, `git clean` pathspecs) read plain words as targets; other commands use the engine's paths or a prefix mark (`git branch -D feat` makes "git branch …"). A target with a variable the engine cannot place makes a prefix mark (`rm …`).
- Final review (P13-18): folder marks compare paths ignoring case; `git rm` pathspecs are targets, and a part of the mark's category with no known target has every plain argument read as one; an edit mark also covers shell edits of the file by any part (write redirects, `sed -i`, `tee`, `truncate`, `dd of=`, the `cp`/`mv`/`install` destination); site marks read hosts from the part's own words (`new URL`, userinfo, port and trailing dot dropped), so a POST or upload is covered, and derive the site the same way; prefix marks match and derive on the command's basename with git's global options skipped. The Auto judge has its own parts wording (send-or-spend test for every part).
- The mark route is user-only, from anywhere, never from an agent; only a Waykeeper approval of that project, at most 10 days old by the server's clock; the example is redacted and cut to 300 characters. The 10-day button is computed when the log is read, so an entry crossing 10 days while open keeps its button and the server refuses it.
- The send/spend quote is enforced in the approval watch (and in the SDK judge, Auto only); an Auto answer without a boolean `sendsOrSpends` forwards. Unparseable commands still forward in Auto; Cosmin's "Allow similar" rules and the table's allow still run before the Waykeeper.

### 4.6 Events and storage

As decision 154: every change is an event in the same transaction as its domain change — the mode
set, a mark added, a mark removed. Marks live on the project row like standing approvals, with a
migration. A forward caused by Auto's list or a mark carries the reason in the question's
`context.waykeeper`, as today.

## 5. Product decision

A new SPEC decision amends 154: on a project where Cosmin chose Auto, the Waykeeper approves every
Steward request the gate asks about except pushes and uploads (unless he asked in his own words),
anything that sends to people or costs money (judged by a model, failing closed), deletes outside
the Steward's worktree and scratch folder or with a target it cannot place, guarded writes, and
requests his "Always asks me" marks cover. Every approval is logged by category on the project.

## 6. Anti-goals

- Auto approving a send or a spend because the judge failed: every failure forwards.
- A mark that silently stops matching (e.g. a relative vs absolute spelling of the same folder):
  marks compare resolved paths, as the rules do.
- A log so long it is useless: grouped and counted first, entries only on opening a group.

## 7. Left to the builder

- Prompt wording and examples for the Auto judge.
- The exact storage shape of the mode and the marks; the migration.
- UI wording and placement within the permission section's existing patterns; how many entries a
  group shows before "show more".
- How a mark's kind is derived when the request has several parts (one mark per part, or the
  part that made the category).
