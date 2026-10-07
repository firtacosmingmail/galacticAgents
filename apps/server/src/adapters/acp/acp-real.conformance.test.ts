import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { ProcessSupervisor } from '../../runtime/supervisor.js';
import { describeAdapterConformance } from '../conformance.js';
import { AcpAdapter } from './acp-adapter.js';

/**
 * The conformance suite against a real ACP agent (P8-07). Local-only — it spends real tokens and
 * needs the agent installed and logged in — so it runs only when `GALACTIC_REAL_ACP` names the
 * agent's command line (split on spaces):
 *
 *   GALACTIC_REAL_ACP="claude-agent-acp" pnpm --filter @galactic/server exec vitest run acp-real
 *   GALACTIC_REAL_ACP="gemini --acp" …        GALACTIC_REAL_ACP="codex-acp" …
 *
 * Prompts are natural-language instructions like the claude-sdk target's. `GALACTIC_REAL_ACP_RESUMABLE=0`
 * marks an agent without `loadSession`; `GALACTIC_REAL_ACP_METERED=0` one that reports no cost.
 */
const commandLine = process.env['GALACTIC_REAL_ACP']?.trim();

if (!commandLine) {
  describe('adapter conformance — acp (real agent)', () => {
    it.skip('runs only with GALACTIC_REAL_ACP="<agent command>" (spends tokens, needs a login)', () => {});
  });
} else {
  const [command, ...args] = commandLine.split(/\s+/);
  const cwd = mkdtempSync(join(tmpdir(), 'galactic-acp-real-'));
  writeFileSync(join(cwd, 'README.md'), '# conformance\n\nA scratch workspace.\n');

  describeAdapterConformance({
    name: `acp (${commandLine})`,
    runtime: 'acp',
    cwd,
    create: async () => {
      const supervisor = new ProcessSupervisor({ defaults: { graceMs: 20_000, termMs: 5_000 } });
      const adapter = new AcpAdapter({
        supervisor,
        agent: { command: command!, args },
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
      finish: 'Read README.md in the current directory, then reply with exactly: done',
      ask: 'Before doing anything, ask me (with your question tool) which option I prefer: first option or second option. Then reply with exactly the option I chose.',
      permission: `Run the shell command \`rm -rf ${join(cwd, 'scratch-dir')}\` (it may not exist, that is fine), then reply with exactly: cleaned`,
      long: 'Run the shell command `for i in 1 2 3 4 5 6 7 8 9 10; do echo step $i; sleep 3; done`, then reply with exactly: finished',
      echo: 'Reply with exactly: ready',
    },
    metered: process.env['GALACTIC_REAL_ACP_METERED'] !== '0',
    resumable: process.env['GALACTIC_REAL_ACP_RESUMABLE'] !== '0',
    jobEnd: 'idle',
    stallThresholdMs: 5 * 60_000,
    timeoutMs: 120_000,
  });
}
