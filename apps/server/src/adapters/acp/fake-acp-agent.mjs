#!/usr/bin/env node
// The fake ACP agent (P8-07): a scripted Agent Client Protocol agent over stdio, no network, no
// model. It implements just enough of ACP v1 — through the official SDK's agent side — for the
// adapter conformance suite and the ACP adapter's own tests, and it asserts on the client
// capability set the adapter advertises (TECHNOLOGY §3.2): `elicitation.form` must be offered,
// `fs/*` and `terminal/*` must not be.
//
//   node fake-acp-agent.mjs [--state <dir>] [--no-load] [--no-cost] [--speed <factor>]
//                           [--mode <id>] [--config-modes] [--commands]
//
// `--mode <id>` gives every session ACP session modes (`default`, `plan`, `acceptEdits`,
// `bypassPermissions`), starting in `<id>`, settable with `session/set_mode`; `--config-modes`
// offers the same modes as a `mode` config option instead (`session/set_config_option`).
// `--commands` announces slash commands (`available_commands_update`, P8-13) right after a
// session is created or loaded.
//
// The first prompt of a session picks the scenario (`scenario:<name>` anywhere in it; anything
// else runs `echo`); every later prompt is echoed ("echo: <prompt>"), except the first prompt
// after a `session/load` of a session whose scenario never finished: that one runs the scenario
// again (a resumed `asks` asks again). Sessions persist as JSON under the state directory, so a
// new process can load them. The process exits when its stdin closes.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const stateDir = option(
  '--state',
  process.env['GALACTIC_FAKE_ACP_STATE'] ?? join(tmpdir(), 'galactic-fake-acp'),
);
const canLoad = !flag('--no-load');
const reportsCost = !flag('--no-cost');
const speed = Number(option('--speed', '1'));
const startMode = option('--mode', undefined);
const configModes = flag('--config-modes');
const announcesCommands = flag('--commands');
/** What `--commands` announces: one with an input hint, one without. */
const COMMANDS = [
  { name: 'research_codebase', description: 'Research the codebase', input: { hint: '<topic>' } },
  { name: 'create_plan', description: 'Write a plan\nfor the task' },
];
/** Announces the commands once the session/new or session/load response is out. */
function announceCommands(client, sessionId) {
  if (!announcesCommands) return;
  setTimeout(() => {
    void client
      .notify(acp.methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: 'available_commands_update', availableCommands: COMMANDS },
      })
      .catch(() => {});
  }, 0);
}
const MODES = [
  { id: 'default', name: 'Default' },
  { id: 'plan', name: 'Plan Mode' },
  { id: 'acceptEdits', name: 'Accept Edits' },
  { id: 'bypassPermissions', name: 'Bypass Permissions' },
];
/** The mode fields of a session/new or session/load response. */
function modesOf(current) {
  if (current === undefined) return {};
  if (configModes) {
    return {
      configOptions: [
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: current,
          options: MODES.map((m) => ({ value: m.id, name: m.name })),
        },
      ],
    };
  }
  return { modes: { currentModeId: current, availableModes: MODES } };
}
mkdirSync(stateDir, { recursive: true });

/** @type {Map<string, {state: Record<string, unknown>, turn?: AbortController, loaded: boolean}>} */
const sessions = new Map();
const statePath = (id) => join(stateDir, `${id.replace(/[^\w-]/g, '_')}.json`);
const save = (id) => writeFileSync(statePath(id), JSON.stringify(sessions.get(id).state));

class Cancelled extends Error {}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Cancelled());
    const t = setTimeout(resolve, ms * speed);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Cancelled());
      },
      { once: true },
    );
  });

/** The capability set the adapter must advertise (TECHNOLOGY §3.2). */
function checkCapabilities(caps) {
  const problems = [];
  if (!caps?.elicitation?.form) problems.push('elicitation.form is not advertised');
  if (caps?.fs?.readTextFile || caps?.fs?.writeTextFile) problems.push('fs/* is advertised');
  if (caps?.terminal) problems.push('terminal/* is advertised');
  return problems;
}

const app = acp.agent({ name: 'galactic-fake-acp' });

app.onRequest(acp.methods.agent.initialize, ({ params }) => {
  const problems = checkCapabilities(params.clientCapabilities);
  if (problems.length > 0) {
    throw acp.RequestError.invalidParams(undefined, `unexpected client capabilities: ${problems}`);
  }
  return {
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: canLoad },
    agentInfo: { name: 'galactic-fake-acp', version: '1.0.0' },
  };
});

app.onRequest(acp.methods.agent.session.new, ({ params, client }) => {
  const id = `fake-${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  sessions.set(id, {
    state: {
      cwd: params.cwd,
      turns: 0,
      cost: 0,
      scenario: undefined,
      pending: false,
      mode: startMode,
      meta: params._meta ?? null,
    },
    loaded: false,
  });
  save(id);
  announceCommands(client, id);
  return { sessionId: id, ...modesOf(startMode) };
});

app.onRequest(acp.methods.agent.session.setMode, ({ params }) => {
  const session = sessions.get(params.sessionId);
  if (!session) throw acp.RequestError.resourceNotFound(params.sessionId);
  if (!MODES.some((m) => m.id === params.modeId)) throw acp.RequestError.invalidParams();
  session.state.mode = params.modeId;
  save(params.sessionId);
  return {};
});

app.onRequest(acp.methods.agent.session.setConfigOption, ({ params }) => {
  const session = sessions.get(params.sessionId);
  if (!session) throw acp.RequestError.resourceNotFound(params.sessionId);
  if (params.configId !== 'mode' || !MODES.some((m) => m.id === params.value)) {
    throw acp.RequestError.invalidParams();
  }
  session.state.mode = params.value;
  save(params.sessionId);
  return modesOf(params.value);
});

app.onRequest(acp.methods.agent.session.load, async ({ params, client }) => {
  if (!canLoad) throw acp.RequestError.methodNotFound(acp.methods.agent.session.load);
  let state;
  try {
    state = JSON.parse(readFileSync(statePath(params.sessionId), 'utf8'));
  } catch {
    throw acp.RequestError.resourceNotFound(params.sessionId);
  }
  state.loadMeta = params._meta ?? null;
  sessions.set(params.sessionId, { state, loaded: true });
  // ACP replays the conversation before answering a load; the client must not take it as new.
  for (const update of [
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'replayed prompt' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replayed answer' } },
  ]) {
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update,
    });
  }
  announceCommands(client, params.sessionId);
  return modesOf(state.mode);
});

app.onNotification(acp.methods.agent.session.cancel, ({ params }) => {
  sessions.get(params.sessionId)?.turn?.abort();
});

app.onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
  const session = sessions.get(params.sessionId);
  if (!session) throw acp.RequestError.resourceNotFound(params.sessionId);
  const text = params.prompt
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('\n')
    .trim();
  const turn = new AbortController();
  session.turn = turn;
  const id = params.sessionId;
  const { state } = session;
  const say = (t, kind = 'agent_message_chunk') =>
    client.notify(acp.methods.client.session.update, {
      sessionId: id,
      update: { sessionUpdate: kind, content: { type: 'text', text: t } },
    });
  // Streamed like a model: a block in several chunks (the adapter must join them).
  const stream = async (t) => {
    const words = t.split(/(?<= )/);
    for (const w of words) await say(w);
  };
  const update = (u) =>
    client.notify(acp.methods.client.session.update, { sessionId: id, update: u });
  const ctx = { id, state, turn, client, say, stream, update, signal: turn.signal };

  let scenario;
  if (state.turns === 0) {
    scenario = /scenario:(\w[\w-]*)/.exec(text)?.[1] ?? 'echo';
    state.scenario = scenario;
  } else if (session.loaded && state.pending) {
    scenario = state.scenario;
  }
  session.loaded = false;
  state.turns += 1;
  save(id);

  let stopReason = 'end_turn';
  try {
    if (scenario) {
      state.pending = true;
      save(id);
      const run = SCENARIOS[scenario];
      if (!run) throw acp.RequestError.invalidParams(undefined, `no scenario ${scenario}`);
      stopReason = (await run(ctx, text)) ?? 'end_turn';
      state.pending = stopReason === 'cancelled';
    } else {
      await sleep(20, turn.signal);
      await stream(`echo: ${text}`);
    }
  } catch (error) {
    if (!(error instanceof Cancelled) && !turn.signal.aborted) throw error;
    stopReason = 'cancelled';
  } finally {
    if (session.turn === turn) session.turn = undefined;
  }
  if (turn.signal.aborted) stopReason = 'cancelled';
  if (reportsCost) {
    state.cost = Math.round((state.cost + 0.0021) * 10_000) / 10_000;
    await update({
      sessionUpdate: 'usage_update',
      used: 1000 * state.turns,
      size: 200_000,
      cost: { amount: state.cost, currency: 'USD' },
    });
  }
  save(id);
  return {
    stopReason,
    ...(reportsCost ? { usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } } : {}),
  };
});

/** A tool call the agent runs without asking for permission (reads, mostly). */
async function runTool(ctx, toolCallId, call, result) {
  await ctx.update({ sessionUpdate: 'tool_call', toolCallId, status: 'pending', ...call });
  await sleep(10, ctx.signal);
  await ctx.update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress' });
  await sleep(10, ctx.signal);
  await ctx.update({
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: result } }],
  });
}

/** A tool call the agent asks permission for; resolves whether it ran. */
async function askToRun(ctx, toolCallId, call) {
  await ctx.update({ sessionUpdate: 'tool_call', toolCallId, status: 'pending', ...call });
  const response = await ctx.client.request(
    acp.methods.client.session.requestPermission,
    {
      sessionId: ctx.id,
      toolCall: { toolCallId, ...call },
      options: [
        { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    },
    { signal: ctx.signal },
  );
  if (response.outcome.outcome === 'cancelled') throw new Cancelled();
  if (response.outcome.optionId === 'always') throw new Error('the client chose allow_always');
  if (response.outcome.optionId !== 'allow') {
    await ctx.update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'failed' });
    return false;
  }
  await ctx.update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress' });
  await sleep(10, ctx.signal);
  await ctx.update({
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
  });
  return true;
}

/** A form elicitation; resolves with the accepted content, or `undefined`. */
async function elicit(ctx, message, properties, required, toolCallId) {
  const response = await ctx.client.request(
    acp.methods.client.elicitation.create,
    {
      sessionId: ctx.id,
      mode: 'form',
      ...(toolCallId ? { toolCallId } : {}),
      message,
      requestedSchema: { type: 'object', properties, ...(required ? { required } : {}) },
    },
    { signal: ctx.signal },
  );
  if (ctx.signal.aborted || response.action === 'cancel') throw new Cancelled();
  return response.action === 'accept' ? (response.content ?? {}) : undefined;
}

const SCENARIOS = {
  /** Output, a read, a plan, done. */
  happy: async (ctx) => {
    await ctx.stream('Reading the README to get started.');
    await runTool(
      ctx,
      'read-1',
      {
        title: 'Read README.md',
        kind: 'read',
        locations: [{ path: join(ctx.state.cwd, 'README.md') }],
        rawInput: { path: join(ctx.state.cwd, 'README.md') },
      },
      '# readme',
    );
    await ctx.update({
      sessionUpdate: 'plan',
      entries: [
        { content: 'read the README', priority: 'high', status: 'completed' },
        { content: 'report', priority: 'medium', status: 'in_progress' },
      ],
    });
    await ctx.say('Thinking about it.', 'agent_thought_chunk');
    await ctx.stream('done');
  },
  /** One clarification question through form elicitation. */
  asks: async (ctx) => {
    await ctx.stream('I need to know one thing first.');
    const content = await elicit(
      ctx,
      'Which option do you prefer?',
      { choice: { type: 'string', title: 'Option', enum: ['first option', 'second option'] } },
      ['choice'],
    );
    await ctx.stream(content ? `You chose: ${content.choice}` : 'No answer; carrying on.');
  },
  /**
   * `claude-agent-acp`'s question (real trace, P8-07): an `AskUserQuestion` tool call (kind
   * `other`, never asked about), a form elicitation naming it — the choice and its optional
   * "Other" box, nothing required — then the call completes with the answer.
   */
  asksTool: async (ctx) => {
    const toolCallId = 'toolu_ask';
    const meta = { claudeCode: { toolName: 'AskUserQuestion' } };
    await ctx.update({
      sessionUpdate: 'tool_call',
      toolCallId,
      _meta: meta,
      title: 'Asking for your input',
      kind: 'other',
      status: 'pending',
      rawInput: {},
      content: [],
    });
    const option = (label) => ({ const: label, title: label, description: `Choose the ${label}` });
    const content = await elicit(
      ctx,
      'Which option do you prefer?',
      {
        question_0: {
          type: 'string',
          title: 'Option',
          oneOf: [option('First option'), option('Second option')],
        },
        question_0_custom: {
          type: 'string',
          title: 'Other',
          description:
            'Type your own answer, or add a note to the option you chose above (optional).',
        },
      },
      undefined,
      toolCallId,
    );
    const answer = content?.question_0 ?? content?.question_0_custom ?? 'nothing';
    await ctx.update({
      sessionUpdate: 'tool_call_update',
      toolCallId,
      _meta: meta,
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: `answered: ${answer}` } }],
    });
    await ctx.stream(`You chose: ${answer}`);
  },
  /**
   * A call the agent's own rules refuse before it runs (`claude-agent-acp`, real trace, P8-07): the
   * call is announced, then reported `failed` with the denial marker — no permission request.
   */
  refusesItself: async (ctx) => {
    const toolCallId = 'toolu_refused';
    const command = 'rm -rf scratch-dir';
    await ctx.update({
      sessionUpdate: 'tool_call',
      toolCallId,
      title: 'Terminal',
      kind: 'execute',
      status: 'pending',
      rawInput: {},
    });
    await ctx.update({
      sessionUpdate: 'tool_call_update',
      toolCallId,
      rawInput: { command },
      title: command,
    });
    await ctx.update({
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'failed',
      content: [
        {
          type: 'content',
          content: {
            type: 'text',
            text: `Permission denied: Permission to use Bash with command ${command} has been denied.`,
          },
        },
      ],
      _meta: {
        claudeCode: { toolName: 'Bash', toolResponse: { decisionReasonType: 'subcommandResults' } },
      },
    });
    await sleep(100, ctx.signal);
    await ctx.stream('I could not run it.');
  },
  /** A destructive command behind a permission request; finishes either way. */
  permission: async (ctx) => {
    await ctx.stream('Cleaning the build output.');
    const ran = await askToRun(ctx, 'rm-1', {
      title: 'rm -rf dist',
      kind: 'execute',
      rawInput: { command: 'rm -rf dist' },
    });
    await ctx.stream(ran ? 'cleaned' : 'Skipped: the permission was refused.');
  },
  /** Many steps with plan updates and reads; cancellable at every step. */
  long: async (ctx) => {
    const total = 14;
    for (let i = 1; i <= total; i++) {
      await sleep(110, ctx.signal);
      await ctx.update({
        sessionUpdate: 'plan',
        entries: Array.from({ length: total }, (_, k) => ({
          content: `step ${k + 1}`,
          priority: 'medium',
          status: k + 1 < i ? 'completed' : k + 1 === i ? 'in_progress' : 'pending',
        })),
      });
      if (i % 3 === 0) {
        await runTool(
          ctx,
          `read-${i}`,
          { title: `Read file ${i}`, kind: 'read', locations: [{ path: `src/file${i}.ts` }] },
          `contents ${i}`,
        );
      }
    }
    await ctx.stream('finished');
  },
  /** Says the `_meta` its session was created (and last loaded) with. */
  meta: async (ctx) => {
    await ctx.stream(`meta: ${JSON.stringify(ctx.state.meta)}`);
  },
  /** A short first turn; every later prompt is echoed. */
  echo: async (ctx) => {
    await sleep(20, ctx.signal);
    await ctx.stream('ready');
  },
  /** Falls silent while working, then carries on. */
  stalls: async (ctx) => {
    await runTool(
      ctx,
      'read-s',
      { title: 'Read notes', kind: 'read', locations: [{ path: 'notes.md' }] },
      'notes',
    );
    await sleep(700, ctx.signal);
    await ctx.stream('back again');
  },
  /** Runs a command without asking for permission (the agent's own mode allowed it). */
  unasked: async (ctx, text) => {
    const command = /command:(.+)$/m.exec(text)?.[1]?.trim() ?? 'git push origin main';
    await runTool(ctx, 'exec-1', { title: command, kind: 'execute', rawInput: { command } }, 'ok');
    await sleep(300, ctx.signal);
    await ctx.stream('after the command');
  },
  /** Switches itself to `bypassPermissions` mid-turn (or the mode named `mode:<id>`). */
  switches: async (ctx, text) => {
    const mode = /mode:(\w+)/.exec(text)?.[1] ?? 'bypassPermissions';
    await ctx.stream('Switching modes.');
    ctx.state.mode = mode;
    await ctx.update({ sessionUpdate: 'current_mode_update', currentModeId: mode });
    await sleep(300, ctx.signal);
    await ctx.stream('after the switch');
  },
  /** A tool call whose input changes after it started: `ls`, then `git push origin main`. */
  rewrites: async (ctx) => {
    await ctx.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'exec-r',
      title: 'Run a command',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: 'ls' },
    });
    await sleep(10, ctx.signal);
    await ctx.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'exec-r',
      rawInput: { command: 'git push origin main' },
    });
    await sleep(300, ctx.signal);
    await ctx.stream('after the command');
  },
  /** A tool call that fails at once, without asking first (`failed` is its first status). */
  failsUnasked: async (ctx) => {
    await ctx.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'exec-f',
      title: 'rm -rf /tmp/x',
      kind: 'execute',
      status: 'failed',
      rawInput: { command: 'rm -rf /tmp/x' },
    });
    await sleep(300, ctx.signal);
    await ctx.stream('after the command');
  },
  /** Asks for a call it already reported as started (the cap must count it once). */
  startsThenAsks: async (ctx) => {
    await ctx.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'exec-s',
      title: 'pnpm test',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: 'pnpm test' },
    });
    const ran = await askToRun(ctx, 'exec-s', {
      title: 'pnpm test',
      kind: 'execute',
      rawInput: { command: 'pnpm test' },
    });
    await ctx.stream(ran ? 'tested' : 'not tested');
  },
  /** A form with two fields of other types. */
  form: async (ctx) => {
    const content = await elicit(ctx, 'Tell me about the release.', {
      count: { type: 'integer', title: 'How many builds?' },
      ship: { type: 'boolean', title: 'Ship it?' },
    });
    await ctx.stream(`form: ${JSON.stringify(content)}`);
  },
  /** A turn that fails inside the agent (a JSON-RPC error answers the prompt). */
  error: async () => {
    throw acp.RequestError.internalError(undefined, 'the model is unavailable');
  },
  /** A turn that ends with a non-standard stop reason. */
  refusal: async (ctx) => {
    await ctx.stream('I will not do that.');
    return 'refusal';
  },
  /** Exits mid-turn with code 3 (a crash of the agent itself). */
  dies: async (ctx) => {
    await ctx.stream('about to fail');
    await sleep(20, ctx.signal);
    process.exit(3);
  },
};

const connection = app.connect(
  acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);
await connection.closed;
process.exit(0);
