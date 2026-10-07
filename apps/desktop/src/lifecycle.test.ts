import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dataPaths, plan, readLock, readToken, redactLine, type PlanDeps } from './lifecycle.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'galactic-desktop-'));
  dirs.push(d);
  return d;
};

const deps = (over: Partial<PlanDeps>): PlanDeps => ({
  readLock: () => undefined,
  alive: () => true,
  healthy: async () => true,
  ...over,
});
const paths = dataPaths({ GALACTIC_HOME: '/data' });

describe('dataPaths', () => {
  it('follows the server: GALACTIC_HOME, GALACTIC_DB, the lock next to the database', () => {
    expect(paths).toEqual({
      dataDir: '/data',
      configPath: '/data/config.json',
      dbPath: '/data/galactic.sqlite',
      lockPath: '/data/galactic.sqlite.lock',
    });
    expect(dataPaths({ GALACTIC_HOME: '/d', GALACTIC_DB: '/x/db.sqlite' }).lockPath).toBe(
      '/x/db.sqlite.lock',
    );
  });
});

describe('plan', () => {
  it('starts when nobody holds the data, or the holder is gone', async () => {
    expect(await plan(paths, deps({}))).toEqual({ kind: 'start' });
    const holder = { pid: 42, role: 'server', port: 4400 };
    expect(await plan(paths, deps({ readLock: () => holder, alive: () => false }))).toEqual({
      kind: 'start',
    });
  });

  it('attaches to a live server that answers', async () => {
    const holder = { pid: 42, role: 'server', port: 4400 };
    expect(await plan(paths, deps({ readLock: () => holder }))).toEqual({
      kind: 'attach',
      port: 4400,
      pid: 42,
    });
  });

  it('waits for a starting server, an unanswering one, an import', async () => {
    const starting = await plan(paths, deps({ readLock: () => ({ pid: 1, role: 'server' }) }));
    expect(starting).toMatchObject({ kind: 'wait', why: 'Mission Control is starting' });
    const mute = await plan(
      paths,
      deps({ readLock: () => ({ pid: 1, role: 'server', port: 9 }), healthy: async () => false }),
    );
    expect(mute).toMatchObject({ kind: 'wait' });
    const importing = await plan(paths, deps({ readLock: () => ({ pid: 1, role: 'import' }) }));
    expect(importing).toMatchObject({ kind: 'wait', why: 'a galactic import is using the data' });
  });
});

describe('files', () => {
  it('reads the lock leniently and the token from the config or the environment', () => {
    const home = tmp();
    mkdirSync(home, { recursive: true });
    const p = dataPaths({ GALACTIC_HOME: home });
    expect(readLock(p.lockPath)).toBeUndefined();
    writeFileSync(p.lockPath, JSON.stringify({ pid: 7, role: 'server', port: 4400, bootAt: 'x' }));
    expect(readLock(p.lockPath)).toEqual({ pid: 7, role: 'server', port: 4400 });
    writeFileSync(p.lockPath, '{"pid":');
    expect(readLock(p.lockPath)).toBeUndefined();

    expect(readToken({}, p)).toBeUndefined();
    writeFileSync(p.configPath, JSON.stringify({ token: 'from-file' }));
    expect(readToken({}, p)).toBe('from-file');
    expect(readToken({ GALACTIC_TOKEN: 'from-env' }, p)).toBe('from-env');
  });
});

describe('redactLine', () => {
  it("hides the launcher banner's token and leaves other lines alone", () => {
    expect(redactLine('  Token:  abc123')).toBe('  Token:  (hidden)');
    expect(redactLine('Token generated and stored in /x/config.json')).toBe(
      'Token generated and stored in /x/config.json',
    );
  });
});
