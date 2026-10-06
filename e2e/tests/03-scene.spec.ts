import { expect, test } from '../support/fixtures.js';
import { probeList, sceneProbe, seedScenario } from '../support/world.js';

/**
 * A fake-adapter project in the scene (SPEC §4.1): its body is drawn and labelled with the
 * project, its Waykeeper and Stewards are satellites, a standalone task is an asteroid with its
 * Steward; selecting the project in the panel flies the camera to its body. Asserted through the
 * scene's test hook and its DOM labels, not pixels.
 */
test('a harness project shows its body, its label and its satellites', async ({
  page,
  api,
  openApp,
}) => {
  const world = await seedScenario(api, { stewards: 2, kind: 'planet', asteroid: true });
  await openApp();

  const probe = sceneProbe(page);
  // Every live agent of the scenario has a satellite (and the Harmonizer has its HQ station).
  const agents = [world.waykeeperId, ...world.stewardIds, world.asteroidStewardId!];
  await expect
    .poll(async () => {
      const drawn = await probeList(page, 'satellites');
      return agents.filter((id) => !drawn.includes(id));
    })
    .toEqual([]);
  expect((await probeList(page, 'satellites')).length).toBeGreaterThan(agents.length);

  // The project's body is drawn, labelled with a harness project's title and its state.
  expect(await probeList(page, 'bodies')).toContain(world.bodyId);
  const label = page.locator(`.scene-label[data-body="${world.bodyId}"]`);
  await expect(label.locator('.scene-label-title')).toHaveText(/^Harness project \d+$/);
  await expect(label.locator('.scene-label-state')).toHaveText('in progress');
  const title = (await label.locator('.scene-label-title').textContent())!;

  // Selecting the project in the panel flies the camera to its body (useSelectionSync) and the
  // dock talks to its Waykeeper (SPEC §4.2.2).
  await expect(probe).toHaveAttribute('data-camera', 'system');
  await page
    .getByRole('navigation', { name: 'navigation' })
    .getByText(title, { exact: true })
    .click();
  await expect(probe).toHaveAttribute('data-camera', world.bodyId);
  await expect(page.getByText(`Waykeeper · ${title}`).first()).toBeVisible();
});
