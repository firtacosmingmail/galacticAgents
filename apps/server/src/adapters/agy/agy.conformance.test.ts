import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll } from 'vitest';
import { registerAgyHookRoutes } from '../../http/agy-hook-routes.js';
import { ProcessSupervisor } from '../../runtime/supervisor.js';
import { describeAdapterConformance } from '../conformance.js';
import { AgyAdapter } from './agy-adapter.js';
import { FAKE_AGY } from './fake-agent.js';
import { HookBridge } from './hook-bridge.js';

/**
 * The conformance suite against the fake agy CLI (P11-05): a real child process per turn that
 * runs Mission Control's real hook process and tool server from the managed entries in a temp
 * home, spawned through the real supervisor, talking to a real hook bridge over loopback HTTP.
 * Runs in CI (no network, no model). Conversations persist under the temp home, so a resume after
 * the adapter went away finds them.
 */
const cwd = mkdtempSync(join(tmpdir(), 'galactic-agy-conformance-'));
writeFileSync(join(cwd, 'README.md'), '# conformance\n');
const home = mkdtempSync(join(tmpdir(), 'galactic-agy-conformance-home-'));
const stateDir = mkdtempSync(join(tmpdir(), 'galactic-agy-conformance-state-'));
const bridge = new HookBridge();
const app = Fastify();
registerAgyHookRoutes(app, { bridge });
let url = '';
beforeAll(async () => {
  await app.listen({ host: '127.0.0.1', port: 0 });
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/agy-hook`;
});
afterAll(() => app.close());

describeAdapterConformance({
  name: 'agy (fake CLI)',
  runtime: 'agy',
  cwd,
  create: async () => {
    const supervisor = new ProcessSupervisor({ defaults: { graceMs: 3_000, termMs: 2_000 } });
    const adapter = new AgyAdapter({
      supervisor,
      command: process.execPath,
      args: [FAKE_AGY],
      hookUrl: () => url,
      bridge,
      home,
      stateDir,
      graceMs: 3_000,
      startTimeoutMs: 10_000,
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
    finish: 'scenario:happy',
    ask: 'scenario:asks',
    permission: 'scenario:permission',
    long: 'scenario:long',
    echo: 'scenario:echo',
    stall: 'scenario:stalls',
  },
  // A Google subscription reports no dollars (P11-02).
  metered: false,
  resumable: true,
  toolCalls: true,
  // A conversation outlives its turns: every job ends in `agent.idle`.
  jobEnd: 'idle',
  stallThresholdMs: 200,
  timeoutMs: 8_000,
});
