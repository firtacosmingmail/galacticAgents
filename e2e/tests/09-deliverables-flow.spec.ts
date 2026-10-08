import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import type {
  Deliverable,
  DeliverablesResponse,
  HistoryWorkDetail,
  Project,
  RunsResponse,
} from '@galactic/protocol';
import { expect, test, type Api } from '../support/fixtures.js';
import { png } from '../support/png.js';
import { REMOTE_HOST } from '../support/server.js';
import { clearHarness, seedScenario, stamp } from '../support/world.js';

/**
 * The deliverables flow end to end (P9-12; PHASE_9 "P9-12"): a harness project whose folder is a
 * real, prepared workspace (so detection scans it, as it does a user's project); its harness
 * Steward declares an image and a text file through the agents' declaration service; both show
 * in the Steward view and in the project's Deliverables; the `dev` script of the folder's
 * `package.json` is detected (never added by hand), confirmed in the Run dialog with what it runs
 * as the file says now, and runs a fixture server whose output and port appear; Stop ends it. A
 * second test loads the panel as a remote client (a host name that is not loopback, like the
 * phone's): it lists the same deliverables but offers no open and no run, and the server refuses
 * the page's own attempts.
 */

const SERVER_JS = `const http = require('node:http');
const server = http.createServer((_req, res) => res.end('e2e flow server ok'));
server.listen(0, '127.0.0.1', () => {
  console.log('e2e flow server ready');
  console.log('listening on http://localhost:' + server.address().port);
});
`;

interface Flow {
  projectId: string;
  waykeeperId: string;
  stewardId: string;
  taskId: string;
  workspace: string;
  shot: Deliverable;
  notes: Deliverable;
  dev: Deliverable;
  files: string[];
  id: string;
}

let flow: Flow | undefined;

/** The detected row of `key` once the project's scan listed it. */
async function detected(api: Api, projectId: string, key: string): Promise<Deliverable> {
  let found: Deliverable | undefined;
  await expect
    .poll(
      async () => {
        const { deliverables } = await api.get<DeliverablesResponse>(
          `/api/deliverables?projectId=${projectId}`,
        );
        found = deliverables.find((d) => d.detectedKey === key && d.removedAt === undefined);
        return found !== undefined;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  return found!;
}

async function setUp(api: Api): Promise<Flow> {
  await clearHarness(api);
  const world = await seedScenario(api, { stewards: 1, asteroid: false, prepare: true });
  const detail = await api.get<HistoryWorkDetail>(`/api/history/work/project/${world.projectId}`);
  const workspace = (detail.work.item as Project).workspace;
  const id = stamp();
  const files = {
    shot: join(workspace, `screenshot-${id}.png`),
    notes: join(workspace, `NOTES-${id}.txt`),
    pkg: join(workspace, 'package.json'),
    server: join(workspace, 'server.js'),
    npmrc: join(workspace, '.npmrc'),
  };
  writeFileSync(files.shot, png());
  writeFileSync(files.notes, `Release ${id}\nThe login page is done.\n`);
  writeFileSync(
    files.pkg,
    JSON.stringify({ name: `e2e-flow-${id}`, private: true, scripts: { dev: 'node server.js' } }),
  );
  writeFileSync(files.server, SERVER_JS);
  // No network from npm itself (its update check), whatever the machine's settings.
  writeFileSync(files.npmrc, 'update-notifier=false\nfund=false\naudit=false\n');

  // The harness Steward declares both, as its `declare_deliverable` tool would.
  const stewardId = world.stewardIds[0]!;
  const { deliverable: shot } = await api.post<{ deliverable: Deliverable }>(
    `/dev/harness/agents/${stewardId}/declare`,
    { kind: 'image', title: `Screenshot ${id}`, path: files.shot },
  );
  const { deliverable: notes } = await api.post<{ deliverable: Deliverable }>(
    `/dev/harness/agents/${stewardId}/declare`,
    { kind: 'file', title: `Release notes ${id}`, path: files.notes },
  );
  expect(shot).toMatchObject({ source: 'agent', taskId: world.taskIds[0] });

  // The folder's run scripts: the panel's Rescan (the scan after the folder was prepared
  // happened before package.json was there).
  await api.post(`/api/projects/${world.projectId}/deliverables/rescan`);
  const dev = await detected(api, world.projectId, 'package.json#dev');
  expect(dev).toMatchObject({ source: 'detected', command: { line: 'npm run dev' } });

  return {
    projectId: world.projectId,
    waykeeperId: world.waykeeperId,
    stewardId,
    taskId: world.taskIds[0]!,
    workspace,
    shot,
    notes,
    dev,
    files: Object.values(files),
    id,
  };
}

test.afterAll(async () => {
  // The files this suite made in the harness project's folder (the app never deletes them).
  for (const f of flow?.files ?? []) rmSync(f, { force: true });
});

test('a Steward’s image and text file, a detected dev script: listed, run, stopped', async ({
  page,
  api,
  openApp,
}) => {
  flow = await setUp(api);
  const { id } = flow;
  try {
    await openApp({ listMode: true });

    // The Steward view lists what its Steward declared.
    await page.goto(`/steward/${flow.stewardId}`);
    const section = page.getByTestId('deliverables-task');
    await expect(section.getByText(`Screenshot ${id}`)).toBeVisible();
    await expect(section.getByText(`Release notes ${id}`)).toBeVisible();

    // The project's Deliverables: the task's two, the folder and the detected command.
    await page.goto(`/waykeeper/${flow.waykeeperId}`);
    const main = page.getByRole('main');
    await main.getByRole('button', { name: 'Deliverables', exact: true }).click();
    const view = page.getByTestId('deliverables-project');
    const shotRow = view.getByRole('listitem', { name: `image Screenshot ${id}` });
    const notesRow = view.getByRole('listitem', { name: `file Release notes ${id}` });
    await expect(shotRow).toBeVisible();
    await expect(notesRow).toBeVisible();
    await shotRow.getByRole('button', { name: 'View' }).click();
    const img = shotRow.getByTestId('deliverable-viewer').locator('img');
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(160);
    await notesRow.getByRole('button', { name: 'View' }).click();
    await expect(notesRow.getByTestId('deliverable-viewer')).toContainText(`Release ${id}`);

    // The detected script: the Run dialog shows the exact line and what it runs now.
    const row = page.locator(`[data-deliverable="${flow.dev.id}"]`);
    await expect(row).toContainText('not run yet');
    await row.getByRole('button', { name: 'Run…' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByTestId('run-line-shown')).toHaveText('npm run dev');
    await expect(dialog).toContainText('found in package.json');
    await expect(dialog.getByRole('region', { name: "the script's body" })).toContainText(
      'node server.js',
    );
    await dialog.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(dialog).toBeHidden();

    // Its output and its port.
    await expect(row).toContainText(/running · :\d+/);
    const link = row.getByRole('link', { name: /^http:\/\/localhost:\d+$/ });
    await expect(link).toBeVisible();
    const href = (await link.getAttribute('href'))!;
    const answer = await fetch(href.replace('localhost', '127.0.0.1'));
    expect(await answer.text()).toBe('e2e flow server ok');
    const output = row.getByRole('region', { name: 'output' });
    await expect(output.locator('.xterm-rows')).toContainText('e2e flow server ready');

    // Stop ends it, and its port closes.
    await row.getByRole('button', { name: 'Stop' }).click();
    await row.getByRole('group', { name: 'confirm' }).getByRole('button', { name: 'Stop' }).click();
    await expect(row).toContainText(/stopped/);
    await expect
      .poll(async () => {
        try {
          await fetch(href.replace('localhost', '127.0.0.1'), {
            signal: AbortSignal.timeout(1000),
          });
          return 'open';
        } catch {
          return 'closed';
        }
      })
      .toBe('closed');
  } finally {
    const { runs } = await api.get<RunsResponse>(`/api/deliverables/${flow.dev.id}/runs`);
    for (const r of runs.filter((r) => r.state !== 'ended')) {
      await api.post(`/api/runs/${r.id}/stop`).catch(() => undefined);
    }
  }
});

test('a remote client’s page lists the deliverables but cannot open or run them', async ({
  api,
  token,
  baseURL,
}) => {
  flow ??= await setUp(api);
  const remote = new URL(baseURL!);
  remote.hostname = REMOTE_HOST;
  const origin = remote.origin;
  // Its own browser: the remote name resolves to this machine there only, and is treated as a
  // secure origin as the phone's HTTPS address is.
  const browser = await chromium.launch({
    ...(process.env['E2E_CHANNEL'] ? { channel: process.env['E2E_CHANNEL'] } : {}),
    args: [
      `--host-resolver-rules=MAP ${REMOTE_HOST} 127.0.0.1`,
      `--unsafely-treat-insecure-origin-as-secure=${origin}`,
    ],
  });
  try {
    const context = await browser.newContext({
      serviceWorkers: 'block',
      viewport: { width: 1280, height: 800 },
      colorScheme: 'dark',
      locale: 'en-GB',
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      try {
        localStorage.setItem('galactic.scene.visible', '0');
      } catch {
        /* the defaults apply */
      }
    });
    await page.goto(`${origin}/#token=${encodeURIComponent(token)}`);
    await expect(page.locator('.pnl-conn-live')).toBeVisible();
    await page.goto(`${origin}/waykeeper/${flow.waykeeperId}`);
    await expect(page.locator('.pnl-conn-live')).toBeVisible();
    await page.getByRole('main').getByRole('button', { name: 'Deliverables', exact: true }).click();
    const view = page.getByTestId('deliverables-project');
    const notesRow = view.getByRole('listitem', { name: `file Release notes ${flow.id}` });
    await expect(notesRow).toBeVisible();
    // Viewing works; opening on the Mac is not offered.
    await expect(notesRow.getByRole('button', { name: 'View' })).toBeVisible();
    await expect(notesRow.getByRole('button', { name: /^Open/ })).toHaveCount(0);
    await expect(notesRow.getByRole('button', { name: /Reveal/ })).toHaveCount(0);
    // The command: no Run here — "on the Mac".
    const row = page.locator(`[data-deliverable="${flow.dev.id}"]`);
    await expect(row).toBeVisible();
    await expect(row.getByRole('button', { name: 'Run…' })).toHaveCount(0);
    await expect(row).toContainText('on the Mac');

    // The page's own attempts are refused by the server (decision 131), whatever it sends.
    const attempts = await page.evaluate(
      async ({ token, devId, notesId }) => {
        const call = async (path: string, body: unknown) => {
          const res = await fetch(path, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          return { status: res.status, error: ((await res.json()) as { error?: string }).error };
        };
        return {
          run: await call(`/api/deliverables/${devId}/runs`, { version: 1, confirmation: 'x.y' }),
          open: await call(`/api/deliverables/${notesId}/open`, { action: 'open' }),
          reveal: await call(`/api/deliverables/${notesId}/open`, { action: 'reveal' }),
        };
      },
      { token, devId: flow.dev.id, notesId: flow.notes.id },
    );
    expect(attempts).toEqual({
      run: { status: 403, error: 'remote_control' },
      open: { status: 403, error: 'remote_control' },
      reveal: { status: 403, error: 'remote_control' },
    });
    await context.close();
  } finally {
    await browser.close();
  }
});
