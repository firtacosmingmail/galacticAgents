import { fileURLToPath } from 'node:url';
import { expect, test } from '../support/fixtures.js';
import { clearHarness, probeList, sceneProbe, seedScenario } from '../support/world.js';

/**
 * Screenshot diffs of the scene at a fixed seed (P8-05). Deterministic inputs: the scene's own
 * seeds (star field, belt, surfaces), reduced motion (the bodies at their starting angles, the
 * satellites still), a fixed page clock, the camera resting at the system's framing, the
 * `balanced` tier, a fixed viewport at DPR 1, SwiftShader. What is not fixed: the satellites'
 * places on their orbits follow their agent ids (new on every run) — a few pixels each, within the
 * allowance (`playwright.config.ts`, and the close-up's own below).
 *
 * Update the baselines after an intended visual change: `pnpm e2e --update-snapshots` (see
 * `docs/tasks/notes/P8-05-smoke.md`), look at the new PNGs, commit them.
 */
const SCENE_ONLY = fileURLToPath(new URL('../support/scene-only.css', import.meta.url));

test.use({ viewport: { width: 1600, height: 1000 } });

test('the whole system with a harness project', async ({ page, api, openApp }) => {
  // A known world: nothing of earlier tests, one project on Mars with its Waykeeper and two
  // Stewards (no asteroid: a new asteroid's place depends on how many came before).
  await clearHarness(api);
  const world = await seedScenario(api, {
    stewards: 2,
    kind: 'planet',
    bodyId: 'b-mars',
    asteroid: false,
  });
  await page.clock.install({ time: new Date('2026-01-01T12:00:00Z') });
  await openApp({
    storage: {
      // The legend open would cover part of the canvas's box (hidden anyway, but not drawn).
      'galactic.scene.legend.open': '0',
    },
  });

  const probe = sceneProbe(page);
  await expect(probe).toHaveAttribute('data-camera', 'system');
  await expect
    .poll(async () => {
      const drawn = await probeList(page, 'satellites');
      return [world.waykeeperId, ...world.stewardIds].every((id) => drawn.includes(id));
    })
    .toBe(true);

  const canvas = page.locator('.pnl-scene-canvas canvas');
  // toHaveScreenshot waits until two consecutive shots agree (textures painted, frames settled).
  await expect(canvas).toHaveScreenshot('system.png', { stylePath: SCENE_ONLY });

  // The project's body up close: selected in the panel, the camera flies there and rests.
  const title = (await page
    .locator('.scene-label[data-body="b-mars"] .scene-label-title')
    .textContent())!;
  await page
    .getByRole('navigation', { name: 'navigation' })
    .getByText(title, { exact: true })
    .click();
  await expect(probe).toHaveAttribute('data-camera', 'b-mars');
  await expect(canvas).toHaveScreenshot('mars-project.png', {
    stylePath: SCENE_ONLY,
    // Up close the three satellites (random phases on their orbits) differ by 40–90 px between
    // runs; Mars alone is ~18 000 px.
    maxDiffPixels: 400,
  });
});
