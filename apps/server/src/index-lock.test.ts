import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireDataLock } from './db/data-lock.js';

/**
 * P8-03 review — Mission Control refuses to start on a database another live process holds (a
 * second server, or an import / restore under way), before it opens the database.
 */

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('the server and the data lock', () => {
  it('refuses to start while a live process holds the lock, and leaves the database alone', async () => {
    const root = mkdtempSync(join(tmpdir(), 'galactic-index-lock-'));
    roots.push(root);
    const home = join(root, 'home');
    const dbPath = join(home, 'galactic.sqlite');
    const lock = acquireDataLock(dbPath, 'import'); // this test process: alive
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GALACTIC_')) env[k] = v;
    Object.assign(env, {
      HOME: root,
      GALACTIC_HOME: home,
      GALACTIC_PROJECTS_ROOT: join(root, 'projects'),
      GALACTIC_PORT: '0',
      GALACTIC_LOG: 'silent',
    });
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: SERVER_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    const code = await new Promise<number | null>((r) => child.once('exit', (c) => r(c)));
    expect(code).toBe(1);
    expect(stderr).toMatch(/Cannot start: a galactic import \(pid \d+\) is using .*Stop it first/);
    expect(existsSync(dbPath)).toBe(false);
    lock.release();
  }, 30_000);
});
