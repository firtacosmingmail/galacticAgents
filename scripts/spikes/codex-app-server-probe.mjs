// usage: node codex-driver.mjs <scenario> <cwd> <out.jsonl> [approvalDelayMs]
// Codex app-server probe driver (P11-01). usage: node codex-app-server-probe.mjs <scenario> <cwd> <out.jsonl> [approvalDelayMs]; env DECISION, CODEX_ARGS.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
const [scenario, cwd, out, delayArg] = process.argv.slice(2);
const delay = Number(delayArg || 0);
const prompts = {
  'turn-ok': 'Reply with exactly the word ok. Do not use any tools.',
  'approval-command': 'Run the shell command: touch probe.txt . Then say done.',
  'approval-file':
    'Use the apply_patch tool (not the shell) to create a file hello.txt containing the single line hi. Then say done.',
  'dynamic-tool': 'Call the request_publish tool once with text "hello". Then say done.',
  'late-approval': 'Run the shell command: touch late.txt . Then say done.',
  'js-tool':
    'Use your js tool (node_repl) to compute 1+1 and tell me the result. If you have no such tool say NOTOOL.',
  'js-escape':
    'Use your js tool (node_repl) exactly once to run this code and report the raw output: let out=[]; try{const r=await fetch("https://example.com");out.push("net-ok:"+r.status)}catch(e){out.push("net-blocked:"+e.message)}; try{out.push("globals:"+Object.keys(globalThis).slice(0,40).join(","))}catch(e){}; nodeRepl.write(out.join(" | "))',
  network:
    'Run the shell command: curl -sS -m 15 https://example.com . Report its exit status and first line of output or error.',
};
const log = fs.createWriteStream(out);
const w = (dir, msg) => log.write(JSON.stringify({ dir, msg }) + '\n');
const p = spawn(
  'codex',
  [...(process.env.CODEX_ARGS ? process.env.CODEX_ARGS.split(' ') : []), 'app-server'],
  { cwd, stdio: ['pipe', 'pipe', 'pipe'] },
);
let buf = '',
  nextId = 1;
const pending = new Map();
const send = (obj) => {
  w('out', obj);
  p.stdin.write(JSON.stringify(obj) + '\n');
};
const req = (method, params) =>
  new Promise((res) => {
    const id = nextId++;
    pending.set(id, res);
    send({ jsonrpc: '2.0', id, method, params });
  });
let done;
const finished = new Promise((r) => (done = r));
const t0 = Date.now();
p.stderr.on('data', (d) => w('stderr', String(d).slice(0, 500)));
p.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    w('in', { ...m, _t: Date.now() - t0 });
    if (m.id !== undefined && m.method === undefined) {
      pending.get(m.id)?.(m);
      continue;
    }
    if (m.id !== undefined && m.method) {
      // server request
      const answer = (result) => send({ jsonrpc: '2.0', id: m.id, result });
      const go = () => {
        if (
          m.method === 'item/commandExecution/requestApproval' ||
          m.method === 'item/fileChange/requestApproval'
        )
          answer({ decision: process.env.DECISION || 'accept' });
        else if (m.method === 'item/tool/call')
          answer({
            contentItems: [
              { type: 'inputText', text: JSON.stringify({ ok: true, echoed: m.params.arguments }) },
            ],
            success: true,
          });
        else if (m.method === 'mcpServer/elicitation/request')
          answer({ action: 'decline', content: null });
        else send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unsupported' } });
      };
      if (/requestApproval/.test(m.method) && delay) setTimeout(go, delay);
      else go();
    }
    if (m.method === 'turn/completed') done();
    if (m.method === 'error' && !m.params?.willRetry) setTimeout(done, 2000);
  }
});
const cfg = {
  web_search: 'disabled',
  mcp_servers: {},
  features: {
    apps: false,
    plugins: false,
    image_generation: false,
    browser_use: false,
    computer_use: false,
  },
};
await req('initialize', {
  clientInfo: { name: 'galactic-spike', title: null, version: '0.0.0' },
  capabilities: { experimentalApi: true, requestAttestation: false },
});
send({ jsonrpc: '2.0', method: 'initialized' });
const tsp = {
  cwd,
  approvalPolicy: 'untrusted',
  approvalsReviewer: 'user',
  sandbox: 'workspace-write',
  config: cfg,
};
if (scenario === 'dynamic-tool')
  tsp.dynamicTools = [
    {
      type: 'function',
      name: 'request_publish',
      description: 'Ask the user to approve publishing text.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
  ];
const ts = await req('thread/start', tsp);
const threadId = ts.result?.thread?.id;
if (!threadId) {
  w('note', 'thread/start failed');
  process.exit(1);
}
if (scenario === 'turn-ok') {
  await req('account/read', { refreshToken: false });
  await req('model/list', {});
  await req('account/rateLimits/read', undefined);
}
await req('turn/start', {
  threadId,
  input: [{ type: 'text', text: prompts[scenario], text_elements: [] }],
  approvalPolicy: 'untrusted',
  sandboxPolicy: {
    type: 'workspaceWrite',
    writableRoots: [],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  },
});
await Promise.race([finished, new Promise((r) => setTimeout(r, 15 * 60_000 + delay))]);
w('note', `elapsedMs ${Date.now() - t0}`);
p.kill();
log.end();
setTimeout(() => process.exit(0), 300);
