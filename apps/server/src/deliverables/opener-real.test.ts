import { describe, expect, it } from 'vitest';
import { Opener } from './opener.js';

/**
 * The opener against the real Mac (P9-03, tagged local check; TECHNOLOGY §9.7). Skipped unless
 * asked for:
 *
 *   GALACTIC_REAL_IDE=1 pnpm --filter @galactic/server exec vitest run opener-real
 *     detects the installed IDEs (read-only: Spotlight and the Applications folders) and prints them;
 *   GALACTIC_REAL_IDE_OPEN=/path/to/a/project …
 *     also opens that folder in the IDE the "Automatic" setting picks (WebStorm on Cosmin's Mac).
 */
const enabled =
  process.platform === 'darwin' &&
  (process.env['GALACTIC_REAL_IDE'] === '1' || process.env['GALACTIC_REAL_IDE_OPEN'] !== undefined);
const folder = process.env['GALACTIC_REAL_IDE_OPEN'];

describe.skipIf(!enabled)('the opener on this Mac (real, local only)', () => {
  it('detects the installed IDEs', async () => {
    const opener = new Opener();
    const started = Date.now();
    const ides = await opener.ides();
    console.log(
      `detected in ${Date.now() - started} ms:`,
      ides.map((i) => `${i.name} (${i.bundleId}) at ${i.path}`),
    );
    expect(ides.length).toBeGreaterThan(0);
  });

  it.skipIf(!folder)('opens the folder in the automatic IDE', async () => {
    const used = await new Opener().openInIde(folder!);
    console.log(`opened ${folder} in ${used.name}`);
  });
});
