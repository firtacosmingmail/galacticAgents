import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@galactic/protocol';
import { registerAgyHookRoutes } from '../../http/agy-hook-routes.js';
import { ProcessSupervisor } from '../../runtime/supervisor.js';
import { describeAdapterConformance } from '../conformance.js';
import { AgyAdapter } from './agy-adapter.js';
import { HookBridge } from './hook-bridge.js';
import { brainDir } from './images.js';

/**
 * The conformance suite against the real Antigravity CLI (P11-05). Local-only — it spends the
 * Google subscription's quota, needs `agy` installed and logged in, and adds Mission Control's
 * entries to the real `~/.gemini/config/hooks.json` and `mcp_config.json` for the run (removed
 * again by `dispose`, the files left byte-identical) — so it runs only with `GALACTIC_REAL_AGY=1`:
 *
 *   GALACTIC_REAL_AGY=1 npx vitest run src/adapters/agy/agy-real.conformance.test.ts
 *
 * `GALACTIC_REAL_AGY_COMMAND` names another binary. One extra case generates one image and checks
 * the copy into the worktree (an image costs a large share of the weekly quota: keep it to one);
 * `GALACTIC_REAL_AGY_ONLY_IMAGE=1` runs that case alone.
 */
const enabled = process.env['GALACTIC_REAL_AGY'] === '1';

if (!enabled) {
  describe('adapter conformance — agy (real CLI)', () => {
    it.skip('runs only with GALACTIC_REAL_AGY=1 (spends quota, needs a Google login)', () => {});
  });
} else {
  const cwd = mkdtempSync(join(tmpdir(), 'galactic-agy-real-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'galactic-agy-real-state-'));
  writeFileSync(join(cwd, 'README.md'), '# conformance\n\nA scratch workspace.\n');
  const bridge = new HookBridge();
  const app = Fastify();
  registerAgyHookRoutes(app, { bridge });
  let url = '';
  beforeAll(async () => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/agy-hook`;
  });
  afterAll(() => app.close());

  describe('agy (real CLI): a generated image', () => {
    it('lands in the worktree byte-equal', { timeout: 600_000 }, async () => {
      const work = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-agy-real-image-')));
      const supervisor = new ProcessSupervisor({});
      const adapter = new AgyAdapter({
        supervisor,
        command: process.env['GALACTIC_REAL_AGY_COMMAND'] ?? 'agy',
        hookUrl: () => url,
        bridge,
        home: homedir(),
        stateDir,
      });
      const events: AgentEvent[] = [];
      void (async () => {
        for await (const e of adapter.events) events.push(e);
      })();
      try {
        const handle = await adapter.spawn({
          agentId: 'real-image',
          role: 'steward',
          cwd: work,
          prompt:
            'Generate one small image of a plain red circle on white. Do not copy or move the file anywhere. Then reply with exactly: done',
          caps: { maxWallClockMs: 600_000, maxToolCalls: 50 },
          gate: { check: () => ({ decision: 'allow' }) },
        });
        const t0 = Date.now();
        while (
          !events.some((e) => ['agent.idle', 'agent.failed', 'agent.stopped'].includes(e.type))
        ) {
          if (Date.now() - t0 > 540_000) throw new Error('no idle in time');
          await new Promise((r) => setTimeout(r, 500));
        }
        expect(events.map((e) => e.type)).toContain('agent.idle');
        const folder = join(work, 'generated-images');
        expect(existsSync(folder)).toBe(true);
        const copied = readdirSync(folder);
        expect(copied.length).toBeGreaterThan(0);
        const brain = brainDir(homedir(), handle.sessionRef!.slice(4));
        for (const name of copied) {
          expect(readFileSync(join(folder, name)).equals(readFileSync(join(brain, name)))).toBe(
            true,
          );
        }
      } finally {
        await adapter.dispose();
        await supervisor.dispose();
      }
    });
  });

  if (process.env['GALACTIC_REAL_AGY_ONLY_IMAGE'] !== '1')
    describeAdapterConformance({
      name: 'agy (real CLI)',
      runtime: 'agy',
      cwd,
      create: async () => {
        const supervisor = new ProcessSupervisor({ defaults: { graceMs: 20_000, termMs: 5_000 } });
        const adapter = new AgyAdapter({
          supervisor,
          command: process.env['GALACTIC_REAL_AGY_COMMAND'] ?? 'agy',
          hookUrl: () => url,
          bridge,
          home: homedir(),
          stateDir,
          graceMs: 20_000,
        });
        return {
          adapter,
          dispose: async () => {
            await adapter.dispose();
            await supervisor.dispose();
          },
          crash: (agentId) => supervisor.get(agentId)?.signal('SIGKILL'),
        };
      },
      prompts: {
        finish: 'Run the shell command `cat README.md`, then reply with exactly: done',
        ask: 'Before doing anything, ask me which option I prefer: first option or second option. Then reply with exactly the option I chose.',
        permission: `Run the shell command \`rm -r ${join(cwd, 'scratch-dir')}\` (it may not exist, that is fine), then reply with exactly: cleaned`,
        long: 'Run the shell command `for i in 1 2 3 4 5 6 7 8 9 10; do echo step $i; sleep 3; done`, then reply with exactly: finished',
        echo: 'Reply with exactly: ready',
      },
      metered: false,
      resumable: true,
      toolCalls: true,
      jobEnd: 'idle',
      // Ruling R11: after a hook deny the real model goes looking for why (reads of ~/.gemini,
      // `ls ..`, a web search), and the gate rightly asks about each — the denied call never runs.
      skip: {
        policyDeny:
          'after a deny Gemini explores outside the workspace and each read correctly asks (ruling R11)',
      },
      stallThresholdMs: 5 * 60_000,
      timeoutMs: 180_000,
    });
}
