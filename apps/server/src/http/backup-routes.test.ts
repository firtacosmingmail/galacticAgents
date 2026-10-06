import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BackupNowResponse, BackupsResponse, MapExport } from '@galactic/protocol';
import { BackupService } from '../db/backup.js';
import { openDatabase } from '../db/database.js';
import { seedDemoProject } from '../domain/demo.js';
import { EventLog } from '../domain/event-log.js';
import { startTestApp, testConfig, TEST_TOKEN } from '../test/harness.js';

/**
 * P8-03 — `GET`/`POST /api/backups` and `GET /api/export`: bearer-guarded, Mac only (decision 90)
 * unless `autoApproveRemote`.
 */

const apps: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
});

async function start(autoApproveRemote = false) {
  const config = testConfig({ autoApproveRemote });
  const db = openDatabase(':memory:');
  const log = new EventLog(db);
  log.runCommand((ctx) => seedDemoProject(ctx));
  const backups = new BackupService({
    db,
    dir: join(config.dataDir, 'backups'),
    freeBytes: () => 100 * 2 ** 30,
  });
  const t = await startTestApp({ config, log, backups });
  apps.push(t);
  return { t, log };
}

const call = (
  base: string,
  method: 'GET' | 'POST',
  path: string,
  headers: Record<string, string> = {},
) =>
  fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${TEST_TOKEN}`, ...headers },
  });

describe('backup and export routes (P8-03)', () => {
  it('backs up now, lists the backups and exports the map', async () => {
    const { t, log } = await start();
    const now = await call(t.baseUrl, 'POST', '/api/backups');
    expect(now.status).toBe(200);
    const outcome = BackupNowResponse.parse(await now.json());
    expect(outcome.outcome).toBe('ok');

    const list = BackupsResponse.parse(await (await call(t.baseUrl, 'GET', '/api/backups')).json());
    expect(list.backups.map((b) => b.name)).toEqual([outcome.name]);
    expect(list.last).toEqual(outcome);
    expect(list.schedule).toMatchObject({ enabled: true, keepDaily: 7 });

    const res = await call(t.baseUrl, 'GET', '/api/export');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="galactic-map-/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const exported = MapExport.parse(await res.json());
    expect(exported.events).toHaveLength(log.currentSeq());
    expect(exported.transcripts).toBeUndefined();
    const withTranscripts = MapExport.parse(
      await (await call(t.baseUrl, 'GET', '/api/export?transcripts=1')).json(),
    );
    expect(withTranscripts.transcripts).toEqual({ chunks: [], compactions: [] });
    expect((await call(t.baseUrl, 'GET', '/api/export?transcripts=maybe')).status).toBe(400);
  });

  it('needs the token', async () => {
    const { t } = await start();
    for (const [method, path] of [
      ['GET', '/api/backups'],
      ['POST', '/api/backups'],
      ['GET', '/api/export'],
    ] as const) {
      const res = await fetch(`${t.baseUrl}${path}`, { method });
      expect(res.status).toBe(401);
    }
  });

  it('refuses a remote client unless the server trusts remote clients', async () => {
    const remote = { 'x-forwarded-for': '100.64.0.2', host: 'mymac.tail1234.ts.net' };
    const { t } = await start();
    for (const [method, path] of [
      ['GET', '/api/backups'],
      ['POST', '/api/backups'],
      ['GET', '/api/export'],
    ] as const) {
      const res = await call(t.baseUrl, method, path, remote);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'remote_control' });
    }
    const trusting = await start(true);
    expect((await call(trusting.t.baseUrl, 'GET', '/api/backups', remote)).status).toBe(200);
  });
});
