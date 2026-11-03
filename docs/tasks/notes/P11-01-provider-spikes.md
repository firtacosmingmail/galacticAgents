# P11-01 — Provider spikes: Codex CLI 0.166.0 and Antigravity CLI `agy` 1.4.12

Run 2026-11-02 on this Mac, subscription logins only (Codex: ChatGPT **Free** plan; agy: Google login). About ten tiny Codex prompts and fourteen tiny agy prompts, every run in a fresh directory under `/private/tmp/claude-501/p11-*`. No credentials were read. `~/.gemini/config/hooks.json` did not exist before the global-entry probe; it was created for one run and removed (the directory is back to `.migrated`, `mcp_config.json`, `projects/`, as before).

Evidence: sanitized transcripts in `apps/server/src/adapters/{codex,agy}/fixtures/` (accounts, emails, installation ids replaced; paths normalised to `/tmp/work` and `/Users/example`). Re-run with `scripts/spikes/` (`agy-hook-probe.mjs` is the hook; `agy-run-probe.sh`, `codex-app-server-probe.mjs`, `mcp-echo-probe.mjs` are the drivers). Fixture line format: Codex `{"dir":"in"|"out","msg":<JSON-RPC message>}` (`in` = from the server, `_t` = ms since start on `in` lines); agy: the raw `stream-json` lines, `usage.jsonl` the one-line `/usage` JSON, `hook-payload-mcp.json` a hook stdin sample.

## Ruling

**Ruling: agy runs in full-tool mode, not image-only — its PreToolUse hook failed closed on timeout, crash, exit 2 and invalid output and every tool that ran reached it (subagents included), but `--settings` cannot carry hooks, so Task 6 delivers the hook through the managed `~/.gemini/config/hooks.json` entry (tagged `"galactic": true`, passing through when `GALACTIC_AGY_SECRET` is absent) and the tool server through the same kind of managed global `mcp_config.json` entry; browser tools stayed unexercised (see agy 4) and the hook denies them statically.**

## Codex (`codex app-server`, JSON-RPC 2.0, one JSON object per line on stdio)

### 1. Settings that held (fixtures `turn-ok`, `approval-*`)

```
→ initialize        {clientInfo:{name,title:null,version}, capabilities:{experimentalApi:true, requestAttestation:false}}
→ initialized       (notification, no params)
→ thread/start      {cwd, approvalPolicy:"untrusted", approvalsReviewer:"user", sandbox:"workspace-write",
                     config:{web_search:"disabled", mcp_servers:{}, features:{apps:false, plugins:false,
                             image_generation:false, browser_use:false, computer_use:false}},
                     dynamicTools?:[{type:"function", name, description, inputSchema}]}
← result            {thread:{id,…}, model:"gpt-6-luna", approvalPolicy:"untrusted", approvalsReviewer:"user",
                     sandbox:{type:"workspaceWrite", writableRoots:[], networkAccess:false,
                              excludeTmpdirEnvVar:false, excludeSlashTmp:false}, …}
→ turn/start        {threadId, input:[{type:"text", text, text_elements:[]}], approvalPolicy:"untrusted",
                     sandboxPolicy:{type:"workspaceWrite", writableRoots:[], networkAccess:false,
                                    excludeTmpdirEnvVar:false, excludeSlashTmp:false}, model?, effort?}
```

- `dynamicTools` is an **experimental** field: it needs `capabilities.experimentalApi: true` in `initialize` (types: `codex app-server generate-ts --experimental`). `DynamicToolSpec = {type:"function", name, description, inputSchema, deferLoading?}`.
- Per-turn `model` / `effort` overrides persist for later turns (schema); `thread/start` also takes `model`.
- `thread/start` accepted the `config` object without complaint. **But the `features.*` / `plugins` keys in `config` do not remove plugin MCP servers**: `mcpServerStatus/list` still listed `codex_app` and `codex_apps` (tools `{}` or lazily loaded) and a different thread config even started `cua_repl`. Passing the switches on the **process command line** (`codex app-server --disable plugins --disable apps --disable image_generation --disable browser_use --disable computer_use`) did remove them: the list then held only `node_repl`. Task 5 passes the command-line flags and the thread `config`.
- Messages seen before a turn, all harmless: `remoteControl/status/changed`, `account/updated {authMode:"chatgpt", planType:"free"}`, `thread/started`, `mcpServer/startupStatus/updated`.

### 2. Gap found: the built-in `node_repl` MCP server is not gated and cannot be switched off

A built-in MCP server `node_repl` (tool `js`, `readOnlyHint: true`) starts on every thread, even with `--disable plugins --disable apps` and `-c mcp_servers.node_repl.enabled=false` (probe `js-tool-off`). Under `approvalPolicy: "untrusted"` the model's `js` call ran with **no approval request of any kind**: `item/started {type:"mcpToolCall", server:"node_repl", tool:"js", arguments:{code}}` then `item/completed`. It is a restricted runtime: `require` is not defined, the globals are only `fetch`, `URL`, `Buffer`, timers, `crypto`, `console` and similar, and `fetch("https://example.com")` fails (`net-blocked: fetch failed`), so it has no file-system access and no network in this probe. Consequences for Task 5: the gate cannot see these calls; the adapter must emit a `tool_call` event for `mcpToolCall` items of server `node_repl` for the log, never treat them as approved by the user, and the review should accept the sandboxed `js` tool as a known residual (compute only). If a later Codex release gives it file or network access, re-run `scripts/spikes/codex-app-server-probe.mjs js-escape`.

**Addendum (P11-04, 2026-11-03):** `node_repl` is not built into Codex: `config/read` with layers shows it declared in the user's `~/.codex/config.toml` (written there by the ChatGPT desktop app, command under `/Applications/ChatGPT Classic.app/…/node_repl`). A thread's `config.mcp_servers: {}` and a command-line `-c mcp_servers={}` do not remove a server a lower config layer declares (tested with an extra `-c mcp_servers.probefake.command=…`). `enabled=false` and `enabled_tools=[]` empty its listed tools, yet a real turn still ran `js` with no request in both cases; `--disable code_mode_host`, a replaced `command` and a dead `--code-mode-host` changed nothing. Outcome for Ruling R5: it cannot be switched off; accepted as residual (TECHNOLOGY §3.6). `request_user_input` is offered only in the `plan` collaboration mode: in the default mode the model answered "no such tool", also with `--enable default_mode_request_user_input`. **Later in P11-04 (rulings R6, R7):** the adapter gives every thread its own `ask_user` dynamic tool, and runs Codex with a Mission-Control-owned `CODEX_HOME` (own `config.toml`, `auth.json` a symlink to the user's): with it, login worked, `mcpServerStatus/list` was empty, the model answered `NO_JS_TOOL`, and the symlink was still a symlink after the run. Dynamic tools given at `thread/start` survive `thread/resume` in a new process (a resumed spike thread called `request_publish` again without them being resent; `thread/resume` ignores unknown fields).

### 3. Approval request shapes (fixtures `approval-command`, `approval-file`, `approval-decline`)

`item/commandExecution/requestApproval` (server request, id is the JSON-RPC id):

```
params: {kind:"command", threadId, turnId, itemId, startedAtMs, environmentId:"local",
         command:"/bin/zsh -lc 'touch probe.txt .'", cwd, commandActions:[{type:"unknown", command:"touch probe.txt ."}],
         proposedExecpolicyAmendment:["touch","probe.txt","."],
         availableDecisions:["accept", {acceptWithExecpolicyAmendment:{execpolicy_amendment:[…]}}, "cancel"]}
reply:  {decision:"accept"} | {decision:"decline"} | {decision:"cancel"}
```

- `decline` is honoured although it is **not** in `availableDecisions`: the command item completes with `status:"declined"`, the file is not created, the model is told "rejected" and the turn completes normally (`approval-decline`). `accept` runs the command (`approval-command`). Then `serverRequest/resolved {threadId, requestId}` arrives.
- `item/fileChange/requestApproval` params are only `{threadId, turnId, itemId, startedAtMs, reason:null, grantRoot:null}`. **The changed paths are not in the request**; they come from the preceding `item/started` item of the same `itemId`: `{type:"fileChange", changes:[{path (absolute), kind:{type:"add"|…}, diff}]}`. The adapter must keep the started item by `itemId` and map each `changes[].path` to an `Edit` call. Reply `{decision:"accept"}`; completion `item/completed {type:"fileChange", status:"completed"}`.
- Even `touch probe.txt` inside the workspace is gated under `untrusted`.

### 4. Dynamic tool (fixture `dynamic-tool`)

Registered at `thread/start` as in 1. The model's call arrives as:

```
item/started   {item:{type:"dynamicToolCall", id, namespace:null, tool:"request_publish", arguments:{text:"hello"}, status:"inProgress"}}
← request      item/tool/call  params:{threadId, turnId, callId, namespace:null, tool:"request_publish", arguments:{text:"hello"}}
→ response     {contentItems:[{type:"inputText", text:"<JSON string>"}], success:true}
item/completed {item:{type:"dynamicToolCall", status:"completed", contentItems, success:true, durationMs}}
```

`DynamicToolCallOutputContentItem = {type:"inputText",text} | {type:"inputImage",imageUrl} | {type:"inputAudio",audioUrl}`. A tool call needs **no approval request**; the adapter's `ToolDefinition.handler` result goes back as one `inputText` item with `success` true (false on a handler error). No `callId` echo is needed: the JSON-RPC id answers it.

### 5. Late approval (fixture `late-approval`)

The approval request was answered **630 s (10.5 minutes) late** (the request at t = 4.3 s, the `accept` sent at t = 634 s). The server honoured it: `serverRequest/resolved` at 634.3 s, the command ran (`late.txt` exists), `turn/completed` at 635.8 s. So a 10-minute-late answer is still honoured. Hours were not tested.

### 6. Network in the sandbox (probe `network`; run in `/private/tmp/claude-501/p11-codex-network`, not kept as a fixture)

`curl -sS -m 15 https://example.com` run with `accept` under `workspace-write` + `networkAccess:false`: **blocked** — exit 6, `curl: (6) Could not resolve host: example.com`, item status `failed`, 34 ms.

### 7. Models, account, usage (fixture `turn-ok`)

- `model/list {}` → `data[]` of `{id, model, displayName, hidden, supportedReasoningEfforts, defaultReasoningEffort, inputModalities, isDefault, …}`; here `gpt-6-luna` (default), `gpt-5.6-terra`, `gpt-5.6-luna`.
- `account/read {refreshToken:false}` → `{account:{type:"chatgpt", email, planType:"free", workspaceName}, requiresOpenaiAuth:true, workspaceRouting:{…}}` (the email is sanitized; never log it).
- `account/rateLimits/read` (no params) → `{ordinaryUsageAllowed, rateLimits:{limitId:"codex", primary:{usedPercent:1, windowDurationMins:43200, resetsAt:1796027861}, secondary:null, credits:{…}, planType:"free", rateLimitReachedType:null}, rateLimitsByLimitId:{codex:{…}}, …}`; pushed again as `account/rateLimits/updated` after each model call. The Free plan has a single 30-day window.
- `thread/tokenUsage/updated {tokenUsage:{total:{totalTokens,…}, last:{…}, modelContextWindow}}` after each model call.

### 8. Limit error shape (from the generated schema and the binary; not triggered — the Free plan was at 1–2 %)

A usage limit arrives as `error {error:{message, codexErrorInfo:"usageLimitExceeded", additionalDetails}, willRetry:false, threadId, turnId}` followed by `turn/completed` with `turn.status:"failed"`. `codexErrorInfo` is `"usageLimitExceeded"` for the plan limit and `"rateLimitExceeded"` for a transient rate limit; the message begins "You've hit your usage limit" (several variants, e.g. "… Upgrade to Plus to continue using Codex", "… Visit https://chatgpt.com/settings/usage to purchase more credits"). The reset time is not in the error: read `account/rateLimits/read` → `rateLimits.primary.resetsAt` (unix seconds) and `rateLimitReachedType` (`rate_limit_reached`, `workspace_owner|member_credits_depleted`, `workspace_owner|member_usage_limit_reached`). Plan/quota limit: the exact text was not captured because it was not reachable on this plan without burning the window; Task 5's limit tests use this shape.

## Antigravity (`agy` 1.4.12)

### 1. Hook delivery: `--settings` cannot carry hooks (probe `settings-hooks`)

`agy --settings '{"hooks":{…}}'` exits 1 with `Error: --settings: unknown setting "hooks"` (also `mcpServers`, `mcp`, `mcpConfig`, `servers`). The docs list hooks only in `.agents/hooks.json` (workspace), `~/.gemini/config/hooks.json` (global) and plugins; `~/.gemini/antigravity-cli/settings.json` hooks are not loaded. The format that works (verified):

```json
{"<group-name>":{"enabled":true,"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"node /abs/hook.mjs","timeout":86400}]}]}}
```

The workspace file is forbidden by the Global Constraints (an agent can write in the workspace). The **global file works** (probe `global`): with `~/.gemini/config/hooks.json` holding one entry, a fresh directory without `.agents/` got the hook (`run_command` → `auto_approve` ran the command). The hook process inherits the environment of the `agy` process (the probe's `PROBE_*` variables arrived), so `GALACTIC_AGY_SECRET` and the Mission Control URL can travel in the env of a spawn. `--settings` does carry `permissions` (see 6).

### 2. Hook stdin and decisions (fixtures `hook-allow`, `hook-deny`, `hook-payload-mcp.json`)

stdin: `{artifactDirectoryPath, conversationId, lastUserInput, modelName, stepIdx, toolCall:{name, args}, transcriptPath, workspacePaths[]}`; stdout `{"decision":…, "reason"?}`.
- `deny` → the tool errors `tool call denied by pre-tool hook: <reason>` (fixture `hook-deny`), the model is told, `result.status` stays `SUCCESS`, exit 0.
- `allow` does **not** run a tool that needs a permission: the normal permission check still denies it headlessly (`user denied permission to run command`, `result.denied_actions`, stderr `jetski: no output produced…`). Only `auto_approve` runs it (fixture `hook-allow`, 75 s wait).
- **Long wait works:** a hook with `"timeout":86400` that slept 75 s and then answered `auto_approve` ran the command (`print-timeout 300s`; default `0` waits for the turn). 24 h itself was not waited out; the value is accepted.
- A `permissions.deny` rule beats `auto_approve` (see 6).

### 3. Fail mode: **fails closed** on every failure (probes `f-sleep`, `f-crash`, `f-garbage`, `f-exit2`)

With a hook that never produces a decision, the tool never ran (the `marker.txt` file does not exist in any of the four directories) and the error is returned to the model:

| Hook behaviour | Tool result |
|---|---|
| sleeps past its `timeout` (5 s, slept 60 s) | `JSON hook "…" failed: command failed: signal: killed` (killed at the timeout) |
| exits 1, no output | `… failed: command failed: exit status 1` |
| prints text that is not JSON | `failed to unmarshal result from hook … via protojson: … syntax error` |
| exits 2 with stderr | `… failed: command failed: exit status 2, stderr: probe exit 2` |

The run still ends `SUCCESS`, exit 0 — a denied hook never fails the process, so the adapter must read `tool_info.error` / `denied_actions` itself. The hook also fires for `read_file` (the model tried to read config files to understand the failure), so a dead hook blocks even reads.

### 4. Which tools reach the hook

Hook-visible names differ from the `init` tool list. Observed to reach the hook (args in the fixtures): `run_command {CommandLine,…}`, `write_file {Path,Content}`, `edit_file {Path,Target,Replacement}`, `read_file {Path}` (also for URLs: `{Path:"https://example.com"}`, and for directory listings), `search_web {query}`, `schedule`, `invoke_subagent {Prompt,Role,TypeName}`, `generate_image {AspectRatio,ImageName,Prompt}`, `send_message {Message}`, `call_mcp_tool {ServerName,ToolName,Arguments}`.
- **Not exercisable:** `open_browser_url`, `sed_file`, `notebook_edit`, `send_command_input` returned `unknown tool: "…" — check spelling` in headless print mode even though `init.tools` lists them (and the whole `browser_*` family); no hook fired because no tool ran. No browser is available headlessly on this Mac, so browser coverage is unverified; the hook answers `deny` for any tool name outside an allow-list, so an unknown or future tool is denied by default.
- Nothing that ran bypassed the hook.

### 5. Subagents and the image (fixture `image`)

- Hooks fire **inside subagents**: `invoke_subagent` (the parent, `conversationId` A) then `generate_image` ×3 and `send_message` ×2 under the subagent's own `conversationId` B and `modelName: "gemini-3.8-flash-tiered"`. The subagent's `artifactDirectoryPath` is B's directory.
- **Where the image lands:** `~/.gemini/antigravity-cli/brain/<parent conversation_id>/<name>_<epoch-ms>.jpg` (the parent's `artifactDirectoryPath`), e.g. `plain_red_circle_v2_1793621266155.jpg` (426 KB) and `red_circle_1793621236086.jpg` (58 KB): the image-generator made several and the parent's directory held two files. `images.ts` copies the new files of that directory.
- One image run consumed about 18 percentage points of the Gemini weekly bucket (98 % → 80 % remaining) — images are expensive; keep real image tests to one.
- Hook policy for image-only needs: allow `invoke_subagent` (TypeName `image-generator`) and `generate_image` (and `send_message` inside the subagent); everything else is the normal rules.

### 6. MCP per session and permission rules

- `--settings` has no MCP key. MCP servers come from `~/.gemini/config/mcp_config.json` (empty file here) or **`<workspace>/.agents/mcp_config.json`** (verified: `{"mcpServers":{"galactic":{"command":"node","args":[…]}}}`); the model read a descriptor `~/.gemini/antigravity-cli/mcp/<server>/<tool>.json` with `read_file`, then called `call_mcp_tool {ServerName:"galactic", ToolName:"request_publish", Arguments:{text:"hello"}}` and got the server's JSON back. Both steps go through the hook. The workspace file is writable by the agent, and starting a server is not gated, so Task 6 uses a managed global entry (tagged, removed on dispose, scoped by `GALACTIC_AGY_SECRET`) rather than a worktree file, and the hook denies `write_file`/`edit_file` on any `.agents/` or `.gemini/` path.
- `--settings '{"permissions":{"deny":["command(touch)"]}}'` **beat a hook `auto_approve`** (`Matches user-configured deny rule`); the glob form `command(touch *)` did not match `touch marker.txt` (command rules are prefix or `regex:`). So static deny rules are a second layer under the hook.

### 7. `/usage` JSON (fixture `usage`)

`agy -p "/usage" --output-format json` (no model turn, exit 0): `{conversation_id:"", status:"SUCCESS", response:"<tab text>", num_turns:0, usage:{…0}, command:{name:"usage", data:{description, groups:[{name:"Gemini Models", description, buckets:[{id:"gemini-weekly", name, window:"weekly", remaining_fraction:0.80, reset_time:"2026-11-07T08:31:33Z"}]}, {name:"Claude and GPT models", buckets:[{id:"3p-weekly", remaining_fraction:1, reset_time:"…"}]}]}}}`.

### 8. Stream shapes (fixtures `turn-ok`, `hook-*`, `image`)

`init {conversation_id, init:{cwd, tools[], permission_mode}}`, `step_update {step_type: "user_input"|"agent_response"|"tool"|"subagent"|"system_message", tool_name, tool_info:{parameters|output|error}, state: ACTIVE|DONE|ERROR, usage}`, final `result {status, response, num_turns, duration_seconds, usage, denied_actions[]}`. Limit shape (exit 3, `AGY_ERROR`) was not triggerable and stays from the changelog (research report).

## What each later task takes from here

- Task 5: sections Codex 1–8, including the command-line `--disable` flags, the `fileChange` path lookup and the unguarded sandboxed `node_repl`.
- Task 6: the Ruling; hook through a managed global `hooks.json` entry (`enabled`, group name `galactic`, `timeout` 86400), decision `auto_approve` for allow (never `allow`), `deny` for everything else, static `.agents/` and `.gemini/` write denial, tool server through a managed global MCP entry, images from the parent conversation's brain directory.
