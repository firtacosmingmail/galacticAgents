import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessSupervisor } from '../../runtime/supervisor.js';
import { describeAdapterConformance } from '../conformance.js';
import { AcpAdapter } from './acp-adapter.js';
import { FAKE_ACP_AGENT } from './fake-agent.js';

/**
 * The conformance suite against the fake ACP agent (P8-07): a real child process speaking ACP over
 * stdio through the official SDK on both sides, spawned through the real supervisor. Runs in CI
 * (no network, no model). Sessions persist under a temp state directory shared by every adapter
 * of this file, so a resume after the adapter went away finds them.
 */
const cwd = mkdtempSync(join(tmpdir(), 'galactic-acp-conformance-'));
writeFileSync(join(cwd, 'README.md'), '# conformance\n');
const state = mkdtempSync(join(tmpdir(), 'galactic-acp-state-'));

describeAdapterConformance({
  name: 'acp (fake agent)',
  runtime: 'acp',
  cwd,
  create: async () => {
    const supervisor = new ProcessSupervisor({ defaults: { graceMs: 3_000, termMs: 2_000 } });
    const adapter = new AcpAdapter({
      supervisor,
      agent: { command: process.execPath, args: [FAKE_ACP_AGENT, '--state', state] },
      graceMs: 3_000,
      startTimeoutMs: 10_000,
    });
    return {
      adapter,
      dispose: async () => {
        await adapter.dispose();
        await supervisor.dispose();
      },
      // A kill -9 of the agent's process group from outside: the supervisor reports a crash.
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
  metered: true,
  resumable: true,
  // A long-lived session like the SDK's: every job ends in `agent.idle`.
  jobEnd: 'idle',
  stallThresholdMs: 200,
  timeoutMs: 8_000,
});
