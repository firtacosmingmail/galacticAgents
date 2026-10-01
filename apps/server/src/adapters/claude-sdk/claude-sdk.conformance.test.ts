import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { ProcessSupervisor } from '../../runtime/supervisor.js';
import { describeAdapterConformance } from '../conformance.js';
import { ClaudeSdkAdapter } from './claude-sdk-adapter.js';

/**
 * The conformance suite against the real Claude Agent SDK (P1-12). Local-only: it spends real
 * tokens and needs a logged-in Claude Code, so it runs only with `GALACTIC_REAL_CLAUDE=1`:
 *
 *   GALACTIC_REAL_CLAUDE=1 pnpm --filter @galactic/server exec vitest run claude-sdk.conformance
 *
 * Prompts are natural-language instructions that make a Steward do each thing the suite checks.
 * The failure paths (P1-38) reuse them: a deny of the `permission` prompt's `rm -rf` (answered, or
 * by the default destructive-deny policy), an interrupt of `long` while paused and of `ask` while
 * its question is open, a message to `echo` while paused, two `echo` sessions at once, a
 * `kill -9` of the CLI during `long` (crash), a spawn in a missing directory and a resume from a
 * bad ref.
 */
const enabled = process.env['GALACTIC_REAL_CLAUDE'] === '1';

if (!enabled) {
  describe('adapter conformance — claude-sdk', () => {
    it.skip('runs only with GALACTIC_REAL_CLAUDE=1 (spends tokens, needs a Claude login)', () => {});
  });
} else {
  const cwd = mkdtempSync(join(tmpdir(), 'galactic-conformance-'));
  writeFileSync(join(cwd, 'README.md'), '# conformance\n\nA scratch workspace.\n');
  const model = process.env['GALACTIC_MODEL'] ?? 'claude-sonnet-4-5';

  describeAdapterConformance({
    name: 'claude-sdk',
    runtime: 'claude-sdk',
    cwd,
    create: async () => {
      const supervisor = new ProcessSupervisor({ defaults: { graceMs: 20_000, termMs: 5_000 } });
      const adapter = new ClaudeSdkAdapter({ supervisor, model, graceMs: 20_000 });
      return {
        adapter,
        dispose: async () => {
          await adapter.dispose();
          await supervisor.dispose();
        },
        // An external kill -9 of the CLI's process group: the supervisor reports a crash.
        crash: (agentId) => supervisor.get(agentId)?.signal('SIGKILL'),
      };
    },
    prompts: {
      finish:
        'Read README.md in the current directory with the Read tool, then reply with exactly: done',
      ask: 'Before doing anything, use the AskUserQuestion tool to ask me which option I prefer (options: first option, second option). Then reply with exactly the option I chose.',
      permission: `Run the shell command \`rm -rf ${join(cwd, 'scratch-dir')}\` with the Bash tool (it may not exist, that is fine), then reply with exactly: cleaned`,
      long: 'Run the shell command `for i in 1 2 3 4 5 6 7 8 9 10; do echo step $i; sleep 3; done` with the Bash tool, then reply with exactly: finished',
      echo: 'Reply with exactly: ready',
    },
    metered: true,
    resumable: true,
    jobEnd: 'idle',
    stallThresholdMs: 5 * 60_000,
    timeoutMs: 120_000,
    // The SDK starts the CLI after `spawn()` resolved: a bad cwd surfaces as agent.failed(runtime).
    spawnFailure: 'event',
  });
}
