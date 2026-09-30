#!/usr/bin/env node
// P1-08 — Claude Agent SDK spike. Throwaway: exercises the TypeScript SDK the way the
// `claude-sdk` adapter (P1-09) will use it and prints what it finds. Run from the repo root
// after `pnpm install` (the SDK is a dependency of apps/server):
//
//   node docs/tasks/notes/P1-08-sdk-spike.mjs [steps...]
//
// Steps (default: all): auth tools permission hook ask resume interrupt stream bare spawn
// Each step is independent and prints a `== step ==` header followed by its findings.
// Needs a logged-in Claude Code (`claude auth status`) or an API key in the environment.

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const sdkPath = require.resolve('@anthropic-ai/claude-agent-sdk', {
  paths: [join(process.cwd(), 'apps/server'), process.cwd()],
});
const { query, createSdkMcpServer, tool } = await import(sdkPath);
const { z } = await import(
  require.resolve('zod', { paths: [join(process.cwd(), 'apps/server'), process.cwd()] })
);

const steps = process.argv.slice(2);
const want = (s) => steps.length === 0 || steps.includes(s);
const cwd = mkdtempSync(join(tmpdir(), 'galactic-spike-'));
writeFileSync(join(cwd, 'README.md'), '# spike\n\nA scratch workspace for the SDK spike.\n');
const log = (...a) => console.log(...a);
const header = (s) => log(`\n== ${s} ==`);
const short = (v) => JSON.stringify(v)?.slice(0, 300);

// Note: a child inherits CLAUDE_CODE_SESSION_ID when the spike itself runs under Claude Code and
// would then reuse that session id; the adapter assigns its own `sessionId` per spawn instead.
const base = {
  get sessionId() {
    return randomUUID();
  },
  cwd,
  model: process.env.SPIKE_MODEL ?? 'claude-sonnet-4-5',
  maxTurns: 6,
  settingSources: [],
  persistSession: true,
  includePartialMessages: false,
  stderr: (d) => process.env.SPIKE_DEBUG && process.stderr.write(`[stderr] ${d}`),
};

/** Drains a query, printing a compact line per message; returns the result message. */
async function drain(q, { onMessage } = {}) {
  let result;
  try {
    for await (const m of q) {
    onMessage?.(m);
    if (m.type === 'system' && m.subtype === 'init') {
      log(`  init: session=${m.session_id} model=${m.model} tools=${m.tools?.length} mode=${m.permissionMode}`);
    } else if (m.type === 'assistant') {
      for (const c of m.message.content) {
        if (c.type === 'text') log(`  assistant text: ${c.text.slice(0, 120).replace(/\n/g, ' ')}`);
        if (c.type === 'tool_use') log(`  assistant tool_use: ${c.name} ${short(c.input)}`);
        if (c.type === 'thinking') log(`  assistant thinking: ${c.thinking.slice(0, 80)}`);
      }
    } else if (m.type === 'user') {
      const content = m.message.content;
      if (Array.isArray(content))
        for (const c of content)
          if (c.type === 'tool_result')
            log(`  tool_result: ${short(c.content).slice(0, 160)}`);
    } else if (m.type === 'result') {
      result = m;
      log(
        `  result: subtype=${m.subtype} turns=${m.num_turns} cost=$${m.total_cost_usd} ` +
          `usage=${short(m.usage)} session=${m.session_id} is_error=${m.is_error}`,
      );
      if (m.subtype === 'success') log(`  result text: ${m.result.slice(0, 160).replace(/\n/g, ' ')}`);
      if (m.permission_denials?.length) log(`  permission_denials: ${short(m.permission_denials)}`);
    } else {
      log(`  ${m.type}${m.subtype ? '/' + m.subtype : ''}`);
    }
    }
  } catch (e) {
    log(`  iteration threw: ${e.message.split('\n')[0].slice(0, 200)}`);
  }
  return result;
}

if (want('auth')) {
  header('auth');
  try {
    const out = execFileSync('claude', ['auth', 'status'], { encoding: 'utf8' });
    log('  claude auth status:', out.trim().replace(/\n/g, ' '));
  } catch (e) {
    log('  claude auth status failed:', e.message.split('\n')[0]);
  }
  log('  ANTHROPIC_API_KEY set:', Boolean(process.env.ANTHROPIC_API_KEY));
  log('  CLAUDE_CODE_OAUTH_TOKEN set:', Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN));
  const q = query({ prompt: 'Reply with exactly: ok', options: { ...base, tools: [], maxTurns: 1 } });
  const init = await q.initializationResult().catch((e) => ({ error: e.message }));
  log('  initializationResult keys:', Object.keys(init).join(', '));
  const r = await drain(q);
  log('  in-process query under the CLI login worked:', r?.subtype === 'success');
}

if (want('tools')) {
  header('tools: custom tools + system prompt (brain shape)');
  const calls = [];
  const server = createSdkMcpServer({
    name: 'galactic',
    version: '0.0.1',
    tools: [
      tool(
        'get_agent_status',
        'Returns the status of a supervised agent',
        { agentId: z.string() },
        async ({ agentId }) => {
          calls.push(agentId);
          return { content: [{ type: 'text', text: JSON.stringify({ agentId, state: 'working', cost: 0.12 }) }] };
        },
      ),
    ],
  });
  const q = query({
    prompt: 'What is the state of agent a-7? Use the tool, then answer in one line.',
    options: {
      ...base,
      systemPrompt: 'You are the Harmonizer of GalacticAgents. Use your tools; never guess.',
      mcpServers: { galactic: server },
      allowedTools: ['mcp__galactic__get_agent_status'],
      tools: [],
    },
  });
  const r = await drain(q);
  log('  tool handler ran in-process with:', calls, '→', r?.subtype);
}

if (want('permission')) {
  header('permission: canUseTool callback shape');
  const seen = [];
  const q = query({
    prompt: 'Run the shell command `echo galactic-permission-test` and tell me its output.',
    options: {
      ...base,
      permissionMode: 'default',
      canUseTool: async (toolName, input, options) => {
        seen.push({ toolName, input, optionKeys: Object.keys(options), title: options.title, decisionReason: options.decisionReason });
        log(`  canUseTool(${toolName}, ${short(input)}) options=${Object.keys(options).join(',')} title=${JSON.stringify(options.title)}`);
        return { behavior: 'allow', updatedInput: input };
      },
    },
  });
  const r = await drain(q);
  log('  callbacks:', seen.length, '→', r?.subtype);

  header('permission: deny with a message');
  const q2 = query({
    prompt: 'Run the shell command `rm -rf /tmp/does-not-matter` and report what happened.',
    options: {
      ...base,
      permissionMode: 'default',
      canUseTool: async (toolName, input) => {
        log(`  canUseTool(${toolName}, ${short(input)}) → deny`);
        return { behavior: 'deny', message: 'The user refused this destructive command.' };
      },
    },
  });
  await drain(q2);
}

if (want('hook')) {
  header('hook: PreToolUse sees every tool call and can force the prompt');
  const hookSeen = [];
  const promptSeen = [];
  const q = query({
    prompt: 'Run the shell command `echo galactic-hook-test` and tell me its output.',
    options: {
      ...base,
      permissionMode: 'default',
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (input) => {
                hookSeen.push(input.tool_name);
                log(`  PreToolUse hook: ${input.tool_name} ${short(input.tool_input)}`);
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'ask',
                    permissionDecisionReason: 'GalacticAgents policy: ask the user',
                  },
                };
              },
            ],
          },
        ],
      },
      canUseTool: async (toolName, input, options) => {
        promptSeen.push(toolName);
        log(`  canUseTool(${toolName}) after hook ask; decisionReason=${JSON.stringify(options.decisionReason)}`);
        return { behavior: 'allow', updatedInput: input };
      },
    },
  });
  const r = await drain(q);
  log('  hook saw:', hookSeen, '| prompt saw:', promptSeen, '→', r?.subtype);
}

if (want('ask')) {
  header('ask: how AskUserQuestion surfaces');
  const q = query({
    prompt:
      'Before doing anything, use the AskUserQuestion tool to ask me which date format to use (options: ISO, US). Then answer with the format I chose, in one line.',
    options: {
      ...base,
      permissionMode: 'default',
      canUseTool: async (toolName, input, options) => {
        log(`  canUseTool(${toolName}) input=${short(input)} keys=${Object.keys(options).join(',')}`);
        if (toolName === 'AskUserQuestion') {
          const questions = input.questions ?? [];
          const answers = Object.fromEntries(questions.map((qq) => [qq.question, 'ISO']));
          return { behavior: 'allow', updatedInput: { ...input, answers } };
        }
        return { behavior: 'allow', updatedInput: input };
      },
    },
  });
  const r = await drain(q);
  log('  answered through updatedInput.answers →', r?.subtype, r?.result?.slice(0, 80));
}

if (want('resume')) {
  header('resume: session id round trip');
  const q1 = query({ prompt: 'Remember the codeword "andromeda". Reply with exactly: stored', options: { ...base, tools: [], maxTurns: 1 } });
  const r1 = await drain(q1);
  const sessionId = r1?.session_id;
  log('  session_id from result:', sessionId);
  const q2 = query({ prompt: 'What was the codeword? Reply with just the word.', options: { ...base, sessionId: undefined, tools: [], maxTurns: 1, resume: sessionId } });
  const r2 = await drain(q2);
  log('  resumed session answered:', r2?.result?.trim(), '| same session id:', r2?.session_id === sessionId);
  log('  cost after resume is cumulative:', r2?.total_cost_usd, '>=', r1?.total_cost_usd);
}

if (want('interrupt')) {
  header('interrupt: stop a running turn');
  const q = query({
    prompt: 'Run `sleep 20 && echo done` with the Bash tool, then tell me it finished.',
    options: { ...base, permissionMode: 'default', canUseTool: async (t, i) => ({ behavior: 'allow', updatedInput: i }) },
  });
  let interrupted = false;
  const started = Date.now();
  const r = await drain(q, {
    onMessage: (m) => {
      if (!interrupted && m.type === 'assistant' && m.message.content.some((c) => c.type === 'tool_use')) {
        interrupted = true;
        setTimeout(() => {
          log('  calling q.interrupt()');
          q.interrupt().then((x) => log('  interrupt() resolved:', short(x))).catch((e) => log('  interrupt() rejected:', e.message));
        }, 1500);
      }
    },
  });
  log(`  after interrupt: subtype=${r?.subtype} is_error=${r?.is_error} took=${Date.now() - started}ms`);
}

if (want('stream')) {
  header('stream: one long-lived query with streaming input (the adapter shape)');
  const inbox = [];
  let wake;
  const messages = (async function* () {
    for (;;) {
      if (inbox.length === 0) await new Promise((r) => (wake = r));
      const text = inbox.shift();
      if (text === null) return;
      yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' };
    }
  })();
  const push = (text) => {
    inbox.push(text);
    wake?.();
  };
  const q = query({
    prompt: messages,
    options: {
      ...base,
      maxTurns: 20,
      permissionMode: 'default',
      canUseTool: async (t, i) => ({ behavior: 'allow', updatedInput: i }),
    },
  });
  const results = [];
  let phase = 0;
  const consumer = (async () => {
    try {
      for await (const m of q) {
        if (m.type === 'assistant')
          for (const c of m.message.content) {
            if (c.type === 'text') log(`  [turn ${phase}] text: ${c.text.slice(0, 80).replace(/\n/g, ' ')}`);
            if (c.type === 'tool_use') log(`  [turn ${phase}] tool_use: ${c.name} ${short(c.input)}`);
          }
        if (m.type === 'result') {
          results.push(m);
          log(`  [turn ${phase}] result: ${m.subtype} is_error=${m.is_error} cost=$${m.total_cost_usd} turns=${m.num_turns}`);
        }
      }
      log('  query iteration ended cleanly');
    } catch (e) {
      log(`  query iteration threw: ${e.message.split('\n')[0].slice(0, 160)}`);
    }
  })();
  const nextResult = (n) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no result in time')), 120_000);
    const tick = () => (results.length >= n ? (clearTimeout(t), resolve(results[n - 1])) : setTimeout(tick, 100));
    tick();
  });
  phase = 1;
  push('Reply with exactly: one');
  await nextResult(1).catch((e) => log('  ', e.message));
  phase = 2;
  push('Reply with exactly: two');
  await nextResult(2).catch((e) => log('  ', e.message));
  phase = 3;
  push('Run `sleep 30 && echo done` with the Bash tool, then say finished.');
  await new Promise((r) => setTimeout(r, 6000));
  log('  interrupting turn 3');
  await q.interrupt().then((x) => log('  interrupt() →', short(x))).catch((e) => log('  interrupt() rejected:', e.message));
  await nextResult(3).catch((e) => log('  ', e.message));
  phase = 4;
  push('Reply with exactly: four');
  await nextResult(4).catch((e) => log('  ', e.message));
  log('  results:', results.map((r) => `${r.subtype}${r.is_error ? '(error)' : ''}`).join(', '));
  log('  same session throughout:', new Set(results.map((r) => r.session_id)).size === 1);
  push(null);
  await Promise.race([consumer, new Promise((r) => setTimeout(r, 10_000))]);
  log('  session_id:', results[0]?.session_id);
}

if (want('bare')) {
  header('bare: is --bare reachable from the SDK?');
  const q = query({ prompt: 'Reply with exactly: bare-ok', options: { ...base, tools: [], maxTurns: 1, extraArgs: { bare: null } } });
  try {
    const r = await drain(q);
    log('  extraArgs {bare: null} accepted →', r?.subtype, r?.result?.trim());
  } catch (e) {
    log('  extraArgs {bare: null} failed:', e.message.split('\n')[0]);
  }
}

if (want('spawn')) {
  header('spawn: spawnClaudeCodeProcess hook (own process group for the supervisor)');
  let spawned;
  const q = query({
    prompt: 'Reply with exactly: spawned-ok',
    options: {
      ...base,
      tools: [],
      maxTurns: 1,
      spawnClaudeCodeProcess: (opts) => {
        spawned = { command: opts.command, args: opts.args, cwd: opts.cwd, envKeys: Object.keys(opts.env).length };
        const child = spawn(opts.command, opts.args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true, signal: opts.signal });
        child.stderr.on('data', () => {});
        log(`  spawned pid=${child.pid} detached (own process group)`);
        return child;
      },
    },
  });
  const r = await drain(q);
  log('  command:', spawned?.command);
  log('  args:', spawned?.args?.join(' ').slice(0, 300));
  log('  →', r?.subtype, r?.result?.trim());
}

log('\nworkspace used:', cwd);
