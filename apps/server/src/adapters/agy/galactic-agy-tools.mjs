#!/usr/bin/env node
// Mission Control's tool server for Antigravity (`agy`) Stewards (P11-05; TECHNOLOGY §3.7): a
// stdio MCP server (JSON-RPC 2.0, one message per line) that agy starts from the managed
// `galactic` entry in ~/.gemini/config/mcp_config.json. It holds no tools of its own: it forwards
// `tools/list` and `tools/call` to Mission Control (GALACTIC_AGY_URL + `/tools` or `/call`, the
// session's secret in `x-galactic-hook`), where the session's tools run.
//
// Started by agy for a run Mission Control did not start (no GALACTIC_AGY_SECRET), it lists no
// tools, so the user's own `agy` use sees nothing. A call waits as long as Mission Control takes
// (`ask_user` waits for the user's answer). Self-contained (Node built-ins only).
import { request as httpRequest } from 'node:http';
import { createInterface } from 'node:readline';

const secret = process.env.GALACTIC_AGY_SECRET;
const base = process.env.GALACTIC_AGY_URL;

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

function post(path, payload) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${base}${path}`);
    const body = Buffer.from(JSON.stringify(payload));
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        agent: false,
        headers: {
          'content-type': 'application/json',
          'content-length': body.length,
          'x-galactic-hook': secret,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Mission Control answered ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (error) {
            reject(error);
          }
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** A refused connection (Mission Control still starting) is tried again for a while. */
async function postPatiently(path, payload) {
  const wait = Number(process.env.GALACTIC_AGY_CONNECT_WAIT_MS ?? 15_000);
  const deadline = Date.now() + (Number.isFinite(wait) ? wait : 15_000);
  for (;;) {
    try {
      return await post(path, payload);
    } catch (error) {
      if (error?.code !== 'ECONNREFUSED' || Date.now() >= deadline) throw error;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

async function handle(msg) {
  switch (msg.method) {
    case 'initialize':
      return {
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'galactic', version: '1.0.0' },
      };
    case 'ping':
      return {};
    case 'tools/list': {
      if (!secret || !base) return { tools: [] };
      const answer = await postPatiently('/tools', {});
      return { tools: Array.isArray(answer?.tools) ? answer.tools : [] };
    }
    case 'tools/call': {
      if (!secret || !base) {
        return {
          content: [{ type: 'text', text: 'not a Mission Control session' }],
          isError: true,
        };
      }
      try {
        const answer = await postPatiently('/call', {
          name: msg.params?.name,
          arguments: msg.params?.arguments ?? {},
        });
        return {
          content: Array.isArray(answer?.content) ? answer.content : [],
          isError: answer?.isError === true,
        };
      } catch (error) {
        return {
          content: [
            { type: 'text', text: `Mission Control could not be reached: ${error.message}` },
          ],
          isError: true,
        };
      }
    }
    default: {
      const error = new Error(`${msg.method} is not supported`);
      error.code = -32601;
      throw error;
    }
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (!msg || typeof msg.method !== 'string') return;
  if (msg.id === undefined || msg.id === null) return; // a notification
  handle(msg).then(
    (result) => send({ id: msg.id, result }),
    (error) =>
      send({ id: msg.id, error: { code: error.code ?? -32603, message: String(error.message) } }),
  );
});
process.stdin.on('end', () => process.exit(0));
