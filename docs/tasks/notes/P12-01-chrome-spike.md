# P12-01 — Chrome spike notes

Date: 2026-11-05. Probe: `scripts/spikes/chrome-sdk-probe.mjs` (flags `--hook-ask`, `--second`).
Environment: Claude Code CLI 2.1.318, `@anthropic-ai/claude-agent-sdk` 0.3.285 (apps/server), Google Chrome with the Claude in Chrome extension installed and connected, subscription login.

## Safety of the probe

The probe serves its own page on `127.0.0.1:<random port>`, runs in a temp directory outside the repo, and its `canUseTool` denies Bash/Write/Edit/NotebookEdit/WebFetch/WebSearch and any tool input mentioning a host other than `localhost`/`127.0.0.1`. It never touched GitHub or any logged-in site. No call was denied in the runs below (the model stayed on the local page).

## 1. Does `extraArgs: { chrome: null }` work under the Agent SDK?

Yes. The `system/init` message lists the Chrome tools and `mcp_servers` contains `{"name":"claude-in-chrome","status":"connected","source":"dynamic"}`. The model opened a new tab on the local page, navigated, took a screenshot and read the heading ("Chrome probe page"); the result was `success`.

## 2. Exact tool names (the catalogue prefix)

**Prefix: `mcp__claude-in-chrome__`** (server name `claude-in-chrome`). Tools present in `init` (22):

`browser_batch`, `computer`, `file_upload`, `find`, `form_input`, `get_page_text`, `gif_creator`, `javascript_tool`, `list_connected_browsers`, `navigate`, `read_console_messages`, `read_network_requests`, `read_page`, `resize_window`, `select_browser`, `shortcuts_execute`, `shortcuts_list`, `switch_browser`, `tabs_close_mcp`, `tabs_context_mcp`, `tabs_create_mcp`, `upload_image`.

Calls seen in the runs: `tabs_context_mcp {createIfEmpty}`, `tabs_create_mcp {}`, `navigate {tabId, url}`, `computer {action, tabId}` (the screenshot is `action: "screenshot"`), `tabs_close_mcp {tabId}`, `browser_batch {actions[]}`. Note `browser_batch` carries several actions in one call, and `javascript_tool`, `form_input`, `file_upload` and `upload_image` exist: the scope judge must read nested `actions`, not only top-level `url`. The model also calls `Skill` and `ToolSearch` before the first Chrome call; those are not Chrome tools and follow the normal policy.

## 3. Do Chrome calls reach `canUseTool`?

- **Without any hook** (default permission mode): `tabs_context_mcp`, `tabs_create_mcp`, `navigate`, `computer`, `browser_batch` reached `canUseTool`. `tabs_close_mcp` did not (twice, in separate sessions): the CLI apparently allows it without asking. So `canUseTool` alone does not see every Chrome call.
- **With a `PreToolUse` hook answering `ask` for `mcp__claude-in-chrome__.*`** (`--hook-ask`, the route the adapter's gate uses): every call, including `tabs_close_mcp`, reached `canUseTool` right after the hook. Order per call: hook (`ask`) then `canUseTool`. So the gate returning `ask` for the flag's tools, followed by the scope check in `canUseTool` (the design in spec 5.4), works, and it must be the hook's `ask` that guarantees coverage.

## 4. Two sessions at once

Two concurrent SDK sessions with `chrome: null` both connected to the same extension and both completed (`--second` run): each created its own tab on the local page and took a screenshot. They share one browser; their calls interleave (A and B created tabs at the same moment, B used `browser_batch`). There was no error or refusal, but nothing isolates one session's tabs from the other's (`tabs_context_mcp` shows the shared tab group). So the plan's "one live `chrome` Steward at a time" rule is a product safeguard, not something Chrome enforces; keep it.

## 5. How a screenshot gets into a GitHub PR comment

Not exercised in the spike (the probe must not touch GitHub). From the tool list and reasoning: GitHub has no API for image uploads, so the Steward would open the PR page in the logged-in Chrome (`navigate`), take a screenshot (`computer` `screenshot`, which returns an image id), and attach it with `upload_image` (drops a captured screenshot into a page element, e.g. the comment box's file drop zone) or `file_upload` (sets a local file on a file input). GitHub then inserts the hosted image markdown into the comment, and the Steward submits it with `computer`/`form_input`. These steps are unverified; the first real use will show whether `upload_image` works on GitHub's comment box. Every such call is a flag tool call and goes through the scope watch.

## Concerns for later tasks

- `navigate` input is `{ tabId, url }`, `browser_batch` hides actions in `actions[]`: the judge input must keep the whole redacted input.
- The `ToolSearch` step means the Chrome tools are deferred and the first Chrome call comes after a few non-Chrome calls; harmless.
- `mcp_servers` shows other plugin servers connecting in the same session (user-level plugins); not related to the flag.

Ruling: go
