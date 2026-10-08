#!/usr/bin/env node
/**
 * Smoke check of the desktop shell's Node side (P8-06) against a real, built Mission Control —
 * no Rust needed. In a temporary GALACTIC_HOME, on a free port, with the fake Harmonizer:
 *
 * 1. start: no server runs → the shell starts its own, it goes live, /health answers; "quit"
 *    stops it (its pid is gone, the port closed, the lock removed);
 * 2. attach: a server started outside the shell → the shell attaches (owned: false); "quit"
 *    leaves that server running; then this script stops it.
 * 3. the menu bar's permission requests (P9-15): on a server with the scene harness
 *    (`GALACTIC_DEV=1`), a fake Steward's permission request reaches the shell's `menu` line; the
 *    menu's "Allow once" (an `answer` command) answers it through the panel's route and the menu
 *    empties; an answer with a version that changed is refused and notified ("already answered").
 *
 * Usage (after `pnpm build`): node apps/desktop/scripts/smoke.mjs
 * Never touches ~/.galactic or ports 4321 / 5173.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));
const main = resolve(here, '../dist/main.js');
const launcher = resolve(here, '../../server/bin/galactic.mjs');

const root = mkdtempSync(join(tmpdir(), 'galactic-desktop-smoke-'));
const port = await freePort();
const env = {};
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GALACTIC_')) env[k] = v;
Object.assign(env, {
  GALACTIC_HOME: join(root, 'home'),
  GALACTIC_PROJECTS_ROOT: join(root, 'projects'),
  GALACTIC_PORT: String(port),
  GALACTIC_HARMONIZER: 'fake',
});
if (port === 4321 || port === 5173) throw new Error('refusing a reserved port');

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const health = async () => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await res.json();
    return body.name === 'galactic-agents' && body.token === undefined;
  } catch {
    return false;
  }
};

function shell() {
  const child = spawn(process.execPath, [main], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const seen = [];
  const waiters = [];
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      seen.push(line);
      console.log('  shell →', JSON.stringify(line));
      for (const w of [...waiters]) if (w.test(line)) w.done(line);
    }
  });
  const until = (test, ms = 60_000) =>
    new Promise((res, rej) => {
      const found = seen.find(test);
      if (found) return res(found);
      const timer = setTimeout(() => rej(new Error('timed out waiting for the shell')), ms);
      waiters.push({
        test,
        done: (l) => {
          clearTimeout(timer);
          res(l);
        },
      });
    });
  const exited = new Promise((res) => child.on('exit', res));
  return { child, until, exited };
}

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

try {
  console.log(`# 1. start (home ${env.GALACTIC_HOME}, port ${port})`);
  const a = shell();
  const server = (await a.until((l) => l.type === 'server')).server;
  check(server.owned === true && server.port === port, 'the shell started its own server');
  await a.until((l) => l.type === 'status' && l.state === 'live');
  check(await health(), '/health answers (without the token)');
  a.child.stdin.write('quit\n');
  await a.until((l) => l.type === 'exited', 45_000);
  await a.exited;
  check(!alive(server.pid), 'quit stopped the launcher it started');
  check(!(await health()), 'the port no longer answers');
  check(!existsSync(join(env.GALACTIC_HOME, 'galactic.sqlite.lock')), 'the data lock is released');

  console.log('# 2. attach');
  const outside = spawn(
    process.execPath,
    [launcher, 'start', '--no-open', '--port', String(port)],
    {
      env,
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  outside.stdout.resume();
  for (let i = 0; i < 120 && !(await health()); i++) await new Promise((r) => setTimeout(r, 500));
  check(await health(), 'a server started outside the shell answers');
  const b = shell();
  const attached = (await b.until((l) => l.type === 'server')).server;
  check(
    attached.owned === false && attached.port === port,
    'the shell attached instead of starting',
  );
  await b.until((l) => l.type === 'status' && l.state === 'live');
  b.child.stdin.end(); // stdin closing counts as quit
  await b.exited;
  check(await health(), 'quitting the shell left the attached server running');
  const stopped = new Promise((r) => outside.on('exit', r));
  outside.kill('SIGTERM');
  await stopped;

  console.log('# 3. permission requests in the menu bar');
  const devServer = spawn(
    process.execPath,
    [launcher, 'start', '--no-open', '--port', String(port)],
    { env: { ...env, GALACTIC_DEV: '1' }, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  devServer.stdout.resume();
  for (let i = 0; i < 120 && !(await health()); i++) await new Promise((r) => setTimeout(r, 500));
  const token = JSON.parse(readFileSync(join(env.GALACTIC_HOME, 'config.json'), 'utf8')).token;
  const dev = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return res.json();
  };
  const c = shell();
  await c.until((l) => l.type === 'status' && l.state === 'live');
  const scenario = await dev('/dev/harness/scenario', { stewards: 1, asteroid: false });
  const steward = scenario.stewardIds[0];
  const { questionId } = await dev(`/dev/harness/agents/${steward}/question`, {
    kind: 'permission',
  });
  const asked = Date.now();
  const shown = await c.until(
    (l) => l.type === 'menu' && l.menu.permissions.some((p) => p.id === questionId),
    10_000,
  );
  const item = shown.menu.permissions.find((p) => p.id === questionId);
  check(
    Date.now() - asked < 1000,
    `the request reached the menu within a second (${Date.now() - asked} ms)`,
  );
  check(
    /Bash rm -rf build$/.test(item.title),
    `the menu names the tool and command: "${item.title}"`,
  );
  c.child.stdin.write(
    JSON.stringify({ type: 'answer', questionId, version: item.version, decision: 'allow' }) + '\n',
  );
  await c.until(
    (l) => l.type === 'menu' && !l.menu.permissions.some((p) => p.id === questionId),
    10_000,
  );
  check(true, 'Allow once answered it: the request left the menu');
  const second = await dev(`/dev/harness/agents/${steward}/question`, { kind: 'permission' });
  const again = await c.until(
    (l) => l.type === 'menu' && l.menu.permissions.some((p) => p.id === second.questionId),
    10_000,
  );
  const stale = again.menu.permissions.find((p) => p.id === second.questionId);
  c.child.stdin.write(
    JSON.stringify({
      type: 'answer',
      questionId: second.questionId,
      version: stale.version + 1,
      decision: 'deny',
    }) + '\n',
  );
  const note = await c.until(
    (l) => l.type === 'notify' && l.id.startsWith('galactic:tray-answer:'),
  );
  check(
    note.title === 'Permission request already answered',
    `a stale answer is refused: "${note.body}"`,
  );
  c.child.stdin.write(
    JSON.stringify({
      type: 'answer',
      questionId: second.questionId,
      version: stale.version,
      decision: 'deny',
    }) + '\n',
  );
  await c.until(
    (l) => l.type === 'menu' && !l.menu.permissions.some((p) => p.id === second.questionId),
    10_000,
  );
  check(true, 'Deny answered the second one');
  c.child.stdin.end();
  await c.exited;
  const devStopped = new Promise((r) => devServer.on('exit', r));
  devServer.kill('SIGTERM');
  await devStopped;
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(failures === 0 ? 'smoke: all good' : `smoke: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port: p } = s.address();
      s.close(() => res(p));
    });
  });
}
