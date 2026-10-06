import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Id } from '@galactic/protocol';
import { openDatabase } from '../../db/database.js';
import { SqliteProcessStore } from '../../runtime/process-store.js';
import { ProcessSupervisor } from '../../runtime/supervisor.js';
import { bootDrill, drillDirs, firstLife, type FirstLife } from './drill-world.js';

/**
 * The server the crash drills kill (P8-04): run as its own process (`node --import tsx
 * drill-server.ts <root>`), it boots the drill world over `<root>/data/galactic.sqlite` with a
 * process supervisor whose PID table is in that database (as `index.ts` does), builds the first
 * life, gives the two Stewards stand-in CLIs (real process groups), writes `<root>/ready.json`,
 * prints `DRILL READY` and runs until it is killed. Nothing here ever shuts down gracefully.
 */

export interface StandIn {
  leader: number;
  child: number;
  escaped?: number;
}

export interface Ready extends FirstLife {
  server: number;
  /** The stand-in CLIs: S1's leaves an escaped process in its worktree; S2's exits on EOF. */
  standIns: Record<Id, StandIn>;
}

const STAND_IN = join(dirname(fileURLToPath(import.meta.url)), 'stand-in-cli.mjs');

async function main(): Promise<void> {
  const root = process.argv[2];
  if (!root) throw new Error('usage: drill-server.ts <root>');
  const dirs = drillDirs(root);
  const db = openDatabase(dirs.db);
  const supervisor = new ProcessSupervisor({ store: new SqliteProcessStore(db) });
  const h = bootDrill(dirs, db, { groups: supervisor });
  const one = await firstLife(h, dirs);

  const standIns: Record<Id, StandIn> = {};
  for (const [agentId, cwd, flag] of [
    [one.s1, one.s1Worktree, '--escape'],
    [one.s2, one.s2Worktree, '--exit-on-eof'],
  ] as const) {
    const pidsFile = join(root, `${agentId}.pids.json`);
    await supervisor.spawn({
      agentId,
      command: process.execPath,
      args: [STAND_IN, '--pids', pidsFile, flag],
      cwd,
    });
    const deadline = Date.now() + 10_000;
    while (!existsSync(pidsFile)) {
      if (Date.now() > deadline) throw new Error(`stand-in of ${agentId} did not start`);
      await new Promise((r) => setTimeout(r, 20));
    }
    // Written in one call, but read it until it parses (a reader may see the file being written).
    for (;;) {
      try {
        standIns[agentId] = JSON.parse(readFileSync(pidsFile, 'utf8')) as StandIn;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
  }

  const ready: Ready = { ...one, server: process.pid, standIns };
  writeFileSync(join(root, 'ready.json'), JSON.stringify(ready, null, 2));
  console.log('DRILL READY');
  // Runs until killed: the Stewards keep working, the Docs Waykeeper keeps planning.
  setInterval(() => {}, 1 << 30);
}

main().catch((error: unknown) => {
  console.error('DRILL FAILED', error instanceof Error ? error.stack : error);
  process.exit(1);
});
