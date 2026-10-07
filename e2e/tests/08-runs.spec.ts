import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Deliverable, HistoryWorkDetail, Project, RunsResponse } from '@galactic/protocol';
import { expect, test } from '../support/fixtures.js';
import { clearHarness, seedScenario, stamp } from '../support/world.js';

/**
 * The runs smoke (P9-10): a harness project whose folder has a `package.json` with a `dev` script
 * (a tiny Node HTTP server on a port the OS picks, printing a line and its address) and the
 * command `npm run dev` added by hand (detection skips the harness's unprepared folders); the
 * panel's Run dialog shows the exact command, the folder and who added it; Run starts it; the output and the port's link appear; the link's
 * server answers; Stop (confirmed) ends it and the port closes. The run is the e2e server's child:
 * the test stops it, and the server's own shutdown would too.
 */

const SHOTS = process.env['E2E_SHOTS'];

const SERVER_JS = `const http = require('node:http');
const server = http.createServer((_req, res) => res.end('e2e dev server ok'));
server.listen(0, '127.0.0.1', () => {
  console.log('e2e dev server ready');
  console.log('listening on http://localhost:' + server.address().port);
});
`;

test('runs: Run dialog, live output, the port link, Stop', async ({ page, api, openApp }) => {
  await clearHarness(api);
  const world = await seedScenario(api, { stewards: 1, asteroid: false });
  const detail = await api.get<HistoryWorkDetail>(`/api/history/work/project/${world.projectId}`);
  const workspace = (detail.work.item as Project).workspace;
  const id = stamp();
  mkdirSync(workspace, { recursive: true });
  const files = ['package.json', 'server.js', '.npmrc'].map((f) => join(workspace, f));
  writeFileSync(
    files[0]!,
    JSON.stringify({ name: `e2e-runs-${id}`, private: true, scripts: { dev: 'node server.js' } }),
  );
  writeFileSync(files[1]!, SERVER_JS);
  // No network from npm itself (its update check), whatever the machine's settings.
  writeFileSync(files[2]!, 'update-notifier=false\nfund=false\naudit=false\n');
  let devId: string | undefined;
  try {
    // The harness's project folder is not a prepared workspace, so detection skips it (P9-05):
    // the command is added by hand, as the user would — the same `npm run dev` it would find.
    const { deliverable: dev } = await api.post<{ deliverable: Deliverable }>('/api/deliverables', {
      projectId: world.projectId,
      kind: 'command',
      title: `dev server ${id}`,
      command: { line: 'npm run dev' },
    });
    expect(dev.command?.cwd).toBeTruthy();
    devId = dev.id;

    await openApp({ listMode: true });
    await page.goto(`/waykeeper/${world.waykeeperId}`);
    const main = page.getByRole('main');
    await main.getByRole('button', { name: 'Deliverables', exact: true }).click();
    const row = page.locator(`[data-deliverable="${dev.id}"]`);
    await expect(row).toContainText('not run yet');

    // The confirmation: the exact command, its folder, what the script runs.
    await row.getByRole('button', { name: 'Run…' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('The exact command')).toHaveValue('npm run dev');
    await expect(dialog).toContainText('added by you');
    await expect(dialog).toContainText(workspace.split('/').at(-1)!);
    await expect(dialog).toContainText('PATH');
    const run = dialog.getByRole('button', { name: 'Run', exact: true });
    await expect(run).toBeEnabled();
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'run-dialog.png') });
    await run.click();
    await expect(dialog).toBeHidden();

    // Live: the state, the output and the port as a link that answers.
    await expect(row).toContainText(/running · :\d+/);
    const link = row.getByRole('link', { name: /^http:\/\/localhost:\d+$/ });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    const href = (await link.getAttribute('href'))!;
    const answer = await fetch(href.replace('localhost', '127.0.0.1'));
    expect(await answer.text()).toBe('e2e dev server ok');
    const output = row.getByRole('region', { name: 'output' });
    await expect(output.locator('.xterm-rows')).toContainText('e2e dev server ready');
    // The dock's switch marks the running command.
    await expect(main.getByRole('button', { name: /Deliverables/ })).toContainText('▶');
    if (SHOTS) {
      await row.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(SHOTS, 'run-output.png') });
    }
    await output.getByRole('button', { name: 'Plain text' }).click();
    await expect(output.getByRole('region', { name: 'the output as text' })).toContainText(
      'listening on http://localhost:',
    );

    // Stop, confirmed.
    await row.getByRole('button', { name: 'Stop' }).click();
    const confirm = row.getByRole('group', { name: 'confirm' });
    await expect(confirm).toContainText('everything it started');
    await confirm.getByRole('button', { name: 'Stop' }).click();
    await expect(row).toContainText(/stopped/);
    await expect(row.getByRole('button', { name: 'Run…' })).toBeVisible();
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

    // The history lists the run.
    await row.getByRole('button', { name: 'Runs' }).click();
    await expect(row.getByRole('region', { name: 'runs' })).toContainText(/stopped/);
    if (SHOTS) {
      await row.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(SHOTS, 'run-stopped.png') });
      // The dialog in a narrow window.
      await page.setViewportSize({ width: 390, height: 844 });
      await row.getByRole('button', { name: 'Run…' }).click();
      await expect(page.getByRole('dialog').getByLabel('The exact command')).toBeVisible();
      await page.screenshot({ path: join(SHOTS, 'run-dialog-narrow.png') });
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
      await expect(page.getByRole('dialog')).toBeHidden();
    }
  } finally {
    // Never leave the run behind (the server would stop it at its shutdown too).
    if (devId) {
      const { runs } = await api.get<RunsResponse>(`/api/deliverables/${devId}/runs`);
      for (const r of runs.filter((r) => r.state !== 'ended')) {
        await api.post(`/api/runs/${r.id}/stop`).catch(() => undefined);
      }
    }
    for (const f of files) rmSync(f, { force: true });
  }
});
