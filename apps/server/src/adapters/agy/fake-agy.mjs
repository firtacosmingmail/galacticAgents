#!/usr/bin/env node
// The fake Antigravity CLI (P11-05): enough of `agy` for the adapter's tests and the conformance
// suite, with no network and no model. Message shapes follow the sanitized P11-01 transcripts
// (`fixtures/*.jsonl`).
//
//   node fake-agy.mjs --version | models | -p "/usage" --output-format json
//   node fake-agy.mjs -p <prompt> --output-format stream-json [--model m] [--conversation id] …
//
// Like the real CLI it reads its global configuration from $HOME: every PreToolUse hook in
// `$HOME/.gemini/config/hooks.json` runs (through `sh -c`, the payload on stdin, killed at its
// `timeout`) before each tool call, and fails closed — a hook that times out, exits non-zero or
// prints something that is not JSON denies the call. Only `auto_approve` runs a tool that needs a
// permission (`allow` leaves the headless check, which refuses). MCP calls go to the stdio server
// of `$HOME/.gemini/config/mcp_config.json` (started at the first call). Generated images land in
// `$HOME/.gemini/antigravity-cli/brain/<conversation id>/`; conversations persist as JSON under
// `$HOME/.gemini/antigravity-cli/conversations/`, so `--conversation <id>` resumes one.
//
// The first prompt of a conversation picks the scenario (`scenario:<name>`; anything else:
// `echo`); later prompts are echoed ("echo: <prompt>"), except the first one after a resume of a
// conversation whose scenario never finished, when it is the runtime's restart prompt ("… your
// session was resumed …": a resumed `asks` asks again). SIGINT ends the turn
// with a result `INTERRUPTED` and exit 130.
//
// Environment: FAKE_AGY_RECORD (append `{argv, secret, url}` per run), FAKE_AGY_VERSION,
// FAKE_AGY_LOGGED_OUT=1, FAKE_AGY_USAGE_EXHAUSTED=1 (the Gemini bucket at 0).
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const HOME = process.env.HOME || homedir();
const GEMINI = join(HOME, '.gemini');

const flag = (name) => {
  const i = argv.indexOf(name);
  return i < 0 ? undefined : argv[i + 1];
};

if (process.env.FAKE_AGY_RECORD) {
  appendFileSync(
    process.env.FAKE_AGY_RECORD,
    `${JSON.stringify({
      argv,
      secret: Boolean(process.env.GALACTIC_AGY_SECRET),
      url: process.env.GALACTIC_AGY_URL ?? null,
      home: process.env.HOME ?? null,
    })}\n`,
  );
}

// --- one-shot subcommands -------------------------------------------------------------------

if (argv[0] === '--version') {
  process.stdout.write(`${process.env.FAKE_AGY_VERSION ?? '1.4.12'}\n`);
  process.exit(0);
}
if (argv[0] === 'models') {
  process.stdout.write(
    'Fetching available models...\n' +
      'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n' +
      'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n' +
      'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n' +
      'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n',
  );
  process.exit(0);
}
const prompt = flag('-p') ?? flag('--print');
if (prompt === undefined) {
  process.stderr.write(`fake agy: no prompt in ${argv.join(' ')}\n`);
  process.exit(2);
}
if (process.env.FAKE_AGY_LOGGED_OUT === '1') {
  process.stdout.write(
    'Authentication required. Please visit the URL to log in:\n  https://accounts.google.com/o/oauth2/auth?fake\n',
  );
  process.exit(1);
}
if (prompt === '/usage' && !argv.includes('--disable-slash-commands')) {
  const usage = JSON.parse(readFileSync(join(HERE, 'fixtures', 'usage.jsonl'), 'utf8'));
  if (process.env.FAKE_AGY_USAGE_EXHAUSTED === '1') {
    usage.command.data.groups[0].buckets[0].remaining_fraction = 0;
  }
  process.stdout.write(`${JSON.stringify(usage)}\n`);
  process.exit(0);
}

// --- a turn ----------------------------------------------------------------------------------

const out = (event, body) => process.stdout.write(`${JSON.stringify({ event, [event]: body })}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const convDir = join(GEMINI, 'antigravity-cli', 'conversations');
mkdirSync(convDir, { recursive: true });
const resumeId = flag('--conversation');
let id;
let state;
if (resumeId) {
  const file = join(convDir, `${resumeId}.json`);
  if (!existsSync(file)) {
    process.stderr.write(`Error: conversation ${resumeId} not found\n`);
    process.exit(1);
  }
  id = resumeId;
  state = JSON.parse(readFileSync(file, 'utf8'));
  // Every later turn continues the conversation; only the runtime's restart prompt reruns an
  // unfinished scenario (a resumed `asks` asks again).
  state.resumed = /session was resumed/i.test(prompt);
} else {
  id = randomUUID();
  state = { turns: 0, scenario: undefined, pending: false, resumed: false };
}
const save = () => writeFileSync(join(convDir, `${id}.json`), JSON.stringify(state));
const brain = join(GEMINI, 'antigravity-cli', 'brain', id);
mkdirSync(brain, { recursive: true });
const cwd = process.cwd();
const model = flag('--model') ?? 'gemini-3.8-flash-high';

let step = 0;
let response = '';
let interrupted = false;
const children = new Set();

process.on('SIGINT', () => {
  interrupted = true;
  for (const c of children) c.kill('SIGKILL');
  out('result', { conversation_id: id, status: 'INTERRUPTED', response, num_turns: 1 });
  save();
  process.exit(130);
});

out('init', {
  conversation_id: id,
  init: {
    cwd,
    tools: ['run_command', 'call_mcp_tool', 'generate_image'],
    permission_mode: 'request-review',
  },
});
out('step_update', {
  conversation_id: id,
  step_index: step++,
  state: 'DONE',
  step_type: 'user_input',
});

async function text(t) {
  const i = step++;
  out('step_update', {
    conversation_id: id,
    step_index: i,
    state: 'ACTIVE',
    step_type: 'agent_response',
    text_delta: t,
  });
  out('step_update', {
    conversation_id: id,
    step_index: i,
    state: 'DONE',
    step_type: 'agent_response',
    text_delta: '\n',
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
  });
  response += `${t}\n`;
  await sleep(5);
}

function readJson(file) {
  try {
    const raw = readFileSync(file, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Runs every matching PreToolUse hook; `none` when there is none. */
async function runHooks(name, args) {
  const config = readJson(join(GEMINI, 'config', 'hooks.json'));
  const hooks = [];
  for (const group of Object.values(config)) {
    if (!group || typeof group !== 'object' || group.enabled === false) continue;
    for (const m of group.PreToolUse ?? []) {
      const matcher = m.matcher ?? '*';
      if (matcher !== '*' && matcher !== '' && !new RegExp(matcher).test(name)) continue;
      for (const h of m.hooks ?? []) if (h.type === 'command') hooks.push(h);
    }
  }
  if (hooks.length === 0) return { decision: 'none' };
  const payload = JSON.stringify({
    artifactDirectoryPath: brain,
    conversationId: id,
    lastUserInput: prompt,
    modelName: model,
    stepIdx: step,
    toolCall: { name, args },
    transcriptPath: join(brain, '.system_generated', 'logs', 'transcript_full.jsonl'),
    workspacePaths: [cwd],
  });
  let approved = false;
  for (const h of hooks) {
    const r = await runHook(h, payload);
    if (r.failed)
      return { decision: 'deny', error: `JSON hook "${h.command}" failed: ${r.failed}` };
    if (r.decision === 'deny') return { decision: 'deny', reason: r.reason ?? '' };
    if (r.decision === 'auto_approve') approved = true;
  }
  return { decision: approved ? 'auto_approve' : 'allow' };
}

function runHook(h, payload) {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', h.command], { env: process.env, stdio: 'pipe' });
    children.add(child);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), (h.timeout ?? 30) * 1000);
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      if (signal)
        return resolve({
          failed: `command failed: signal: ${signal === 'SIGKILL' ? 'killed' : signal}`,
        });
      if (code !== 0)
        return resolve({
          failed: `command failed: exit status ${code}${stderr ? `, stderr: ${stderr}` : ''}`,
        });
      try {
        const v = JSON.parse(stdout);
        resolve({ decision: v.decision, reason: v.reason });
      } catch (e) {
        resolve({ failed: `failed to unmarshal result from hook via protojson: ${e.message}` });
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(payload);
  });
}

const NEEDS_PERMISSION = new Set([
  'run_command',
  'write_file',
  'edit_file',
  'generate_image',
  'search_web',
]);

/** One tool step: the hooks, then the tool (when allowed). Returns `{ok, output?, error?}`. */
async function tool(name, args, run) {
  const i = step++;
  const base = { conversation_id: id, step_index: i, step_type: 'tool', tool_name: name };
  out('step_update', { ...base, state: 'ACTIVE', tool_info: { name, parameters: args } });
  const hook = await runHooks(name, args);
  let error;
  if (hook.decision === 'deny') {
    error = hook.error ?? `tool call denied by pre-tool hook: ${hook.reason}`;
  } else if (hook.decision !== 'auto_approve' && NEEDS_PERMISSION.has(name)) {
    error = `permission check failed for "${name}": user denied permission to run command`;
  }
  if (error) {
    out('step_update', {
      ...base,
      state: 'ERROR',
      tool_info: { name, parameters: args, error: { type: 'TOOL_ERROR', message: error } },
    });
    return { ok: false, error };
  }
  const output = await run();
  out('step_update', { ...base, state: 'DONE', tool_info: { name, parameters: args, output } });
  return { ok: true, output };
}

// --- MCP client --------------------------------------------------------------------------------

let mcp;
function mcpServer() {
  if (mcp) return mcp;
  const config = readJson(join(GEMINI, 'config', 'mcp_config.json'));
  const entry = config.mcpServers?.galactic;
  if (!entry) throw new Error('no galactic MCP server configured');
  const child = spawn(entry.command, entry.args ?? [], {
    env: process.env,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  children.add(child);
  const waiting = new Map();
  let next = 1;
  createInterface({ input: child.stdout }).on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const w = waiting.get(msg.id);
    if (!w) return;
    waiting.delete(msg.id);
    if (msg.error) w.reject(new Error(msg.error.message));
    else w.resolve(msg.result);
  });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const rid = next++;
      waiting.set(rid, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: rid, method, params })}\n`);
    });
  mcp = (async () => {
    await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'fake-agy', version: '0' },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    const listed = await request('tools/list', {});
    return { request, tools: listed.tools ?? [] };
  })();
  return mcp;
}

async function callMcp(toolName, args) {
  const r = await tool(
    'call_mcp_tool',
    { ServerName: 'galactic', ToolName: toolName, Arguments: args },
    async () => {
      const server = await mcpServer();
      if (!server.tools.some((t) => t.name === toolName)) return `unknown tool ${toolName}`;
      const result = await server.request('tools/call', { name: toolName, arguments: args });
      return (result.content ?? []).map((c) => c.text).join('\n');
    },
  );
  return r.ok ? r.output : undefined;
}

// --- scenarios ----------------------------------------------------------------------------------

const command = (line, output) => tool('run_command', { CommandLine: line }, async () => output);

const SCENARIOS = {
  happy: async () => {
    await text('Reading the README to get started.');
    await command('cat README.md', '# readme');
    await text('done');
  },
  asks: async () => {
    await text('I need to know one thing first.');
    await tool(
      'read_file',
      { Path: join(GEMINI, 'antigravity-cli', 'mcp', 'galactic', 'ask_user.json') },
      async () => '{}',
    );
    const answer = await callMcp('ask_user', {
      question: 'Which option do you prefer?',
      options: ['first option', 'second option'],
    });
    await text(answer ? `You chose: ${answer}` : 'No answer; carrying on.');
  },
  permission: async () => {
    await text('Cleaning the build directory.');
    const r = await command(`rm -r ${join(cwd, 'build')}`, 'deleted build');
    await text(r.ok ? 'cleaned' : 'I was not allowed to clean.');
  },
  long: async () => {
    for (let i = 1; i <= 6; i++) {
      await command(`echo step ${i}`, `step ${i}`);
      await sleep(200);
    }
    await text('finished');
  },
  echo: async () => {
    await sleep(10);
    await text('ready');
  },
  stalls: async () => {
    await text('Starting a slow step.');
    await sleep(1000);
    await text('back');
  },
  tool: async () => {
    const name = /tool:([\w-]+)/.exec(prompt)?.[1] ?? 'request_publish';
    const result = await callMcp(name, { text: 'hello' });
    await text(`tool said: ${result ?? 'nothing'}`);
  },
  image: async () => {
    await tool(
      'invoke_subagent',
      { Role: 'Image Generator', TypeName: 'image-generator' },
      async () => 'started',
    );
    const r = await tool(
      'generate_image',
      { AspectRatio: '1:1', ImageName: 'img1', Prompt: 'a red circle' },
      async () => {
        const bytes = Buffer.from([
          0x89,
          0x50,
          0x4e,
          0x47,
          0x0d,
          0x0a,
          0x1a,
          0x0a,
          ...Buffer.from(`fake image ${id}`),
        ]);
        writeFileSync(join(brain, 'img1.png'), bytes);
        writeFileSync(join(brain, 'notes.md'), '# not an image\n');
        return `saved ${join(brain, 'img1.png')}`;
      },
    );
    await tool('send_message', { Message: 'done' }, async () => 'sent');
    await text(r.ok ? 'image generated' : 'no image');
  },
  limit: async () => {
    await text('Working on it.');
    process.stderr.write(
      'AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","code":429,"message":"Individual quota exhausted for the Gemini models","retryable":false,"error_id":"fake"}\n',
    );
    save();
    process.exit(3);
  },
  /** The quota reported only in the final result (exit 0). */
  'limit-result': async () => {
    await text('Working on it.');
    save();
    out('result', {
      conversation_id: id,
      status: 'ERROR',
      response,
      error: { message: 'RESOURCE_EXHAUSTED: Individual quota exhausted' },
      finished_reason: 'error',
    });
    process.exit(0);
  },
  'write-config': async () => {
    const r = await tool(
      'write_file',
      { Path: join(cwd, '.agents', 'hooks.json'), Content: '{}' },
      async () => 'written',
    );
    await text(r.ok ? 'wrote the config' : `refused: ${r.error}`);
  },
  browser: async () => {
    const r = await tool('browser_click_element', { Selector: '#x' }, async () => 'clicked');
    await text(r.ok ? 'clicked' : `refused: ${r.error}`);
  },
};

let scenario;
if (state.turns === 0) {
  scenario = /scenario:([\w-]+)/.exec(prompt)?.[1] ?? 'echo';
  state.scenario = scenario;
} else if (state.resumed && state.pending) {
  scenario = state.scenario;
}
state.resumed = false;
state.turns += 1;
save();

try {
  if (scenario) {
    const run = SCENARIOS[scenario];
    if (!run) throw new Error(`no scenario ${scenario}`);
    state.pending = true;
    save();
    await run();
    state.pending = false;
  } else {
    await sleep(10);
    await text(`echo: ${prompt}`);
  }
} catch (e) {
  if (!interrupted) process.stderr.write(`fake agy: ${e.message}\n`);
}
save();
for (const c of children) c.kill('SIGKILL');
out('result', {
  conversation_id: id,
  status: 'SUCCESS',
  response,
  num_turns: state.turns,
  usage: { total_tokens: 12 },
});
process.exit(0);
