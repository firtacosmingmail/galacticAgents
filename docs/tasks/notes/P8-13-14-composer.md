# P8-13, P8-14 — Slash commands and message history in the composer

Branch `p8-13-14-composer`, from `p8-wave5-composer-mobile` (5a40d66). 2026-10-07. Cosmin's
requests (Phase 8 file). TECHNOLOGY §3.4 ("Slash commands are runtime state") and §5.2 (the brain
runner's slash-command turn) updated; `apps/server/src/adapters/README.md` (the interface table).

## What was built

### P8-13 — slash commands

- **Protocol** (`packages/protocol/src/slash.ts`): `SlashCommand {name, description?,
argumentHint?, builtin?}`, `AgentCommandsResponse {commands}`, `normalizeSlashCommands()` (no
  leading `/`; one-word names without `/` or control characters; description and hint made one
  line and cut at 300 / 100 characters; one row per name — the runtime's own row wins, as `/name`
  runs that one; at most 500), `leadingSlashCommand(text)` (`/name` as a message's first word;
  `/tmp/x` is not one). `AgentAdapter.commands?(sessionId): Promise<SlashCommand[]>`.
- **Claude SDK adapter**: `query.supportedCommands()` (SDK 0.3.285: `{name, description,
argumentHint, aliases?, builtin?}`) is read as soon as the CLI reports `system/init`, cached per
  session, and replaced by a `system/commands_changed` push (the SDK documents that push as "replace
  your cached list"). A failing call is reported (`onError`) and not cached; a slow one gives `[]`
  after `commandsTimeoutMs` (5 s; a paused, SIGSTOPped CLI cannot answer). `FakeSdk` scripts it
  (`commands`, a `commandsChanged` action) and counts the calls.
- **ACP adapter**: keeps the last `available_commands_update` (`input.hint` → `argumentHint`),
  also when it arrives during a `session/load` (state, not replayed transcript). The fake ACP agent
  announces two commands with `--commands`.
- **Fake adapter**: `commands` option (a list, or per spawn) and a scenario's own `commands`.
  The development server's fake runtime reports `DEV_FAKE_COMMANDS` (`/compact`, `/review`,
  `/docs:explain`) so the list can be tried without Claude.
- **PTY adapter**: no `commands` (a terminal agent has none we can read).
- **Runtime**: `AgentRuntime.commands(agentId)` reads the adapter for the live session (`[]`
  without one, while starting or ending, or for a runtime without commands) and remembers the
  answer on the live entry (cleared when a renewal opens a new session); `hasCommand(agentId,
name)` answers from it synchronously.
- **REST**: `GET /api/agents/:id/commands` → `AgentCommandsResponse`; 404 for an unknown agent;
  bearer-guarded; read-only, so open to remote clients. Nothing is logged: commands are runtime
  state, not domain events.
- **Brains**: a user's message whose first word is a `/name` the brain's session offers is
  delivered **alone and as typed**, as its own turn (no "Since your last turn", no seed), so the
  CLI runs the command; the mailbox items before it make one turn first, those after it the next.
  Anything else (an unknown name, a path, another agent's message) stays a line of the turn
  prompt. The runner learns the names from `hasCommand`, i.e. from the last `commands()` read —
  which the composer makes when it mounts and again when `/` is typed (see "Limitations").
- **Web** (`apps/web/src/panel/composer/`): `useComposerAssist()` over each composer's own
  `<textarea>` — the Harmonizer's and a Waykeeper's chat (`chat/Conversation.tsx`) and the
  Steward's clarification box (`steward/ClarificationComposer.tsx`). `slash-commands.ts` reads the
  endpoint (on mount; again on the first `/` if the last read is older than 30 s, or 3 s when it
  was empty), per agent for the page's life; a failed read is an empty list. `assist-model.ts`
  holds the pure rules (query, ranking: name prefix, then name substring, then description; at
  most 50 rows).
  - `/` as the first character opens a listbox above the text box with the matching commands:
    `/name`, the argument hint, the description. ↑/↓ move (wrapping), Tab or Enter insert
    `/name ` (the list then closes: a space ends the name), Escape closes it until the text
    changes, a click or tap chooses (the textarea keeps the focus). With the list shut, Enter
    sends as before. No list when the agent offers none, when the chat's agent has ended, or when
    the read failed.
  - Accessibility: a `<textarea>` may not take the `combobox` role (ARIA in HTML), so it is an
    editable text box with a list — `aria-autocomplete="list"`, `aria-controls` and
    `aria-activedescendant` while the list is open, options with `aria-selected` — plus a polite
    status line ("4 slash commands: up and down arrows to choose, Tab or Enter to insert, Escape
    to close") referenced by `aria-describedby`. Axe-clean with the list open (test).
  - The clarification box offers only commands that are not the runtime's own (`builtin`): an
    answer reaches the agent as the text of its question's tool result, where `/compact` cannot
    run but a skill or a plugin command can be invoked by the agent.
- **Security**: names, hints and descriptions are text from the runtime (and from whoever wrote a
  skill or a plugin): normalised server-side (control characters out, bounded), rendered by React
  as text nodes only — a description holding markup shows as text (test). The endpoint discloses
  nothing a remote client could not already learn from the agent; it changes nothing.

### P8-14 — message history

- In an empty composer ↑ recalls the user's earlier messages to that agent, newest first; ↓ walks
  forward and back to an empty composer. The caret goes to the recalled text's end.
- Only an empty composer or an **unedited** recalled message reacts: anything typed (a draft, or
  an edit of a recalled message) makes ↑/↓ ordinary caret keys again, so a draft is never
  replaced. A recalled message of several lines moves the caret through its lines first (↑
  recalls an older one only from the first line, ↓ a newer one only from the last line), so
  multi-line editing keeps working. Editing a recalled message and sending sends the edited text.
  While the slash list is open, ↑/↓ belong to the list. A recalled `/command` does not open the
  list until it is edited.
- Sources, client-side only (no server change): the chat uses the user's own lines in the
  conversation the page has loaded (history pages and the live stream) plus those still being
  sent; the clarification box uses the user's earlier answers to that Steward's questions from the
  snapshot (`answeredBy: user`; a supervisor's answers are not the user's). An answer still queued
  offline (P7-05) is not history: while it is queued the box shows the queued answer, not the text
  box, so recall cannot touch it. Blank lines and a message repeated right after itself are left
  out.

## Tests

- protocol `slash.test.ts` (4): normalisation, bounds, `leadingSlashCommand`, schema.
- server: claude-sdk adapter (3: mapping and caching with a stubbed `supportedCommands()`, a
  slash command sent as the user message, `commands_changed`, no call / failing call / ended
  session); ACP adapter (2: `available_commands_update`, across a load, none); fake adapter (1);
  `http/commands-route.test.ts` (3: endpoint, `hasCommand`, empty and 404, token); brain runner
  (1: a known command is its own turn as typed, unknown names and paths are folded, delivered).
- web `assist-model.test.ts` (7) and `composer-assist.test.tsx` (11): the list (open, filter,
  arrows, Enter/Tab, Escape, pointer, nothing to show, text-only rendering, axe with the list
  open), history (newest first, multi-line caret rule, drafts kept, edited recall sent, the list
  owning ↑/↓, a recalled command), and the clarification box (answers as history, built-ins left
  out, Cmd+Enter still answers).

## Limitations and what needs a real run

- **Needs a real Claude run**: what `supportedCommands()` returns for a Steward (user, project and
  plugin skills) and for a brain (`settingSources: []`: probably the built-ins and bundled skills
  only), and that a streamed user message `/compact` or `/<skill> args` runs as the command in
  this SDK version (the SDK documents slash commands sent as the prompt; not verified here).
- A brain runs a slash command only once the server has read its commands (`hasCommand`): the
  composer does that on mount, so a command typed in the panel works; one sent another way before
  any read (the ops console) is folded into a turn prompt as text.
- A slash command in a brain's session's first prompt (a spawn or a reset folding the mailbox) is
  folded, not run.
- The clarification box's commands reach the agent as answer text; whether the agent then invokes
  the skill is up to it.
- History is what the page has loaded: older messages appear after "Load earlier messages". It is
  per page load (not stored per device), per conversation.
- The terminal agent's one-line input (P8-08) has neither feature (a terminal agent has no
  readable commands, and its own CLI keeps its history).

## Proposed SPEC §7 text (not edited in SPEC; numbers to be assigned on merge — P8-15 may also propose 115)

| 115 | Slash commands in the composer | **`/` lists what the agent's runtime offers; the message goes as typed** (2026-10-07, Cosmin, P8-13; §4.2, decisions 13, 57, 81, 90): typing `/` as the first character of a message in the Harmonizer's or a Waykeeper's chat, or in a Steward's clarification box, opens a list of the slash commands that agent's runtime reports for its live session — Claude Code's built-in commands, skills and plugin commands; an ACP agent's available commands; none for a terminal agent — filtered as the name is typed; arrows move, Tab or Enter insert `/name `, Escape closes, a click or tap chooses. No list when the agent offers none or has no live session. The message is sent as typed, so the runtime runs the command; to a brain, a user's message that starts with a command its session offers is delivered alone, as its own turn, instead of being folded into the next turn's summary. The clarification box offers skills and plugin commands only (an answer cannot run the runtime's own commands). The list is read-only information, open to remote clients; its text is the agent's and is shown as plain text. |
| 116 | Message history in the composer | **↑ in an empty composer recalls what the user sent to that agent** (2026-10-07, Cosmin, P8-14; decisions 81, 96): in an empty composer ↑ recalls the user's earlier messages to that conversation, newest first, and ↓ walks back to the empty composer, as in a terminal. Only an empty composer or an unedited recalled message reacts, and a recalled message of several lines first moves the caret through its lines, so a draft is never lost; editing a recalled message and sending sends the edited text. A Steward's clarification box recalls the user's earlier answers to that Steward. The history is the conversation the page has loaded; answers still queued offline are not part of it. While the slash list is open, the arrows belong to the list. |
