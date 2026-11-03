#!/usr/bin/env node
// The fake Codex CLI (P11-04): enough of `codex --version`, `codex login status` and
// `codex app-server` (JSON-RPC 2.0, one JSON object per line on stdio) for the Codex adapter's
// tests and the conformance suite. No network, no model. Message shapes follow the sanitized
// transcripts of P11-01 (`fixtures/*.jsonl`); `scenario:replay-<fixture>` replays one of them.
//
//   node fake-codex-agent.mjs [--state <dir>] [--record <file>] [--speed <factor>] <subcommand>
//
// Subcommands: `--version` (prints `codex-cli $FAKE_CODEX_VERSION`, default 0.166.0),
// `login status` (exit 1 "Not logged in" when FAKE_CODEX_LOGGED_OUT=1; the text is
// $FAKE_CODEX_LOGIN_TEXT, default "Logged in using ChatGPT"), `app-server [flags]`.
//
// `--record <file>` appends one JSON line per event: `{argv}` at start, then `{in: <message>}` for
// every message the client sent (requests, notifications and replies to server requests).
//
// The first prompt of a thread picks the scenario (`scenario:<name>`; anything else: `echo`);
// later prompts are echoed ("echo: <prompt>"), except the first prompt after a `thread/resume` of
// a thread whose scenario never finished: that one runs it again (a resumed `asks` asks again).
// Threads persist as JSON under the state directory, so a new process can resume them. The
// process exits when its stdin closes.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const i = argv.indexOf(name);
  if (i < 0 || argv[i + 1] === undefined) return fallback;
  const value = argv[i + 1];
  argv.splice(i, 2);
  return value;
};
const stateDir = option('--state', join(tmpdir(), 'galactic-fake-codex'));
const recordFile = option('--record', undefined);
const speed = Number(option('--speed', '1'));
const record = (entry) => {
  if (recordFile) appendFileSync(recordFile, `${JSON.stringify(entry)}\n`);
};

// --- one-shot subcommands -------------------------------------------------------------------

if (argv[0] === '--version') {
  process.stdout.write(`codex-cli ${process.env.FAKE_CODEX_VERSION ?? '0.166.0'}\n`);
  process.exit(0);
}
if (argv[0] === 'login' && argv[1] === 'status') {
  if (process.env.FAKE_CODEX_LOGGED_OUT === '1') {
    process.stderr.write('Not logged in\n');
    process.exit(1);
  }
  process.stdout.write(`${process.env.FAKE_CODEX_LOGIN_TEXT ?? 'Logged in using ChatGPT'}\n`);
  process.exit(0);
}
if (argv[0] !== 'app-server') {
  process.stderr.write(`fake codex: unknown subcommand ${argv.join(' ')}\n`);
  process.exit(2);
}
record({ argv: argv.slice(), codexHome: process.env.CODEX_HOME ?? null });

// --- JSON-RPC -------------------------------------------------------------------------------

mkdirSync(stateDir, { recursive: true });
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params });
let nextServerId = 0;
const serverWaits = new Map();
/** A server request; resolves with the client's result (or rejects with its error). */
const serverRequest = (method, params, signal) =>
  new Promise((resolve, reject) => {
    const id = nextServerId++;
    serverWaits.set(id, { resolve, reject });
    signal?.addEventListener(
      'abort',
      () => {
        serverWaits.delete(id);
        reject(new Cancelled());
      },
      { once: true },
    );
    send({ method, id, params });
  });

class Cancelled extends Error {}
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Cancelled());
    const t = setTimeout(resolve, ms * speed);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Cancelled());
      },
      { once: true },
    );
  });

/** @type {Map<string, {state: Record<string, unknown>, turn?: {id: string, abort: AbortController}, resumed: boolean}>} */
const threads = new Map();
const statePath = (id) => join(stateDir, `${id.replace(/[^\w-]/g, '_')}.json`);
const save = (id) => writeFileSync(statePath(id), JSON.stringify(threads.get(id).state));
const uid = (p) => `${p}-${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
let initialized = false;

const MODELS = [
  {
    id: 'gpt-6-luna',
    model: 'gpt-6-luna',
    displayName: 'GPT-6-Luna',
    hidden: false,
    isDefault: true,
  },
  {
    id: 'gpt-5.6-terra',
    model: 'gpt-5.6-terra',
    displayName: 'GPT-5.6-Terra',
    hidden: false,
    isDefault: false,
  },
  {
    id: 'gpt-5.6-luna',
    model: 'gpt-5.6-luna',
    displayName: 'GPT-5.6-Luna',
    hidden: false,
    isDefault: false,
  },
  {
    id: 'codex-internal',
    model: 'codex-internal',
    displayName: 'Internal',
    hidden: true,
    isDefault: false,
  },
].map((m) => ({ ...m, inputModalities: ['text', 'image'], defaultReasoningEffort: 'medium' }));
let limitHit = false;
const rateLimits = () => {
  const snapshot = {
    limitId: 'codex',
    primary: {
      usedPercent: limitHit ? 100 : 1,
      windowDurationMins: 43200,
      resetsAt: Number(process.env.FAKE_CODEX_RESETS_AT ?? 1796027861),
    },
    secondary: null,
    planType: process.env.FAKE_CODEX_PLAN ?? 'free',
    rateLimitReachedType: limitHit ? 'rate_limit_reached' : null,
  };
  return {
    ordinaryUsageAllowed: !limitHit,
    rateLimits: snapshot,
    rateLimitsByLimitId: { codex: snapshot },
  };
};

const threadObject = (id, state) => ({
  id,
  cwd: state.cwd,
  model: state.model ?? 'gpt-6-luna',
  status: { type: 'idle' },
  cliVersion: '0.166.0',
  turns: [],
});
const threadResult = (id, state) => ({
  thread: threadObject(id, state),
  model: state.model ?? 'gpt-6-luna',
  approvalPolicy: state.approvalPolicy ?? 'untrusted',
  approvalsReviewer: 'user',
  sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false },
});

const METHODS = {
  initialize: (params) => {
    if (params?.capabilities?.experimentalApi !== true) {
      throw rpcError(-32600, 'dynamicTools requires capabilities.experimentalApi');
    }
    return {
      userAgent: 'fake/0.166.0',
      codexHome: '/Users/example/.codex',
      platformFamily: 'unix',
      platformOs: 'macos',
    };
  },
  'thread/start': (params) => {
    if (!initialized) throw rpcError(-32600, 'not initialized');
    const id = uid('fake-thread');
    threads.set(id, {
      state: {
        cwd: params.cwd,
        model: params.model ?? undefined,
        approvalPolicy: params.approvalPolicy,
        turns: 0,
        scenario: undefined,
        pending: false,
        tools: (params.dynamicTools ?? []).map((t) => t.name),
      },
      resumed: false,
    });
    save(id);
    setImmediate(() =>
      notify('thread/started', { thread: threadObject(id, threads.get(id).state) }),
    );
    return threadResult(id, threads.get(id).state);
  },
  'thread/resume': (params) => {
    let state;
    try {
      state = JSON.parse(readFileSync(statePath(params.threadId), 'utf8'));
    } catch {
      throw rpcError(-32600, `no rollout found for thread id ${params.threadId}`);
    }
    if (params.model) state.model = params.model;
    threads.set(params.threadId, { state, resumed: true });
    return threadResult(params.threadId, state);
  },
  'turn/start': (params) => {
    const thread = threads.get(params.threadId);
    if (!thread) throw rpcError(-32600, `thread not found: ${params.threadId}`);
    if (thread.turn) throw rpcError(-32600, 'a turn is already running');
    if (params.model) thread.state.model = params.model;
    const text = (params.input ?? [])
      .map((i) => (i.type === 'text' ? i.text : ''))
      .join('\n')
      .trim();
    const turnId = uid('fake-turn');
    const abort = new AbortController();
    thread.turn = { id: turnId, abort };
    setImmediate(() => void runTurn(params.threadId, thread, turnId, abort.signal, text));
    return { turn: { id: turnId, items: [], status: 'inProgress', error: null } };
  },
  'turn/interrupt': (params) => {
    const thread = threads.get(params.threadId);
    if (thread?.turn && thread.turn.id === params.turnId) thread.turn.abort.abort();
    return {};
  },
  'model/list': () => ({ data: MODELS, nextCursor: null }),
  'account/read': () => ({
    account: {
      type: 'chatgpt',
      email: 'user@example.com',
      planType: process.env.FAKE_CODEX_PLAN ?? 'free',
      workspaceName: null,
    },
    requiresOpenaiAuth: true,
  }),
  'account/rateLimits/read': () => rateLimits(),
};

function rpcError(code, message) {
  const e = new Error(message);
  e.rpc = { code, message };
  return e;
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  record({ in: msg });
  if (msg.method === 'initialized') {
    initialized = true;
    return;
  }
  if (msg.method !== undefined && msg.id !== undefined) {
    const handler = METHODS[msg.method];
    if (!handler) {
      send({ id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
      return;
    }
    try {
      send({ id: msg.id, result: handler(msg.params ?? {}) });
    } catch (error) {
      send({ id: msg.id, error: error.rpc ?? { code: -32603, message: String(error.message) } });
    }
    return;
  }
  if (msg.id !== undefined && msg.method === undefined) {
    const wait = serverWaits.get(msg.id);
    if (!wait) return;
    serverWaits.delete(msg.id);
    if (msg.error) wait.reject(new Error(msg.error.message));
    else wait.resolve(msg.result);
  }
});
process.stdin.on('end', () => process.exit(0));

// --- turns ----------------------------------------------------------------------------------

async function runTurn(threadId, thread, turnId, signal, text) {
  const { state } = thread;
  const ids = { threadId, turnId };
  notify('turn/started', { threadId, turn: { id: turnId, items: [], status: 'inProgress' } });
  let scenario;
  if (state.turns === 0) {
    scenario = /scenario:([\w-]+)/.exec(text)?.[1] ?? 'echo';
    state.scenario = scenario;
  } else if (thread.resumed && state.pending) {
    scenario = state.scenario;
  }
  thread.resumed = false;
  state.turns += 1;
  save(threadId);

  const ctx = { ...ids, state, signal, text };
  let status = 'completed';
  let error = null;
  try {
    if (scenario) {
      state.pending = true;
      save(threadId);
      const run = scenario.startsWith('replay-') ? replay(scenario.slice(7)) : SCENARIOS[scenario];
      if (!run) throw new Error(`no scenario ${scenario}`);
      const result = await run(ctx);
      if (result?.failed) {
        status = 'failed';
        error = result.failed;
      }
      state.pending = false;
    } else {
      await sleep(10, signal);
      await message(ctx, `echo: ${text}`);
    }
  } catch (e) {
    if (!(e instanceof Cancelled) && !signal.aborted) {
      status = 'failed';
      error = { message: String(e.message), codexErrorInfo: 'other', additionalDetails: null };
    }
  }
  if (signal.aborted) status = 'interrupted';
  if (thread.turn?.id === turnId) thread.turn = undefined;
  save(threadId);
  notify('turn/completed', { threadId, turn: { id: turnId, items: [], status, error } });
}

const item = (ctx, method, it) =>
  notify(method, { item: it, threadId: ctx.threadId, turnId: ctx.turnId });

/** An agent message, streamed in deltas (the adapter must not take them as blocks). */
async function message(ctx, text) {
  const id = uid('msg');
  item(ctx, 'item/started', { type: 'agentMessage', id, text: '' });
  for (const delta of text.split(/(?<= )/)) {
    notify('item/agentMessage/delta', {
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      itemId: id,
      delta,
    });
  }
  item(ctx, 'item/completed', { type: 'agentMessage', id, text, phase: 'final_answer' });
}

/** A shell command behind an approval request; resolves with the client's decision. */
async function command(ctx, script, output = '') {
  const id = uid('exec');
  const cmd = `/bin/zsh -lc '${script.replace(/'/g, `'\\''`)}'`;
  const base = {
    type: 'commandExecution',
    id,
    command: cmd,
    cwd: ctx.state.cwd,
    commandActions: [{ type: 'unknown', command: script }],
  };
  item(ctx, 'item/started', {
    ...base,
    status: 'inProgress',
    aggregatedOutput: null,
    exitCode: null,
  });
  const reply = await serverRequest(
    'item/commandExecution/requestApproval',
    {
      kind: 'command',
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      itemId: id,
      startedAtMs: Date.now(),
      environmentId: 'local',
      command: cmd,
      cwd: ctx.state.cwd,
      commandActions: [{ type: 'unknown', command: script }],
      proposedExecpolicyAmendment: script.split(' '),
      availableDecisions: [
        'accept',
        { acceptWithExecpolicyAmendment: { execpolicy_amendment: script.split(' ') } },
        'cancel',
      ],
    },
    ctx.signal,
  );
  const decision = reply?.decision;
  notify('serverRequest/resolved', { threadId: ctx.threadId, requestId: nextServerId - 1 });
  if (decision === 'cancel') {
    item(ctx, 'item/completed', {
      ...base,
      status: 'declined',
      aggregatedOutput: null,
      exitCode: null,
    });
    throw new Cancelled();
  }
  if (decision !== 'accept') {
    item(ctx, 'item/completed', {
      ...base,
      status: 'declined',
      aggregatedOutput: null,
      exitCode: null,
    });
    return decision;
  }
  await sleep(10, ctx.signal);
  item(ctx, 'item/completed', {
    ...base,
    status: 'completed',
    aggregatedOutput: output,
    exitCode: 0,
    durationMs: 10,
  });
  return decision;
}

const plan = (ctx, steps) =>
  notify('turn/plan/updated', {
    threadId: ctx.threadId,
    turnId: ctx.turnId,
    explanation: null,
    plan: steps.map(([step, status]) => ({ step, status })),
  });

/** `request_user_input`; resolves with the answers object. */
const askUser = (ctx, questions) =>
  serverRequest(
    'item/tool/requestUserInput',
    {
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      itemId: uid('ask'),
      questions,
      isBlocking: true,
      autoResolutionMs: null,
    },
    ctx.signal,
  );

const SCENARIOS = {
  /** Output, a command the gate allows, a plan, reasoning, done. */
  happy: async (ctx) => {
    await message(ctx, 'Reading the README to get started.');
    plan(ctx, [
      ['read the README', 'completed'],
      ['report', 'inProgress'],
    ]);
    await command(ctx, 'cat README.md', '# readme');
    item(ctx, 'item/completed', {
      type: 'reasoning',
      id: uid('rs'),
      summary: ['Thinking about it.'],
      content: [],
    });
    await message(ctx, 'done');
  },
  /**
   * One clarification question through the adapter's `ask_user` dynamic tool (ruling R6): the
   * way a real Codex Steward asks outside plan mode. Fails when the thread was not given it.
   */
  asks: async (ctx) => {
    if (!ctx.state.tools.includes('ask_user')) throw new Error('ask_user is not registered');
    await message(ctx, 'I need to know one thing first.');
    const callId = uid('exec');
    const args = {
      question: 'Which option do you prefer?',
      options: ['first option', 'second option'],
    };
    item(ctx, 'item/started', {
      type: 'dynamicToolCall',
      id: callId,
      namespace: null,
      tool: 'ask_user',
      arguments: args,
      status: 'inProgress',
    });
    const reply = await serverRequest(
      'item/tool/call',
      {
        threadId: ctx.threadId,
        turnId: ctx.turnId,
        callId,
        namespace: null,
        tool: 'ask_user',
        arguments: args,
      },
      ctx.signal,
    );
    item(ctx, 'item/completed', {
      type: 'dynamicToolCall',
      id: callId,
      namespace: null,
      tool: 'ask_user',
      arguments: args,
      status: 'completed',
      contentItems: reply?.contentItems ?? null,
      success: reply?.success ?? null,
    });
    const answer = reply?.success ? reply.contentItems?.[0]?.text : undefined;
    await message(ctx, answer ? `You chose: ${answer}` : 'No answer; carrying on.');
  },
  /** One clarification question through `request_user_input` (Codex's plan mode only). */
  'asks-input': async (ctx) => {
    await message(ctx, 'I need to know one thing first.');
    const reply = await askUser(ctx, [
      {
        id: 'choice',
        header: 'Option',
        question: 'Which option do you prefer?',
        isOther: true,
        isSecret: false,
        options: [
          { label: 'first option', description: 'The first one' },
          { label: 'second option', description: 'The second one' },
        ],
      },
    ]);
    const answer = reply?.answers?.choice?.answers?.join(', ');
    await message(ctx, answer ? `You chose: ${answer}` : 'No answer; carrying on.');
  },
  /** Three questions in one ask: a question set (P8-20). */
  'asks-set': async (ctx) => {
    await message(ctx, 'A few details before I start.');
    const reply = await askUser(ctx, [
      {
        id: 'format',
        header: 'Date format',
        question: 'Which date format?',
        isOther: false,
        isSecret: false,
        options: [
          { label: 'ISO 8601', description: '' },
          { label: 'US', description: '' },
          { label: 'EU', description: '' },
        ],
      },
      {
        id: 'columns',
        header: 'Columns',
        question: 'Which columns?',
        isOther: true,
        isSecret: false,
        options: [
          { label: 'date', description: '' },
          { label: 'amount', description: '' },
          { label: 'note', description: '' },
        ],
      },
      {
        id: 'note',
        header: 'Note',
        question: 'Anything else?',
        isOther: true,
        isSecret: false,
        options: null,
      },
    ]);
    await message(ctx, `set: ${JSON.stringify(reply?.answers ?? {})}`);
  },
  /** One command the default table asks about (a recursive delete). */
  permission: async (ctx) => {
    await message(ctx, 'Cleaning the build directory.');
    const decision = await command(ctx, `rm -r ${join(ctx.state.cwd, 'build')}`, 'deleted build');
    await message(ctx, decision === 'accept' ? 'cleaned' : 'I was not allowed to clean.');
  },
  /** Several steps over about a second, each a command and a progress update. */
  long: async (ctx) => {
    for (let i = 1; i <= 6; i++) {
      plan(ctx, [[`step ${i}`, 'inProgress']]);
      await command(ctx, `echo step ${i}`, `step ${i}`);
      await sleep(200, ctx.signal);
    }
    await message(ctx, 'finished');
  },
  echo: async (ctx) => {
    await sleep(10, ctx.signal);
    await message(ctx, 'ready');
  },
  /** Silent for a second mid-turn, then carries on. */
  stalls: async (ctx) => {
    await message(ctx, 'Starting a slow step.');
    await sleep(1000, ctx.signal);
    await message(ctx, 'back');
  },
  /** A dynamic tool call (`tool:<name>` in the prompt, default `request_publish`). */
  tool: async (ctx) => {
    const name = /tool:([\w-]+)/.exec(ctx.text)?.[1] ?? 'request_publish';
    const callId = uid('exec');
    const args = { text: 'hello' };
    item(ctx, 'item/started', {
      type: 'dynamicToolCall',
      id: callId,
      namespace: null,
      tool: name,
      arguments: args,
      status: 'inProgress',
    });
    const reply = await serverRequest(
      'item/tool/call',
      {
        threadId: ctx.threadId,
        turnId: ctx.turnId,
        callId,
        namespace: null,
        tool: name,
        arguments: args,
      },
      ctx.signal,
    );
    item(ctx, 'item/completed', {
      type: 'dynamicToolCall',
      id: callId,
      namespace: null,
      tool: name,
      arguments: args,
      status: 'completed',
      contentItems: reply?.contentItems ?? null,
      success: reply?.success ?? null,
    });
    await message(
      ctx,
      `tool said: ${reply?.contentItems?.[0]?.text ?? '(nothing)'} success=${reply?.success}`,
    );
  },
  /** An MCP server's form elicitation (MCP is off: the adapter declines). */
  elicit: async (ctx) => {
    const reply = await serverRequest(
      'mcpServer/elicitation/request',
      {
        threadId: ctx.threadId,
        turnId: ctx.turnId,
        serverName: 'some_server',
        mode: 'form',
        _meta: null,
        message: 'Pick one',
        requestedSchema: { type: 'object', properties: { a: { type: 'string' } } },
      },
      ctx.signal,
    );
    await message(ctx, `elicitation: ${reply?.action}`);
  },
  /** The subscription's usage limit (P11-01 notes, Codex 8). */
  limit: async (ctx) => {
    await message(ctx, 'Working on it.');
    limitHit = true;
    const error = {
      message: "You've hit your usage limit. Upgrade to Plus to continue using Codex",
      codexErrorInfo: 'usageLimitExceeded',
      additionalDetails: null,
    };
    notify('error', { error, willRetry: false, threadId: ctx.threadId, turnId: ctx.turnId });
    return { failed: error };
  },
  /** The usage limit, then the process dies before the adapter can read the reset time. */
  'limit-dies': async (ctx) => {
    const params = {
      error: {
        message: "You've hit your usage limit.",
        codexErrorInfo: 'usageLimitExceeded',
        additionalDetails: null,
      },
      willRetry: false,
      threadId: ctx.threadId,
      turnId: ctx.turnId,
    };
    // Gone as soon as the line is out: the adapter's rate-limit read finds no process.
    process.stdout.write(`${JSON.stringify({ method: 'error', params })}\n`, () => process.exit(1));
    await new Promise(() => {});
  },
  /** A non-limit error that fails the turn. */
  error: async (ctx) => {
    const error = {
      message: 'stream disconnected before completion',
      codexErrorInfo: 'other',
      additionalDetails: null,
    };
    notify('error', { error, willRetry: false, threadId: ctx.threadId, turnId: ctx.turnId });
    return { failed: error };
  },
  /** A patch on two files behind one approval; the paths are only on the started item. */
  file: async (ctx) => {
    const id = uid('exec');
    const changes = [
      { path: join(ctx.state.cwd, 'hello.txt'), kind: { type: 'add' }, diff: 'hi\n' },
      {
        path: join(ctx.state.cwd, 'README.md'),
        kind: { type: 'update', move_path: null },
        diff: '@@ -1 +1 @@\n',
      },
    ];
    item(ctx, 'item/started', { type: 'fileChange', id, changes, status: 'inProgress' });
    const reply = await serverRequest(
      'item/fileChange/requestApproval',
      {
        threadId: ctx.threadId,
        turnId: ctx.turnId,
        itemId: id,
        startedAtMs: Date.now(),
        reason: null,
        grantRoot: null,
      },
      ctx.signal,
    );
    const ok = reply?.decision === 'accept';
    item(ctx, 'item/completed', {
      type: 'fileChange',
      id,
      changes,
      status: ok ? 'completed' : 'declined',
    });
    await message(ctx, ok ? 'patched' : 'patch refused');
  },
  /** The agent asks for network access. */
  perms: async (ctx) => {
    const reply = await serverRequest(
      'item/permissions/requestApproval',
      {
        threadId: ctx.threadId,
        turnId: ctx.turnId,
        itemId: uid('perm'),
        environmentId: 'local',
        startedAtMs: Date.now(),
        cwd: ctx.state.cwd,
        reason: 'needs the network',
        permissions: { network: { enabled: true }, fileSystem: null },
      },
      ctx.signal,
    );
    await message(
      ctx,
      `granted: ${JSON.stringify(reply?.permissions ?? {})} scope=${reply?.scope}`,
    );
  },
  /** The `node_repl` MCP tool, run without any approval (P11-01 notes, Codex 2). */
  unasked: async (ctx) => {
    const id = uid('exec');
    const base = {
      type: 'mcpToolCall',
      id,
      server: 'node_repl',
      tool: 'js',
      arguments: { code: '1+1' },
      readOnlyHint: true,
    };
    item(ctx, 'item/started', { ...base, status: 'inProgress', result: null, error: null });
    await sleep(10, ctx.signal);
    item(ctx, 'item/completed', {
      ...base,
      status: 'completed',
      result: { content: [{ type: 'text', text: '2' }] },
      error: null,
    });
    await message(ctx, 'computed');
  },
  /** The process dies mid-turn. */
  dies: async (ctx) => {
    await message(ctx, 'about to die');
    process.exit(3);
  },
};

/**
 * A P11-01 transcript replayed: every server message after the response to the recorded
 * `turn/start`, with the recorded thread, turn and workspace replaced by this one's. A server
 * request waits for the client's reply; the transcript then goes on as recorded.
 */
function replay(name) {
  return async (ctx) => {
    const lines = readFileSync(join(HERE, 'fixtures', `${name}.jsonl`), 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    const turnStart = lines.find((l) => l.dir === 'out' && l.msg?.method === 'turn/start');
    if (!turnStart) throw new Error(`fixture ${name} has no turn/start`);
    const startIndex = lines.findIndex(
      (l) => l.dir === 'in' && l.msg?.id === turnStart.msg.id && l.msg.method === undefined,
    );
    const turnResponse = lines[startIndex].msg.result.turn;
    const from = { thread: turnStart.msg.params.threadId, turn: turnResponse.id };
    const rewrite = (value) =>
      JSON.parse(
        JSON.stringify(value)
          .split(from.thread)
          .join(ctx.threadId)
          .split(from.turn)
          .join(ctx.turnId)
          .split('/tmp/work')
          .join(ctx.state.cwd),
      );
    for (const line of lines.slice(startIndex + 1)) {
      if (line.dir !== 'in' || typeof line.msg !== 'object') continue;
      const { _t, emittedAtMs: _emitted, ...msg } = line.msg;
      if (msg.method === 'turn/started' || msg.method === 'turn/completed') continue; // ours
      if (msg.method === undefined) continue; // a response to a recorded request
      if (ctx.signal.aborted) throw new Cancelled();
      if (msg.id !== undefined) {
        const reply = await serverRequest(msg.method, rewrite(msg.params), ctx.signal);
        if (reply?.decision === 'cancel') throw new Cancelled();
      } else {
        notify(msg.method, rewrite(msg.params));
      }
      await sleep(1, ctx.signal);
    }
  };
}
