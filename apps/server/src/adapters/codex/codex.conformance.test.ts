import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessSupervisor } from '../../runtime/supervisor.js';
import { describeAdapterConformance } from '../conformance.js';
import { CodexAdapter } from './codex-adapter.js';
import { FAKE_CODEX_AGENT } from './fake-agent.js';

/**
 * The conformance suite against the fake Codex CLI (P11-04): a real child process speaking
 * app-server JSON-RPC over stdio, spawned through the real supervisor. Runs in CI (no network, no
 * model). Threads persist under a temp state directory shared by every adapter of this file, so a
 * resume after the adapter went away finds them.
 */
const cwd = mkdtempSync(join(tmpdir(), 'galactic-codex-conformance-'));
writeFileSync(join(cwd, 'README.md'), '# conformance\n');
const state = mkdtempSync(join(tmpdir(), 'galactic-codex-state-'));

describeAdapterConformance({
  name: 'codex (fake CLI)',
  runtime: 'codex',
  cwd,
  create: async () => {
    const supervisor = new ProcessSupervisor({ defaults: { graceMs: 3_000, termMs: 2_000 } });
    const adapter = new CodexAdapter({
      supervisor,
      command: process.execPath,
      args: [FAKE_CODEX_AGENT, '--state', state],
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
    askSet: 'scenario:asks-set',
    permission: 'scenario:permission',
    long: 'scenario:long',
    echo: 'scenario:echo',
    stall: 'scenario:stalls',
  },
  // A ChatGPT subscription reports no dollars (P11-02).
  metered: false,
  resumable: true,
  toolCalls: true,
  // A long-lived thread: every job ends in `agent.idle`.
  jobEnd: 'idle',
  stallThresholdMs: 200,
  timeoutMs: 8_000,
});
