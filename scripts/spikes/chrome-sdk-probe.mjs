// P12-01 spike: does Claude in Chrome work in an Agent SDK session started with
// extraArgs { chrome: null }, and do its tool calls reach canUseTool?
//
// Safety (binding): serves its own page on 127.0.0.1, runs in a temp directory, and its
// canUseTool DENIES Bash/Write/Edit and any tool input that mentions a host other than
// localhost/127.0.0.1. It never touches GitHub or any logged-in site.
//
// Run:  node scripts/spikes/chrome-sdk-probe.mjs [--second]   (--second also starts a 2nd session)
import http from 'node:http';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(resolve(process.cwd(), 'apps/server/package.json'));
const sdkPath = require.resolve('@anthropic-ai/claude-agent-sdk');
const { query } = await import(sdkPath);

const LOCAL = new Set(['localhost', '127.0.0.1']);
const DENY_TOOLS = new Set(['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch']);

function strings(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out));
  return out;
}
function foreignHost(input) {
  for (const s of strings(input)) {
    for (const m of s.matchAll(/\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)([^\s/:?#'")]+)/gi)) {
      if (!LOCAL.has(m[1].toLowerCase())) return m[1];
    }
    // bare domain-like strings, e.g. "github.com"
    for (const m of s.matchAll(
      /\b([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|dev|app|co))\b/gi,
    )) {
      return m[1];
    }
  }
  return undefined;
}
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
        const bad = DENY_TOOLS.has(toolName)
          ? `tool ${toolName} not allowed in the probe`
          : foreignHost(input);
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
        console.log(
          `[${label}] init tools(total ${m.tools?.length}); chrome-ish: ${JSON.stringify(chrome)}`,
        );
        console.log(`[${label}] mcp_servers: ${JSON.stringify(m.mcp_servers ?? null)}`);
      } else if (m.type === 'assistant') {
        for (const b of m.message.content)
          if (b.type === 'tool_use') console.log(`[${label}] tool_use ${b.name}`);
          else if (b.type === 'text') console.log(`[${label}] text: ${b.text.slice(0, 200)}`);
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
