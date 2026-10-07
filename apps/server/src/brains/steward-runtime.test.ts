import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRuntime, Id } from '@galactic/protocol';
import { AcpAdapter } from '../adapters/acp/acp-adapter.js';
import { FAKE_ACP_AGENT } from '../adapters/acp/fake-agent.js';
import { ProcessSupervisor } from '../runtime/supervisor.js';
import { gitRunner } from '../workspace/git.js';
import { harmonizerBrain } from './harmonizer/index.js';
import { brainHarness, type BrainHarness } from './testing/index.js';

/**
 * The `stewardRuntime` setting (P8-07): a brain on one runtime spawns its Stewards on the runtime
 * the setting names, read at every spawn — here a scripted Harmonizer on the fake runtime starts
 * an asteroid Steward that runs as a real ACP agent process (the fake ACP agent), reports by
 * ending its turn, and is closed.
 */

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const USER = { type: 'user' } as const;

let tmp: string;
let h: BrainHarness;
let supervisor: ProcessSupervisor;
let acp: AcpAdapter;
let stewardRuntime: AgentRuntime | undefined;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-sr-')));
  for (const d of ['home', 'data', 'projects', 'acp-state']) mkdirSync(join(tmp, d));
  supervisor = new ProcessSupervisor({ defaults: { graceMs: 2_000, termMs: 1_000 } });
  acp = new AcpAdapter({
    supervisor,
    agent: {
      command: process.execPath,
      args: [FAKE_ACP_AGENT, '--state', join(tmp, 'acp-state')],
    },
    graceMs: 2_000,
  });
  h = brainHarness({
    adapters: [acp],
    compose: {
      stewardRuntime: () => stewardRuntime,
      workspaces: {
        projectsRoot: join(tmp, 'projects'),
        dataDir: join(tmp, 'data'),
        home: join(tmp, 'home'),
        git: gitRunner({ env: GIT_ENV }),
      },
    },
  });
});
afterEach(async () => {
  await h.dispose().catch(() => {});
  await acp.dispose();
  await supervisor.dispose();
  rmSync(tmp, { recursive: true, force: true });
});

/** An approved asteroid card and a Harmonizer that creates its task and spawns its Steward. */
async function asteroidRun(): Promise<{ taskId: () => Id; hqId: Id }> {
  const root = join(tmp, 'projects');
  const { value: card } = await h.commands.createProposal({
    requestText: 'tidy the notes',
    kind: 'asteroid',
    proposedBody: { kind: 'asteroid', name: 'Tidy notes' },
    workspace: join(root, 'scratch', 'tidy-notes'),
    rationale: 'small',
    meta: {
      request: { type: 'standalone_task', name: 'Tidy notes', description: 'tidy the notes' },
    },
  });
  await h.commands.decideProposal(card.id, { decision: 'approve' }, USER);
  let taskId: Id = '';
  const hq = await h.startHarmonizer({
    definition: harmonizerBrain({ projectsRoot: root }),
    script: (s) =>
      s
        .once('go', async (t) => {
          const created = await t.call<{ taskId: Id }>('create_task', { proposalId: card.id });
          taskId = created.taskId;
          await t.call('spawn_steward', { taskId, instructions: 'scenario:echo' });
        })
        .once(/Its report:/, async (t) => {
          await t.call('close_task', { taskId });
        }),
  });
  hq.tell('go');
  await h.until(() => h.log.tables.tasks.get(taskId)?.state === 'completed', {
    timeoutMs: 15_000,
    what: 'the asteroid task closed',
  });
  await h.done({ timeoutMs: 15_000 });
  return { taskId: () => taskId, hqId: hq.agentId };
}

const steward = () => h.log.tables.agents.all().find((a) => a.role === 'steward')!;

describe('stewardRuntime (P8-07)', () => {
  it('a fake-runtime Harmonizer spawns its Steward on the ACP runtime the setting names', async () => {
    stewardRuntime = 'acp';
    const { hqId } = await asteroidRun();
    expect(steward().runtime).toBe('acp');
    expect(steward().sessionRef).toMatch(/^acp:/);
    expect(h.log.tables.agents.get(hqId)?.runtime).toBe('fake');
  });

  it('unset, the Steward runs on its brain’s runtime', async () => {
    stewardRuntime = undefined;
    await asteroidRun();
    expect(steward().runtime).toBe('fake');
  });
});
