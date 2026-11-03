#!/usr/bin/env node
// Mission Control's PreToolUse hook for Antigravity (`agy`) Stewards (P11-05; TECHNOLOGY §3.7).
// agy runs it before every tool call from the managed entry in ~/.gemini/config/hooks.json, with
// the tool call as JSON on stdin, and reads one JSON decision from stdout.
//
// - Not a run Mission Control started (no GALACTIC_AGY_SECRET in the environment): pass through
//   with `allow`, which leaves agy's own permission rules in charge — the user's own `agy` use is
//   unaffected.
// - A Mission Control run: POST the payload to GALACTIC_AGY_URL with the secret in
//   `x-galactic-hook`, wait as long as it takes (the user may be deciding; agy's hook timeout is
//   the limit), and print the decision. `allow` is printed as agy's `auto_approve`: a plain
//   `allow` lets agy's headless permission check refuse the call anyway (P11-01 notes, agy 2).
// - Any error — Mission Control unreachable (after a short wait for it to start), a non-200 answer, a body that is not a decision —
//   prints {"decision":"deny"}. Exit status is always 0, so agy reads the decision.
//
// Self-contained (Node built-ins only): Mission Control copies it to its data directory.
import { request as httpRequest } from 'node:http';

const say = (obj) => {
  process.stdout.write(JSON.stringify(obj));
};
const DENY = { decision: 'deny' };

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
    process.stdin.on('error', reject);
  });
}

function post(url, secret, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'http:') {
      reject(new Error(`not an http URL: ${url}`));
      return;
    }
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
          resolve(Buffer.concat(chunks).toString('utf8'));
        });
        res.on('error', reject);
      },
    );
    // No timeout of our own: agy kills the hook at its timeout, and that fails closed.
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * Mission Control may still be starting (an agy turn resumed during its recovery runs before it
 * listens): a refused connection is tried again for a while (GALACTIC_AGY_CONNECT_WAIT_MS,
 * default 15 s), then fails — and fails closed.
 */
async function postPatiently(url, secret, body) {
  const wait = Number(process.env.GALACTIC_AGY_CONNECT_WAIT_MS ?? 15_000);
  const deadline = Date.now() + (Number.isFinite(wait) ? wait : 15_000);
  for (;;) {
    try {
      return await post(url, secret, body);
    } catch (error) {
      if (error?.code !== 'ECONNREFUSED' || Date.now() >= deadline) throw error;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

async function main() {
  const secret = process.env.GALACTIC_AGY_SECRET;
  if (!secret) {
    say({ decision: 'allow' });
    return;
  }
  const url = process.env.GALACTIC_AGY_URL;
  if (!url) throw new Error('no GALACTIC_AGY_URL');
  const raw = await readStdin();
  JSON.parse(raw.toString('utf8') || 'null'); // not JSON: deny before bothering Mission Control
  const answer = JSON.parse(await postPatiently(url, secret, raw));
  if (answer && answer.decision === 'allow') {
    say({ decision: 'auto_approve' });
  } else if (answer && answer.decision === 'deny') {
    say(
      typeof answer.reason === 'string' && answer.reason
        ? { decision: 'deny', reason: answer.reason }
        : DENY,
    );
  } else {
    say(DENY);
  }
}

main().then(
  () => process.exit(0),
  () => {
    say(DENY);
    process.exit(0);
  },
);
