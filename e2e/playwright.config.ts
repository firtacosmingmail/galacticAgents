import { defineConfig } from '@playwright/test';

/**
 * Browser smoke tests (P8-05; `docs/tasks/notes/P8-05-smoke.md`). One real server from the
 * production build for the whole run (`support/global-setup.ts`), the tests one at a time against
 * it, each in a fresh browser context.
 *
 * The browser is Playwright's pinned Chromium (`pnpm e2e:install`), or an installed Chrome with
 * `E2E_CHANNEL=chrome`. WebGL runs on SwiftShader (the CPU renderer Chrome ships), on every machine:
 * the same pixels with or without a GPU (CI runners have none), so one set of scene baselines
 * serves macOS and Linux. Screenshots are taken of the canvas only (the DOM over it is hidden in
 * them), so fonts never enter a baseline.
 */
const CI = !!process.env['CI'];

export default defineConfig({
  testDir: './tests',
  globalSetup: './support/global-setup.ts',
  // One server, shared state (the harness's world): one test at a time, in file order.
  fullyParallel: false,
  workers: 1,
  // No retries: a flake is a bug to fix, not to hide (the note says how the suite was checked).
  retries: 0,
  forbidOnly: CI,
  // Generous: SwiftShader on a loaded machine is slow, and every wait is on a condition.
  timeout: 90_000,
  expect: {
    timeout: 20_000,
    toHaveScreenshot: {
      // Tolerant where it must be: the satellites' places on their orbits follow their (random)
      // agent ids — 2–7 px differ between runs at the system's framing (measured, P8-05 note).
      // A black canvas, a missing planet, the wrong framing or a broken material is far beyond
      // this; a shot with more satellites in view raises its own allowance.
      maxDiffPixels: 100,
      threshold: 0.2,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    },
  },
  // Baselines without the platform in the name: SwiftShader makes them the same everywhere.
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  outputDir: './test-results',
  use: {
    browserName: 'chromium',
    ...(process.env['E2E_CHANNEL'] ? { channel: process.env['E2E_CHANNEL'] } : {}),
    headless: true,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    locale: 'en-GB',
    timezoneId: 'UTC',
    // Decorative motion off: the bodies sit at their starting angles, the satellites stand still.
    reducedMotion: 'reduce',
    // The PWA's service worker (P7-01) would cache across runs; the tests talk to the server.
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
  },
});
