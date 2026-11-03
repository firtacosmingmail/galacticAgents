import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Id, Provider } from '@galactic/protocol';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { ProviderCatalog } from '../runtime/provider-catalog.js';
import { gitRunner } from '../workspace/git.js';
import { harmonizerBrain } from './harmonizer/index.js';
import { brainHarness, type BrainHarness } from './testing/index.js';

/**
 * A Steward's provider (P11-03, replacing P8-07's `stewardRuntime` setting): a brain spawns its
 * Stewards on the provider the task, project or Settings name, read at every spawn — here a
 * scripted Harmonizer on the fake runtime starts an asteroid Steward on the Settings' default
 * provider (a fake adapter registered as `codex`), which reports by ending its turn and is closed.
 */

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const USER = { type: 'user' } as const;

let tmp: string;
let h: BrainHarness;
let codex: FakeAdapter;
let settings: { defaultProvider?: Provider; providers?: { chatgpt?: { model: string } } };

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-sr-')));
  for (const d of ['home', 'data', 'projects']) mkdirSync(join(tmp, d));
  settings = {};
  codex = new FakeAdapter({ speed: 0, runtime: 'codex' });
  h = brainHarness({
    adapters: [codex],
    compose: {
      catalog: new ProviderCatalog({ adapters: () => [codex], settings: () => settings }),
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
  await codex.dispose();
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

describe("a Steward's provider (P11-03)", () => {
  it('a fake-runtime Harmonizer spawns its Steward on the provider the Settings name, with its model', async () => {
    settings = { defaultProvider: 'chatgpt', providers: { chatgpt: { model: 'gpt-5.6-terra' } } };
    const { hqId } = await asteroidRun();
    expect(steward().runtime).toBe('codex');
    expect(steward().meta).toMatchObject({ provider: 'chatgpt', model: 'gpt-5.6-terra' });
    expect(h.log.tables.agents.get(hqId)?.runtime).toBe('fake');
  });

  it('nothing named, the Steward of a fake brain runs on the fake runtime (Claude in production)', async () => {
    settings = {};
    await asteroidRun();
    expect(steward().runtime).toBe('fake');
  });
});
