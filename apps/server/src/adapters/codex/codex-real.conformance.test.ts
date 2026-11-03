import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { ProcessSupervisor } from '../../runtime/supervisor.js';
import { describeAdapterConformance } from '../conformance.js';
import { CodexAdapter } from './codex-adapter.js';

/**
 * The conformance suite against the real Codex CLI (P11-04). Local-only — it spends the ChatGPT
 * subscription's quota and needs `codex` installed and logged in — so it runs only with
 * `GALACTIC_REAL_CODEX=1`:
 *
 *   GALACTIC_REAL_CODEX=1 npx vitest run src/adapters/codex/codex-real.conformance.test.ts
 *
 * `GALACTIC_REAL_CODEX_COMMAND` names another binary. Prompts are natural-language instructions
 * like the claude-sdk and acp real targets'.
 */
const enabled = process.env['GALACTIC_REAL_CODEX'] === '1';

if (!enabled) {
  describe('adapter conformance — codex (real CLI)', () => {
    it.skip('runs only with GALACTIC_REAL_CODEX=1 (spends quota, needs a ChatGPT login)', () => {});
  });
} else {
  const cwd = mkdtempSync(join(tmpdir(), 'galactic-codex-real-'));
  // A managed Codex home like production's (ruling R7), linked to the user's own login.
  const home = join(mkdtempSync(join(tmpdir(), 'galactic-codex-real-home-')), 'codex-home');
  writeFileSync(join(cwd, 'README.md'), '# conformance\n\nA scratch workspace.\n');

  describeAdapterConformance({
    name: 'codex (real CLI)',
    runtime: 'codex',
    cwd,
    create: async () => {
      const supervisor = new ProcessSupervisor({ defaults: { graceMs: 20_000, termMs: 5_000 } });
      const adapter = new CodexAdapter({
        supervisor,
        command: process.env['GALACTIC_REAL_CODEX_COMMAND'] ?? 'codex',
        home,
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
    stallThresholdMs: 5 * 60_000,
    timeoutMs: 120_000,
  });
}
