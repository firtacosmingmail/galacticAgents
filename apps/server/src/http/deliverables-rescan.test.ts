import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { FOLDER_KEY } from '../deliverables/detection.js';
import { composeRuntime } from '../runtime/compose.js';
import { startTestApp, TEST_TOKEN } from '../test/harness.js';
import { gitRunner } from '../workspace/git.js';

/**
 * The panel's Rescan wired end to end (P9-05 + P9-07): `POST /api/projects/:id/deliverables/rescan`
 * runs the composed detection's `detectProject` — the same scan as after a merge — and is the
 * only route of that name.
 */

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe('POST /api/projects/:id/deliverables/rescan', () => {
  it("runs the composed detection over the project's folder", async () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-rescan-')));
    cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
    for (const d of ['home', 'data', 'projects/web']) mkdirSync(join(tmp, d), { recursive: true });
    const composed = composeRuntime(openDatabase(':memory:'), {
      workspaces: {
        projectsRoot: join(tmp, 'projects'),
        dataDir: join(tmp, 'data'),
        home: join(tmp, 'home'),
        git: gitRunner({ env: GIT_ENV }),
      },
      detection: { minIntervalMs: 0 },
    });
    cleanups.push(() => composed.dispose());
    const folder = join(tmp, 'projects', 'web');
    const project = (await composed.commands.createProject({ name: 'Web', workspace: folder }))
      .value;
    await composed.workspaces!.prepareProject(project.id, { initGit: true });
    await composed.detection!.detectProject(project.id);

    const scans: string[] = [];
    const t = await startTestApp({
      log: composed.log,
      commands: composed.commands,
      rescanDeliverables: (id) => (scans.push(id), composed.detection!.detectProject(id)),
    });
    cleanups.push(() => t.stop());
    const rescan = (id: string) =>
      fetch(`${t.baseUrl}/api/projects/${id}/deliverables/rescan`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
      });

    // A script written by hand, outside any merge: Rescan finds it.
    writeFileSync(join(folder, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
    const res = await rescan(project.id);
    expect(res.status).toBe(200);
    expect(scans).toEqual([project.id]);
    const keys = composed.log.tables.deliverables
      .of({ projectId: project.id })
      .filter((d) => d.removedAt === undefined)
      .map((d) => d.detectedKey);
    expect(keys).toEqual([FOLDER_KEY, 'package.json#dev']);

    expect((await rescan('p-none')).status).toBe(404);
    expect(scans).toEqual([project.id]);
    // One route of that name (Fastify refuses a second registration at startup).
    expect(
      t.app.fastify.hasRoute({ method: 'POST', url: '/api/projects/:id/deliverables/rescan' }),
    ).toBe(true);
  });

  it('is not registered without a rescan (a server without detection)', async () => {
    const composed = composeRuntime(openDatabase(':memory:'));
    cleanups.push(() => composed.dispose());
    const t = await startTestApp({ log: composed.log, commands: composed.commands });
    cleanups.push(() => t.stop());
    expect(
      t.app.fastify.hasRoute({ method: 'POST', url: '/api/projects/:id/deliverables/rescan' }),
    ).toBe(false);
  });
});
