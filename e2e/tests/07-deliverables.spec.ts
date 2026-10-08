import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Deliverable, HistoryWorkDetail, Project } from '@galactic/protocol';
import { expect, test } from '../support/fixtures.js';
import { png } from '../support/png.js';
import { clearHarness, seedScenario, stamp } from '../support/world.js';

/**
 * The deliverables smoke (P9-09): a harness project with a Markdown file in its folder and a
 * screenshot added from outside it (copied into the project's `deliverables/` folder), both
 * declared through the API as the user; the panel's Deliverables view lists them, views the text
 * and the image, and downloads the file through a one-time link. Nothing is opened on the Mac:
 * Open and Reveal are never clicked here.
 */

const SHOTS = process.env['E2E_SHOTS'];

test('deliverables: listed in the project view, viewed (text and image), downloaded', async ({
  page,
  api,
  openApp,
}) => {
  // Earlier tests took the planets: the harness's work is archived first (its bodies freed).
  await clearHarness(api);
  const world = await seedScenario(api, { stewards: 1, asteroid: false });
  const detail = await api.get<HistoryWorkDetail>(`/api/history/work/project/${world.projectId}`);
  const workspace = (detail.work.item as Project).workspace;
  const id = stamp();
  mkdirSync(workspace, { recursive: true });
  const notesPath = join(workspace, `NOTES-${id}.md`);
  writeFileSync(
    notesPath,
    `# Release ${id}\n\nThe **login page** is done.\n\n<script>window.__pwned = 1</script>\n\n[docs](https://example.com/docs)\n`,
  );
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-e2e-shot-')));
  const shotPath = join(outside, `login-${id}.png`);
  writeFileSync(shotPath, png());
  // The copy the server makes in the project's deliverables/ folder (the app never deletes it;
  // the test does, since the harness's project folders are shared temp folders).
  let copied: string | undefined;
  try {
    await api.post('/api/deliverables', {
      projectId: world.projectId,
      kind: 'file',
      title: `Release notes ${id}`,
      path: notesPath,
    });
    const added = await api.post<{ deliverable: Deliverable }>('/api/deliverables', {
      taskId: world.taskIds[0],
      kind: 'image',
      title: `Login screenshot ${id}`,
      description: 'The login page',
      path: shotPath,
    });
    copied = added.deliverable.location?.path;
    expect(added.deliverable.location?.storage).toBe('copy');

    await openApp({ listMode: true });
    await page.goto(`/waykeeper/${world.waykeeperId}`);
    const main = page.getByRole('main');
    const third = main.getByRole('button', { name: 'Deliverables', exact: true });
    await third.click();
    await expect(third).toHaveAttribute('aria-pressed', 'true');
    // The chat stays mounted under the view, hidden.
    await expect(main.locator('.sts-pane-chat')).toHaveClass(/is-hidden/);
    const view = page.getByTestId('deliverables-project');
    const notes = view.getByRole('listitem', { name: `file Release notes ${id}` });
    const shot = view.getByRole('listitem', { name: `image Login screenshot ${id}` });
    await expect(notes).toBeVisible();
    await expect(shot).toContainText('in the deliverables folder');
    await expect(view.locator('.dlv-folder')).toContainText('excluded from git on this Mac');
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'project-view.png') });

    // The text, rendered: its raw HTML dropped, never run.
    await notes.getByRole('button', { name: 'View' }).click();
    const viewer = notes.getByTestId('deliverable-viewer');
    await expect(viewer.getByRole('heading', { name: `Release ${id}` })).toBeVisible();
    await expect(viewer.getByRole('link', { name: 'docs' })).toHaveAttribute('rel', /noopener/);
    expect(await page.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined();
    expect(await viewer.locator('script').count()).toBe(0);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'markdown-viewer.png') });
    await viewer.getByRole('button', { name: 'Source' }).click();
    await expect(viewer.locator('pre code')).toContainText('<script>window.__pwned = 1</script>');
    await viewer.getByRole('button', { name: 'Close preview' }).click();

    // The image, from a blob: URL (no token in any address).
    await shot.getByRole('button', { name: 'View' }).click();
    const img = shot.getByTestId('deliverable-viewer').locator('img');
    await expect(img).toHaveAttribute('src', /^blob:/);
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(160);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'image-viewer.png') });

    // Download through a one-time ticket.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      notes.getByRole('button', { name: 'Download' }).click(),
    ]);
    expect(download.url()).toMatch(/\/files\/[A-Za-z0-9_-]+$/);
    expect(download.suggestedFilename()).toBe(`NOTES-${id}.md`);
    const saved = await download.path();
    expect(readFileSync(saved, 'utf8')).toContain(`# Release ${id}`);
    // The link was used: a second fetch of it is refused.
    const again = await page.request.get(download.url());
    expect(again.status()).toBe(410);

    // The Steward view lists the task's screenshot.
    await page.goto(`/steward/${world.stewardIds[0]}`);
    const section = page.getByTestId('deliverables-task');
    await expect(section.getByText(`Login screenshot ${id}`)).toBeVisible();
    if (SHOTS) {
      await section.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(SHOTS, 'steward-section.png') });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/waykeeper/${world.waykeeperId}`);
      await expect(page.getByTestId('deliverables-project')).toBeVisible();
      await page.screenshot({ path: join(SHOTS, 'narrow.png') });
    }
  } finally {
    rmSync(notesPath, { force: true });
    if (copied) rmSync(copied, { force: true });
    // The folders this test made, when nothing else is in them: the task's subfolder, the
    // deliverables/ folder and the harness project's folder.
    const made = copied ? [dirname(copied), dirname(dirname(copied))] : [];
    for (const dir of [...made, workspace]) {
      try {
        rmdirSync(dir);
      } catch {
        // not empty, or already gone
      }
    }
    rmSync(outside, { recursive: true, force: true });
  }
});
