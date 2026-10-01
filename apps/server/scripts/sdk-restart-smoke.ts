/**
 * P1-12/P1-14 smoke: kill the server mid-task (kill -9), restart, the Claude agent resumes
 * from its session ref. Local-only (needs a logged-in Claude Code).
 *
 *   pnpm --filter @galactic/server exec tsx scripts/sdk-restart-smoke.ts
 *
 * Life 1 runs in a child process (so a real SIGKILL can take it), spawns an agent on a long
 * shell loop and waits. The parent kills it once the tool call started, then composes life 2
 * over the same database: the supervisor reconciles the PID table (the orphaned CLI is killed),
 * `recover()` resumes the agent, and a follow-up message proves the session is the same.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeSdkAdapter } from '../src/adapters/claude-sdk/index.js';
import { openDatabase } from '../src/db/database.js';
import { composeRuntime } from '../src/runtime/compose.js';
import { SqliteProcessStore } from '../src/runtime/process-store.js';
import { ProcessSupervisor } from '../src/runtime/supervisor.js';

const USER = { type: 'user' } as const;
const model = process.env['SMOKE_MODEL'] ?? 'claude-sonnet-4-5';
const log = (...a: unknown[]) => console.log(...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function compose(dbPath: string) {
  const db = openDatabase(dbPath);
  const supervisor = new ProcessSupervisor({
    store: new SqliteProcessStore(db),
    defaults: { graceMs: 15_000 },
  });
  const reconciled = supervisor.reconcile();
  const adapter = new ClaudeSdkAdapter({ supervisor, model });
  const composed = composeRuntime(db, { adapters: [adapter], flushMs: 20 });
  return { db, supervisor, reconciled, composed };
}

if (process.argv[2] === '--life1') {
  const dbPath = process.env['SMOKE_DB']!;
  const cwd = process.env['SMOKE_CWD']!;
  const { composed } = compose(dbPath);
  const r = await composed.runtime.spawn({
    role: 'steward',
    runtime: 'claude-sdk',
    prompt:
      'First reply with exactly: starting. Then run the shell command `for i in $(seq 1 30); do echo tick $i; sleep 2; done` with the Bash tool, then reply with exactly: finished',
    cwd,
  });
  if (!r.ok) throw new Error(r.reason);
  process.stdout.write(`AGENT ${r.agent.id}\n`);
  composed.log.subscribe((e) => process.stdout.write(`EVENT ${e.event.type}\n`));
  await sleep(10 * 60_000); // killed long before this
} else {
  const dir = mkdtempSync(join(tmpdir(), 'galactic-restart-'));
  const dbPath = join(dir, 'galactic.sqlite');
  const cwd = join(dir, 'workspace');
  writeFileSync(join(dir, 'README.md'), '# restart smoke\n');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(cwd);

  log('== life 1 (child process) ==');
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(import.meta.url), '--life1'],
    {
      cwd: process.cwd(),
      env: { ...process.env, SMOKE_DB: dbPath, SMOKE_CWD: cwd, GALACTIC_LOG: 'silent' },
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  let agentId = '';
  let toolCallSeen = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) {
      if (line.startsWith('AGENT ')) agentId = line.slice(6).trim();
      if (line === 'EVENT agent.tool_call') toolCallSeen = true;
      if (line.startsWith('EVENT ')) log('  life 1:', line.slice(6));
    }
  });
  const t0 = Date.now();
  while (!toolCallSeen && Date.now() - t0 < 180_000) await sleep(100);
  if (!toolCallSeen) throw new Error('life 1 never reached the tool call');
  await sleep(3_000); // let the loop tick a few times
  log(`  kill -9 life 1 (pid ${child.pid}) while the agent runs its shell loop`);
  child.kill('SIGKILL');
  await new Promise((r) => child.once('exit', r));

  // The CLI is now an orphan in its own process group.
  const db0 = openDatabase(dbPath);
  const row = new SqliteProcessStore(db0).get(agentId)!;
  db0.close();
  const alive = (() => {
    try {
      process.kill(row.pid!, 0);
      return true;
    } catch {
      return false;
    }
  })();
  log(
    `  orphaned CLI pid ${row.pid}: ${alive ? 'still running' : 'gone'} (row status ${row.status})`,
  );

  log('\n== life 2 (this process) ==');
  const { composed, supervisor, reconciled } = compose(dbPath);
  log('  reconcile:', JSON.stringify(reconciled));
  log('  status before recover:', composed.statuses.get(agentId)?.state);
  composed.log.subscribe((e) => log(`  life 2: #${e.seq} ${e.event.type}`));
  const report = await composed.recover();
  log('  recover:', JSON.stringify(report));
  const waitFor = (pred: () => boolean, what: string, ms = 180_000) =>
    new Promise<void>((resolve, reject) => {
      const s = Date.now();
      const tick = () =>
        pred()
          ? resolve()
          : Date.now() - s > ms
            ? reject(new Error(`timeout: ${what}`))
            : setTimeout(tick, 100);
      tick();
    });
  await waitFor(() => composed.statuses.get(agentId)?.state === 'idle', 'idle after resume');
  log('  state after resume:', composed.statuses.get(agentId)?.state);
  composed.runtime.send(
    agentId,
    'What was the first word you replied with in this session? Reply with just that word.',
    { sender: USER },
  );
  await waitFor(
    () =>
      composed.log
        .eventsSince(0, Number.MAX_SAFE_INTEGER)
        .filter(
          (e) =>
            e.event.type === 'agent.idle' && 'agentId' in e.event && e.event.agentId === agentId,
        ).length >= 2,
    'second idle',
  );
  composed.transcripts.flush();
  const texts = composed.transcripts.read(agentId).map((c) => c.text);
  log('  transcript tail:', texts.slice(-2));
  log('  same session remembered "starting":', texts.at(-1)?.toLowerCase().includes('starting'));
  await composed.runtime.stop(agentId, USER);
  await waitFor(() => composed.statuses.get(agentId)?.state === 'stopped', 'stopped');
  const types = composed.log
    .eventsSince(0, Number.MAX_SAFE_INTEGER)
    .filter((e) => 'agentId' in e.event && e.event.agentId === agentId)
    .map((e) => e.event.type);
  log('  agent events across both lives:', types.join(' '));
  await composed.dispose();
  await supervisor.dispose();
  log(
    '\nlive processes left:',
    supervisor.runningCount,
    '| orphan still alive:',
    (() => {
      try {
        process.kill(row.pid!, 0);
        return true;
      } catch {
        return false;
      }
    })(),
  );
}
