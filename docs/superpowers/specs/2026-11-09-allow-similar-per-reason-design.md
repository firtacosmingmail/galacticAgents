# "Allow similar" per reason — design

Date: 2026-11-09 · Asked by Cosmin while testing Waykeeper approvals · Amends SPEC decision 138 (P9-17)

## Why

The permission card's **Allow similar for <project>…** chooser offers three scopes: *exactly this*, *this command prefix / folder*, *this whole category*. In practice:

- **"Exactly this" is never useful.** Agents rarely repeat a command character for character, so an exact rule almost never matches again.
- **Outside the workspace it is the only option for a command.** `cd /tmp/pr83; …` reaches outside the workspace, so the server withholds the prefix and the category (decision 138, review B2: they would cover the whole computer). What remains is the exact rule — useless.
- **The chooser does not show what asked.** Cosmin picks a scope without seeing the command and the parts of it that triggered the question.
- **Network access cannot be generalised by site.** `curl https://…`, `gh …` and WebFetch ask as "network"; the only choices are the exact call, a command prefix, or the whole network category. Cosmin wants "allow this site", like a browser permission.

Cosmin's words: "I want to not have the allow exact option, because it is never useful. But I want to have there the command that is requesting the extra decision. The options can be generalised, for instance, if the problem is `cd …` then I want to offer access to that folder so other cd commands there do not request access any more. Similar to accessing internet pages." Then: "I want a tick for each. If not all are selected remember to always allow the ones that are ticked, and ask for the other ones later on." And: "allow it once and remember the ticked ones."

## Goals

1. The chooser shows the **full command (or tool call)** that asked, with each part that triggered the question marked.
2. **No "exactly this" option** is offered any more.
3. The chooser lists **one row per reason the call asks**, each already generalised, each with a **tick box** and a preview of exactly what it would cover.
4. **"Allow and remember"** stores one rule per ticked row and allows the call in front of Cosmin **once**, whatever is left unticked.
5. A later call passes without a card only when **every reason it asks for is covered** by some rule of the project (or by the table, or a Waykeeper standing approval). Otherwise it asks, and its card lists only the reasons still uncovered.

## Non-goals

- No change to what the table allows, asks or denies; rules still only turn an "ask" into an "allow".
- No change to Waykeeper approvals (decision 154) beyond them seeing the new rules as part of the project's rules.
- No rules that outlive the project (still "until the project closes").
- No new kind of rule for unattended jobs (decision 145 family): `unattendedRuleRefusal` keeps refusing what it refuses today; the new folder and site kinds are refused there until a separate decision says otherwise.

## Anti-goals (it fails even if it works, if…)

- A ticked folder lets a **delete, a push, or a write to guarded ground** (`.git/`, `.claude/`, shell start-up files, …) through. Each rule covers only the reason it was made for; those ask for reasons of their own.
- A site rule for `github.com` lets **`github.io`, `evilgithub.com` or `github.com.evil.net`** through.
- A folder rule ever covers **`/`, the home folder, or anything above the home folder**.
- An unreadable command (opaque, `$(…)` the engine cannot follow) is allowed by any rule.
- The command allowed once differs from the one shown (the existing stale check must still hold).

## The reasons, and what each generalises to

A call's verdict is today a set of actions (categories) plus reason lines. This design makes the **reasons structured**: each reason carries its kind and its subject, so the chooser and the matcher work per reason rather than per call.

| Reason kind | Comes from | Row offered | What the stored rule covers |
|---|---|---|---|
| **outside folder** | a path outside the workspace in a command (`cd X`, `ls X`, `cat X/f`, a redirect target), or a file tool (Read/Write/Edit/Glob/Grep/LS) on such a path | "Access to `<folder>/`", with **widen** steps one level up at a time (`/tmp/pr83/` → `/tmp/`) | any later reason of kind *outside folder* whose path (real path, symlinks followed) is under that folder. From a **command**: any command's reads and writes there (the engine cannot tell them apart; deletes ask as `destructive`). From a **file tool**: the same access kind only, as today (reading, or writing — Write/Edit, which also covers reading). Never `/`, the home folder or above it; never a guarded target. |
| **site** | a URL in a command (`https://host/…`), a `gh` command (→ `github.com`), WebFetch's `url` | "`<host>`" | any later *site* reason whose host is that host or a subdomain of it (`api.github.com` under `github.com`; label-boundary match, never a suffix match on the string). |
| **command prefix** | a command inside the workspace that asks for a category (as today's prefix) | "`npm run …`" (today's prefix, with today's refusals: no shells or interpreters, the script warning) | as today |
| **category** | any classified call | "the whole category: <words>" | as today (still never outside the workspace) |

Not offered, listed in the chooser **without a tick box** and with the reason: a push (decision 49), a write to agent/git configuration, deliverables, shell start-up files and the rest of decision 138's never-list, a part the engine cannot read, a network reason with no visible host (`npm install`, `git fetch origin`, WebSearch — these keep the prefix and category rows where they apply).

Which reasons a row resolves: a folder row resolves the *outside folder* reasons under it; a site row the *site* reasons on that host; a prefix row the category reasons of the commands it matches; a category row every reason of that category. The chooser shows, under each row, which marked parts of the command it would cover.

## The chooser

```
Allow similar for yoga-studio-flow

  cd /tmp/pr83; git log --oneline origin/dev..HEAD;
  GH_TOKEN=$(gh auth token) gh pr view 83 --json body
  ^^^^^^^^^^^^              ^^^^^^^^^^^^^  ^^^^^^^^^^^^^^  (marked parts)

  ☐ Access to /tmp/pr83/          [widen: /tmp/]
       covers: cd /tmp/pr83
  ☐ github.com
       covers: gh auth token, gh pr view 83 …

  [Allow and remember ticked]   [Allow once]   [Cancel]
```

- Nothing is ticked at first. "Allow and remember ticked" is disabled until at least one box is ticked.
- Each row's preview is the server's own words, as today.
- Phone and Mac alike, under today's rule for who may make rules (the Mac's page, or any client when `autoApproveRemote` is set).

## Answering

"Allow and remember ticked" sends the ticked rows' digests (each row keeps today's `draftDigest`, so the stale check still binds what was shown to what is stored). The server, in one transaction:

1. re-drafts the rows from the question as it stands; refuses as **stale** if any ticked row's digest differs (the chooser reopens);
2. answers the question **allow** (once);
3. stores one rule per ticked row (`permission.rule_added`, as today);
4. if the project ended meanwhile: the answer stands, the rules are not stored, and the card says "allowed once; the rules were not stored" (today's behaviour, plural).

Unticked reasons are simply not remembered.

## Matching

The gate's question changes from "is there one rule whose categories cover this call?" to **"is every reason this call asks for covered?"** For each reason of an `ask` verdict:

- covered by the **table**? (unchanged: then it is not a reason at all)
- covered by **one of the project's rules** whose kind fits the reason (folder ↔ outside folder, site ↔ site, prefix ↔ the reasons of the commands it matches, category ↔ its categories, legacy exact ↔ the whole call as today)?
- covered by a **Waykeeper standing approval**? (unchanged mechanics)

All covered → allowed without a card, logged as `permission.decided` with **every** rule id that contributed (a list; today it is one id). Any uncovered → the card asks, and its text and chooser show **only the uncovered reasons** (the covered ones are listed as "already allowed by …" in a muted line).

Never covered by any rule, as today: a push, the never-list writes, an unreadable part, anything the table denies.

## Existing rules

Stored *exact* rules keep matching until their project closes (they cover their whole call, as today). No new exact rules are drafted. *Prefix*, *folder* (file-tool) and *category* rules keep their meaning; the old file-tool folder rule becomes the *outside folder* / inside-workspace folder kind without migration.

## Constraints

- SPEC decision 138 is amended (not replaced); decisions 49, 122, 154 hold.
- The protocol package owns the new types (structured reasons, the new rule match kinds `folder` for commands and `host`, the rule-id list on `permission.decided`); the fold and replay handle the list and an old single id.
- Migration for any new column; none expected if rules stay in `Project.permissionRules` JSON.
- The permission engine stays lexical and pure; real paths only through the existing `RealPath` seam.

## Left to the builder

- Exact data shape of a structured reason (kind, subject, the span of the command it marks).
- How widen steps are presented (buttons, a select).
- How to mark parts in the command text (spans from the lexer, or matching the shown part).
- Splitting the work into tasks and which phase file holds them.

## Answers to the builder check

- **Unreadable parts.** A call with any part the engine cannot read (`unclassified`: `git -c 'credential.helper=!…'`, an inline script) **always asks**: folder, site, prefix and category rules never cover it, as decision 138 says today. The chooser still offers rows for the readable reasons (so a later readable call benefits) and lists the unreadable part without a box. `$(gh auth token)` is readable (the lexer follows it) and is not such a part. *(Claude's call: the conservative reading of decisions 49 and 138.)*
- **Where command reasons come from.** The engine already finds them per path: `classifyCommand` (permissions.ts, about line 1270) checks every path of every simple command (`pathsOf`, redirect targets included) and every `cd` target against the workspace. Structured reasons wrap those existing findings; no new path extraction. **Hosts are new**: the host of each `http(s)://` URL in a command's words, `gh` → `github.com`, WebFetch's `url`. A network reason with no visible host keeps today's prefix and category rows only.
- **Folder rules for commands** cover the `outside_workspace` reason for a path under the folder, reading and writing alike, because the engine cannot tell a command's reads from its writes; a delete there still asks as `destructive`, a push as `push`, a guarded target (`.git/`, start-up files, …) always. File-tool folder rules keep today's split (reading does not cover writing). *(Cosmin chose this, 2026-11-09: "go with A" — read and write for commands, over a list of read-only commands.)*
- **Mixed calls.** Every reason is covered separately. A call with a push or a never-list reason always asks; its other reasons still get rows. With no tickable row, the chooser offers only "Allow once". An unresolvable path (`cannot tell where it points`) gets no row.
- **Prefix and category never cover an outside-folder reason** (decision 138, review B2, kept). A prefix covers only the category reasons of the commands it matches.
- **Stale check.** The answer carries the digest of the **whole call** (tool and input) plus each ticked row's digest; any difference refuses the answer as stale and the chooser reopens.
- **Unattended jobs (decision 144).** Job rules keep every shape they accept today, the exact shape included; only the chooser stops drafting exact rules. Decisions 138 and 144 are amended in the same SPEC edit.
- **In scope:** the project's rule list (labels for the folder and site kinds, Remove as today) and the Waykeeper-approvals path (decision 154: the approval watch sees a call only after the rules, so a covered call never reaches it; an uncovered one carries only its uncovered reasons).

## Calls Claude made (for Cosmin to check)

- **Branch:** its own branch, from `agent-waykeeper-approvals` (it touches the same card and the standing-approval matcher).
- **Sites:** the host and its subdomains; `gh` counts as `github.com`.
- **File-tool folder rules split read from write** (as today); command folder rules cannot (see above).
- **Unreadable parts always ask.**
- **Whole-call digest** added to the stale check.
- **Nothing ticked at first.**
- **The rule-id list** on `permission.decided` replaces the single id (the old field still read).
- **Unattended jobs** do not get the new rule kinds for now.
