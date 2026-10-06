import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PERMISSION_POLICY_PRESETS } from '@galactic/protocol';
import { ProcessSupervisor } from '../../runtime/supervisor.js';
import { describeAdapterConformance } from '../conformance.js';
import { FAKE_PTY_AGENT, FAKE_PTY_IDLE } from './fake-agent.js';
import { PtyAdapter } from './pty-adapter.js';

/**
 * The conformance suite against the scripted terminal agent (P8-08): `fake-pty-agent.sh` run by
 * bash under a real pseudo-terminal (`node-pty`), through the real supervisor. Runs in CI (no
 * network, no model). A terminal agent has no structured tool calls (`toolCalls: false`: the
 * policy-deny and tool-call-count cases are skipped, the permission cases check what the script
 * printed), cannot resume (`resumable: false`), reports no cost (`metered: false`) and runs only
 * under a table that allows what it cannot classify (the trusted preset, decision 112).
 * A job ends with the script's exit: `agent.finished`.
 */
const cwd = mkdtempSync(join(tmpdir(), 'galactic-pty-conformance-'));
writeFileSync(join(cwd, 'README.md'), '# conformance\n');

describeAdapterConformance({
  name: 'pty (scripted terminal agent)',
  runtime: 'pty',
  cwd,
  create: async () => {
    const supervisor = new ProcessSupervisor({ defaults: { graceMs: 3_000, termMs: 2_000 } });
    const adapter = new PtyAdapter({
      supervisor,
      agent: {
        command: 'bash',
        args: [FAKE_PTY_AGENT],
        idlePattern: FAKE_PTY_IDLE,
        quietMs: 120,
      },
      graceMs: 3_000,
      interruptIdleMs: 3_000,
    });
    return {
      adapter,
      dispose: async () => {
        await adapter.dispose();
        await supervisor.dispose();
      },
      // A kill -9 of the terminal's process group from outside: the supervisor reports a crash.
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
  metered: false,
  resumable: false,
  jobEnd: 'finished',
  toolCalls: false,
  permissionEvidence: 'deleted build',
  spawnPolicy: PERMISSION_POLICY_PRESETS.trusted,
  skip: {
    policyDeny: 'a terminal confirmation carries no tool call for the table to deny',
    toolCalls: 'a terminal agent reports no tool calls',
  },
  stallThresholdMs: 400,
  timeoutMs: 8_000,
});
