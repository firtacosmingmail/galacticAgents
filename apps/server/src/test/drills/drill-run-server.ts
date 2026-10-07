import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Id } from '@galactic/protocol';
import { openDatabase } from '../../db/database.js';
import { createProject } from '../../domain/projects.js';
import { composeRuntime } from '../../runtime/compose.js';
import { SqliteProcessStore } from '../../runtime/process-store.js';
import { ProcessSupervisor } from '../../runtime/supervisor.js';

/**
 * The server the run crash drill kills (P9-08): run as its own process (`node --import tsx
 * drill-run-server.ts <root>`), it composes the runtime over `<root>/data/galactic.sqlite` with a
 * supervisor whose PID table is in that database (as `index.ts` does), adds a command deliverable
 * in `<root>/app` and starts it as the user would — the fixture server, which listens on an
 * ephemeral port and leaves a background child in its group and one escaped into a group of its
 * own — writes `<root>/ready.json` once the fixture wrote its pids, and runs until it is killed.
 *
 * `--pause-after-fork` (fault injection): the supervisor's `afterFork` hook for the run writes
 * `<root>/forked.json` (`{key, pid, launchId}`) and blocks the server for good — the run is forked,
 * its PID-table row and its `run.started` are never written.
 */

export const RUN_FIXTURE = `
import http from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const server = http.createServer((_q, r) => r.end('ok'));
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const bg = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const escaped = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    detached: true,
  });
  escaped.unref();
  writeFileSync('pids.json', JSON.stringify({ server: process.pid, bg: bg.pid, escaped: escaped.pid, port }));
  console.log('ready on http://localhost:' + port);
});
`;

export interface RunPids {
  server: number;
  bg: number;
  escaped: number;
  port: number;
}

export interface RunReady {
  server: number;
  deliverableId: Id;
  runId?: Id;
  pids: RunPids;
}

export interface RunForked {
  key: Id;
  pid: number;
  launchId: string;
}

export function runDrillDirs(root: string) {
  return {
    app: join(root, 'app'),
    data: join(root, 'data'),
    db: join(root, 'data', 'galactic.sqlite'),
  };
}

async function readJson<T>(path: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as T;
      } catch {
        // being written
      }
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function main(): Promise<void> {
  const root = process.argv[2];
  if (!root) throw new Error('usage: drill-run-server.ts <root> [--pause-after-fork]');
  const pause = process.argv.includes('--pause-after-fork');
  const dirs = runDrillDirs(root);
  mkdirSync(dirs.app, { recursive: true });
  mkdirSync(dirs.data, { recursive: true });
  writeFileSync(join(dirs.app, 'server.mjs'), RUN_FIXTURE);
  const db = openDatabase(dirs.db);
  const supervisor = new ProcessSupervisor({
    store: new SqliteProcessStore(db),
    testHooks: {
      afterFork: (info) => {
        if (!pause || !info.agentId.startsWith('run:')) return;
        writeFileSync(
          join(root, 'forked.json'),
          JSON.stringify({ key: info.agentId, pid: info.pid, launchId: info.launchId }),
        );
        // Blocks the event loop for good: neither the row nor `run.started` is written.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      },
    },
  });
  const composed = composeRuntime(db, {
    deliverables: { dataDir: dirs.data, home: join(root, 'home') },
    runs: { supervisor },
  });
  const project = composed.log.runCommand((ctx) =>
    createProject(ctx, { name: 'Drill', workspace: dirs.app, bodyId: 'b-saturn' }),
  ).value;
  const d = (
    await composed.commands.addDeliverable(
      {
        projectId: project.id,
        kind: 'command',
        title: 'Fixture server',
        source: 'user',
        command: { line: `${JSON.stringify(process.execPath)} server.mjs`, cwd: dirs.app },
      },
      { type: 'user' },
      { origin: 'local' },
    )
  ).value;
  const run = await composed.runs!.start(d.id, { version: d.version }, { type: 'user' });
  const pids = await readJson<RunPids>(join(dirs.app, 'pids.json'));
  const ready: RunReady = { server: process.pid, deliverableId: d.id, runId: run.id, pids };
  writeFileSync(join(root, 'ready.json'), JSON.stringify(ready, null, 2));
  console.log('DRILL READY');
  setInterval(() => {}, 1 << 30);
}

if (process.argv[1]?.endsWith('drill-run-server.ts')) {
  main().catch((error: unknown) => {
    console.error('DRILL FAILED', error instanceof Error ? error.stack : error);
    process.exit(1);
  });
}
