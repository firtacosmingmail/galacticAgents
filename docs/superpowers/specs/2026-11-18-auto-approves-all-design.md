# Auto approves everything; sends and spends need a grant — design

Date: 2026-11-18. Changes `2026-11-14-waykeeper-auto-mode-design.md` (SPEC decisions 154, 158,
161). Branch: `agent-auto-grants` from `main` (after PR #18).

## 1. Intent

Cosmin, 2026-11-18: "we are going to update the auto mode. It will approve anything. all the
approved commands will be logged and I will say if anything needs to be requested from me. I
understand the security risks and I will accept them."

And on what still asks: "I would want the waykeeper to ask me if I want to let it post social
media or send emails to customers or do actions that cost money like post adds that cost money,
for example. Depending on what I say it should act. I might want it to post only for this day,
or only for this campaign, or only for these adds. I would say that in the prompt, responding on
a question from the waykeeper."

Why: Auto today still sends many cards (the hard rules, pushes, the judge's own forwards, and
every request of an asteroid Steward or a publishing run, which skip the Waykeeper entirely).
Cosmin wants Auto to work like Claude Code's auto mode, but looser: run everything, log
everything, and let him tighten afterwards with marks. The one thing he wants to decide up front
is anything that goes out to people in his name or costs money, and he wants to decide it once
per scope ("today", "this campaign", "these ads"), in his own words, not per call.

## 2. Goals

- In **Auto**, every request a Steward's gate asks about is approved and logged, except:
  1. a request one of the project's **"Always asks me" marks** covers (as today, a card);
  2. a request that **sends or spends** and that no live **grant** covers (§4.3).
- A **deny** in the policy table stays a deny (the gate decides it before Auto is reached; no
  change).
- **No bypass paths:** asteroid Stewards and publishing runs get Auto too (§4.5, §4.6).
- **Grants:** when a send or spend has no grant, the Waykeeper (the Harmonizer for an asteroid)
  asks Cosmin in its chat; his answer, in his own words, becomes a grant with the scope he gave;
  later sends and spends inside it go through without asking.
- Every approval in the approvals log, as today; a send or a spend also names the grant it used.

## 3. Non-goals and anti-goals

- **"Only what fits the task" does not change**: its judge, hard rules (§5.4a of the approvals
  design), quotes and push rules stay exactly as they are.
- The gate does not change: policy table, "Allow similar" rules, the symlink refusal (decision
  158), launch flags and their scope watch (decision 152).
- The Waykeeper's and the Harmonizer's own requests: out of scope. Brains run only the app's own
  tools (`allowedTools` = `mcp__galactic__*`) and never raise a permission request.
- No dollar budgets enforced in code (Phase 8). A money limit can be part of a grant's words
  ("up to €50 a day"); the judge reads it (§4.3), code does not count spend.
- Anti-goal: a grant the model made up. A grant is created only from Cosmin's own words, which
  the server finds verbatim in his reply (§4.4).
- Anti-goal: Auto asking more often than today for anything that is not a send or a spend.

## 4. How it works

### 4.1 Approaches (chosen in conversation)

- **What Auto approves.** Considered: keep the judge and hard rules and only loosen the list
  (today's Auto); approve everything except sends/spends, decided per call (a card each time);
  approve everything except sends/spends, decided per **scope** in Cosmin's words. Cosmin chose
  the last.
- **Who decides whether a send/spend is inside a grant.** (A) a model reads the grant's words
  and the call; (B) the Waykeeper turns the answer into fixed fields (platform, account, until,
  ad list, cap) compared by code. Cosmin chose **A**: grants are free text ("only posts about the
  sale"), and B would often fail to tell from a command which campaign or ad it is. The limits
  that matter most — the end time and removal — are enforced in code (§4.4).
- **The publish card** (decision 147): in Auto a grant replaces the per-post content card
  (my proposal, not objected to). Outside Auto it stays.

### 4.2 A request in Auto

Runs where `watchApproval` runs today (the gate said `ask`), for any Steward on a project in Auto
or an asteroid Steward with standalone Auto on (§4.5), publishing run or not.

1. **Marks** (unchanged): a request a mark covers → a card, as today.
2. **Could it send or spend?** *My call:* a request whose engine categories are only local —
   reads, writes, edits and deletes of files (anywhere), `cd`, and other categories that cannot
   reach the network — is approved at once, with no model call. Everything else (network,
   push, running a workspace command or script, an MCP tool, an unclassified call, a command
   the splitter cannot read) goes to step 3. *Builder's choice of the exact category list*;
   when in doubt a category goes to step 3, never the other way.
3. **The send/spend check** (a model call, the existing request judge in a new `auto-grants`
   mode). Input: the call (redacted, split into parts as today), the task, and the live grants
   (id, Cosmin's words, the Waykeeper's one-line summary, end time). Output (strict JSON):
   `{ sendsOrSpends: bool, grantId?: string, quote?: string, kind: string, reason: string,
   summary?: string }`.
   - `sendsOrSpends: false` → approved and logged.
   - `true` with a `grantId` of a grant that is live **when the verdict arrives** (re-read: not
     removed, not ended) → approved and logged with the grant.
   - `true` and the call is asked for in **Cosmin's own words** in the task or his answers
     (Cosmin, 2026-11-18: "yes, task words count") → approved for this call only, with a verbatim
     `quote` the server checks (`quoteFound`, as today); no grant is created; logged as "allowed
     by your words in the task". The judge input therefore also carries `userWords`, as today.
   - `true` with no grant and no quote, or a grant that is no longer live → the call stays held
     and the grant question opens (§4.4).
   - What counts as a send or a spend is today's judge text (decision 161's prompt): delivering
     content to people or an outside service on Cosmin's behalf by any means (messages,
     emails, posts, comments, form submissions), and spending (ads, purchases, paid API calls,
     paid cloud resources). A git push to a branch, opening or commenting on a PR is **not** a
     send (decision 162); a push is approved in Auto, to any branch.
   - When the model is unsure whether something sends or spends, it says `true`.
   - **A failure** (no judge configured, error, timeout, malformed answer) → *my call:* the
     call is treated as a send/spend with no grant (§4.4), so the Waykeeper asks. Rare, and it
     never lets an unknown send through.
4. **Changes while it was judged:** Auto turned off, or a mark added → as today (a card).

What Auto no longer forwards (Cosmin accepts the risk): pushes to `main`, deletes outside the
worktree, writes to agent or git configuration and the deliverables folder, code it cannot read,
deletes whose target a substitution decides, and inline code or scripts that mention a push.
They are approved and logged like anything else; a mark can bring any of them back.

### 4.3 Grants

A grant is Cosmin's permission for a kind of send or spend, in his words, with a scope.

- **Stored** per project (an asteroid's grants: on the standalone-tasks settings, §4.5).
  Fields: `id`, `words` (Cosmin's verbatim answer, redacted), `summary` (the Waykeeper's one
  line, e.g. "Instagram posts as @myshop, today"), `createdAt`, `endsAt?`, `removedAt?`,
  `questionId` (the question it answered). Event-sourced like the other project settings, with
  a migration; *builder's choice of the exact shape and event names*.
- **Live** means not removed and, when `endsAt` is set, `now < endsAt`. Decided by code, never
  by the model.
- **End time.** The Waykeeper sets `endsAt` when Cosmin's words give one: "today" → local
  midnight; "this week" → end of Sunday; "until the 30th" → end of that day. A scope with no time
  in it ("this campaign", "these ads") has no `endsAt`; the model judges it from the words.
  *My call:* the Waykeeper may only shorten or keep, never invent a time Cosmin did not say;
  the server rejects an `endsAt` in the past and one more than 90 days ahead.
- **Shown** in the project's permission section next to the marks: summary, Cosmin's words,
  "ends <time>" or "no end", how many sends/spends used it, and **Remove**. Removing is
  Cosmin's only (Mac or phone); a brain cannot remove or edit a grant.
- A grant also ends when its project is closed or failed.
- *My call:* grants survive turning Auto off or to "Only what fits the task" and back on; they
  are only used in Auto. The panel shows them as "paused" while Auto is off.

### 4.4 The grant question

When a send or spend has no live grant:

1. The Steward's call stays **held** (as a forwarded card is today; the Steward waits).
2. The server tells the Waykeeper (a mailbox event, like a forwarded request): which Steward,
   the call (redacted), the judge's `summary` of what it sends or spends, and the grants that
   exist but did not cover it.
3. The Waykeeper asks Cosmin in its chat with a new tool, `ask_send_permission`
   `{ heldRequestId, text }` — e.g. "The Steward wants to post this to Instagram as @myshop:
   '<text>'. Allow it? You can say for how long or for what (only today, this campaign, these
   ads)." The question is a clarification question held by Cosmin, linked to the held call, and
   the panel shows the held call (tool, command or content) under the Waykeeper's text, with a
   reply box. *My call:* the card also offers **Allow once** and **Don't allow** buttons, so a
   one-off needs no typing; neither creates a grant.
4. Cosmin replies. The Waykeeper reads the answer and calls `answer_send_permission`
   `{ heldRequestId, decision: 'allow' | 'deny', grant?: { words, summary, endsAt? } }`:
   - `allow` with a `grant` → the server checks that `grant.words` is a verbatim span of
     Cosmin's reply to that question (the same check as today's quotes, `quoteFound`); if not,
     the call is refused and the Waykeeper is told why. On success the grant is created and the
     held call is approved, logged with the new grant.
   - `allow` without a grant → approved once ("yes, just this one").
   - *My call (builder check):* the server accepts `allow` (with or without a grant) only after
     Cosmin replied to that question; the model can never allow on its own. `deny` and asking
     again are always accepted. The card's **Allow once** / **Don't allow** buttons answer the
     held call directly, without the Waykeeper.
   - *My call:* "Cosmin's reply" is the text he types in the question's reply box, or a chat
     message to that Waykeeper (Harmonizer) while the question is open; the verbatim check runs
     against that text. A reply to a grouped question covers every held call in it.
   - *My call:* replies from the phone count like replies from the Mac (answering a question
     from the phone is allowed today); a grant made from the phone is shown as such.
   - `deny` → the held call is denied; the Steward is told "Cosmin did not allow this" with his
     words, and goes on without it.
   - A reply that is unclear → the Waykeeper asks again (`ask_send_permission`, same held call).
5. Several held sends/spends of the same project while one question is open: the Waykeeper may
   group them in one question (*builder's choice*); after a grant is created, the server
   re-checks the other held calls against it (step 3 of §4.2) before the Waykeeper asks again.
6. The Steward ends or is stopped → the held call and its question are withdrawn, as a card is
   today.
7. *My call:* a held call waits like a card does today (no timeout of its own; the Steward's caps
   behave as they do while a card is open).
8. *My call:* no Waykeeper on the project (or no Harmonizer running) → a plain card for the held
   call with **Allow once** / **Don't allow**; no grant can be made from it.

Decision 7 holds: the model never grants anything on its own; it only carries Cosmin's words,
which the server checks.

### 4.5 Asteroids

- A new setting under Settings: **Auto for standalone tasks** (off by default). Same rules as the
  project switch (decision 160): Cosmin's only; turning it on from the Mac, or from the phone
  only where `autoApproveRemote` allows; turning it off from anywhere.
- When on, an asteroid Steward's `ask` follows §4.2. The **Harmonizer** plays the Waykeeper's
  part: it receives the grant question event and has `ask_send_permission` /
  `answer_send_permission`. Approvals are logged in the Harmonizer's name; grants for
  standalone tasks are stored once, globally, and shown under the same Settings section, with
  an approvals log for standalone tasks next to them (same layout as the project's).
- "Only what fits the task" is not offered for asteroids (out of scope); off means today's cards.
- *My call (builder check):* standalone tasks get "Always asks me" marks too, stored globally
  next to their grants, with "Ask me next time" on their log; folder marks expand per worktree
  as on projects.

### 4.6 Publishing runs

- In Auto, a publishing run (`task.publishes`, a job's publish follow-up) is no longer skipped
  by the approval watch. Its gate still uses `publishingPolicy` (network and workspace commands
  ask), and those asks now go to §4.2: most of them are network calls the send/spend check reads.
- `request_publish` in Auto: the publish is a send. If a live grant covers it (the check of
  §4.2 step 3, given the platform, account, text and files), it is approved without the content
  card and the one-shot allowance is armed as if Cosmin had approved the card; the log keeps the
  text and the files' names and hashes. With no grant → the grant question (§4.4), whose card
  shows the content as the publish card does today.
- Outside Auto nothing changes (decision 147).

### 4.7 The log

- Every Auto approval is logged as today (`permission.decided{allow, waykeeperApproval}`), in
  the approvals log grouped by category. Without a judge's `kind` (step 2 of §4.2), the
  category is the engine's (read, write, delete, push, network, …).
- A send or spend shows the grant it used (its summary, linked to the grant), or "allowed once
  by Cosmin".
- "Ask me next time" on log entries works as today and is how Cosmin tightens Auto.

## 5. Constraints

- Adapter boundary, protocol package and migrations as in `/CLAUDE.md`.
- Every held call is answered exactly once: approve, deny, or withdrawn.
- The end time, removal, project end and the verbatim-words check are code, never the model.
- Redaction as today on everything logged, shown or sent to the model.
- Existing projects in Auto keep Auto; their new behaviour starts at the next request. Open
  cards are not re-judged.

## 6. Docs to update

SPEC: a new decision (164, "Auto approves everything; sends and spends need a grant"),
amending 154, 158, 161 and 147 for Auto; decision 7 is unchanged. TECHNOLOGY: the approval
watch, the grant store and the two brain tools. IMPLEMENTATION_PLAN and the Phase 13 file: new
tasks from P13-23.

## 7. Left to the builder

The exact category list of §4.2 step 2 (erring towards the check), the grant's storage shape and
event names, the new judge mode's prompt wording, grouping several held calls in one question,
and the panel layout of grants and the grant question card (following the existing permission
section and question cards).
