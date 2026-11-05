// P12-01 spike: does Claude in Chrome work in an Agent SDK session started with
// extraArgs { chrome: null }, and do its tool calls reach canUseTool?
//
// Usage (any cwd; paths are resolved relative to this file):
//   node scripts/spikes/chrome-sdk-probe.mjs [--hook-ask] [--second] [--allow-tabs-context]
//   --hook-ask            a PreToolUse hook answers `ask` for the Chrome tools (the route the
//                         adapter's gate uses), to see whether calls still reach canUseTool
//   --second              run two sessions at once
//   --allow-tabs-context  let the model call tabs_context_mcp (it lists the user's tabs); off by default
//
// Safety (binding): serves its own page on 127.0.0.1, runs in a temp directory, and its
// canUseTool is the allowlist in chrome-probe-guard.mjs (self-test: node --test
// scripts/spikes/chrome-probe-guard.test.mjs): only a few Chrome tools, only on the tab the probe
// created, only localhost/127.0.0.1 URLs. It never touches GitHub or any logged-in site.
import http from 'node:http';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { guard, createGuardState, recordToolResult } from './chrome-probe-guard.mjs';

const require = createRequire(
  fileURLToPath(new URL('../../apps/server/package.json', import.meta.url)),
);
const sdkPath = require.resolve('@anthropic-ai/claude-agent-sdk');
const { query } = await import(pathToFileURL(sdkPath).href);

const shape = (v) =>
  v && typeof v === 'object'
    ? Object.fromEntries(
        Object.entries(v).map(([k, x]) => [
          k,
          typeof x === 'string' ? `string(${x.length})` : Array.isArray(x) ? 'array' : typeof x,
        ]),
      )
    : typeof v;

const server = http.createServer((_, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(
    '<!doctype html><title>GalacticAgents probe</title><h1 style="color:#06c">Chrome probe page</h1><p>local only</p>',
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const cwd = mkdtempSync(join(tmpdir(), 'chrome-probe-'));
console.log(`[probe] serving http://127.0.0.1:${port}  cwd=${cwd}`);

async function session(label) {
  const seen = [];
  const state = createGuardState({
    allowTabsContext: process.argv.includes('--allow-tabs-context'),
  });
  const toolNames = new Map();
  const prompt = `Using your browser tools, open http://localhost:${port} in a NEW tab and take a screenshot. Then say what the page heading says. Do not visit any other site.`;
  const q = query({
    prompt,
    options: {
      cwd,
      maxTurns: 12,
      extraArgs: { chrome: null },
      // --hook-ask: a PreToolUse hook answers `ask` for the Chrome tools (the gate's route today),
      // to see whether the call still reaches canUseTool afterwards.
      ...(process.argv.includes('--hook-ask')
        ? {
            hooks: {
              PreToolUse: [
                {
                  matcher: 'mcp__claude-in-chrome__.*',
                  hooks: [
                    async (input) => {
                      console.log(`[${label}] PreToolUse hook -> ask ${input.tool_name}`);
                      return {
                        hookSpecificOutput: {
                          hookEventName: 'PreToolUse',
                          permissionDecision: 'ask',
                        },
                      };
                    },
                  ],
                },
              ],
            },
          }
        : {}),
      canUseTool: async (toolName, input) => {
        const { allow, reason } = guard(toolName, input, state);
        const bad = allow ? undefined : reason;
        const verdict = bad ? 'DENY' : 'ALLOW';
        console.log(
          `[${label}] canUseTool ${verdict} ${toolName} input=${JSON.stringify(shape(input))}${bad ? ` reason=${bad}` : ''}`,
        );
        seen.push(toolName);
        return bad
          ? { behavior: 'deny', message: `probe: ${bad}` }
          : { behavior: 'allow', updatedInput: input };
      },
    },
  });
  const timer = setTimeout(() => q.interrupt?.().catch(() => {}), 150_000);
  try {
    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init') {
        const chrome = (m.tools ?? []).filter((t) => /chrome/i.test(t));
        console.log(`[${label}] ALL chrome tools: ${chrome.join(' ')}`);
        console.log(`[${label}] mcp_servers: ${JSON.stringify(m.mcp_servers ?? null)}`);
      } else if (m.type === 'assistant') {
        for (const b of m.message.content)
          if (b.type === 'tool_use') {
            toolNames.set(b.id, b.name);
            console.log(`[${label}] tool_use ${b.name}`);
          } else if (b.type === 'text') console.log(`[${label}] text: ${b.text.slice(0, 200)}`);
      } else if (m.type === 'user' && Array.isArray(m.message?.content)) {
        // learn the probe's own tab id from the tabs_create_mcp result
        for (const b of m.message.content)
          if (b.type === 'tool_result') {
            const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
            recordToolResult(state, toolNames.get(b.tool_use_id) ?? '', text);
          }
      } else if (m.type === 'result') {
        console.log(
          `[${label}] result ${m.subtype} is_error=${m.is_error} ${String(m.result ?? m.errors ?? '').slice(0, 300)}`,
        );
      }
    }
  } catch (e) {
    console.log(`[${label}] ERROR ${e?.message ?? e}`);
  } finally {
    clearTimeout(timer);
  }
  console.log(
    `[${label}] tool names that reached canUseTool: ${JSON.stringify([...new Set(seen)])}`,
  );
}

if (process.argv.includes('--second')) await Promise.all([session('A'), session('B')]);
else await session('A');
server.close();
