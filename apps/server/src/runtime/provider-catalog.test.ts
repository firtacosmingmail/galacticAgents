import { afterEach, describe, expect, it } from 'vitest';
import type { Id, ModelInfo, RuntimePreflight } from '@galactic/protocol';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { CLAUDE_MODELS } from '../adapters/claude-sdk/claude-sdk-adapter.js';
import { brainHarness, type BrainHarness } from '../brains/testing/index.js';
import { waykeeperDefinition } from '../brains/waykeeper/index.js';
import { projectHierarchy } from '../test/hierarchy.js';
import { ProviderCatalog } from './provider-catalog.js';

const text = (id: string, label: string, family: ModelInfo['family']): ModelInfo => ({
  id,
  label,
  family,
  isDefault: false,
  capabilities: ['text'],
});
const CHATGPT_MODELS: ModelInfo[] = [
  { ...text('gpt-6-luna', 'GPT-6 Luna', 'gpt'), isDefault: true },
  text('gpt-5.6-terra', 'GPT-5.6 Terra', 'gpt'),
  text('gpt-5.6-luna', 'GPT-5.6 Luna', 'gpt'),
];
const GEMINI_MODELS: ModelInfo[] = [
  { ...text('gemini-3.8-flash-high', 'Gemini 3.8 Flash High', 'gemini'), isDefault: true },
  { ...text('gemini-3.8-image', 'Gemini 3.8 Image', 'gemini'), capabilities: ['text', 'image'] },
];
const LOGGED_OUT: RuntimePreflight = {
  runtime: 'codex',
  ok: false,
  installed: true,
  loggedIn: false,
  problems: [
    {
      code: 'not_logged_in',
      severity: 'error',
      message: 'Codex is not logged in',
      fix: 'Run codex login',
    },
  ],
};

const adapters: FakeAdapter[] = [];
function fake(opts: ConstructorParameters<typeof FakeAdapter>[0]): FakeAdapter {
  const adapter = new FakeAdapter({ speed: 0, ...opts });
  adapters.push(adapter);
  return adapter;
}
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.dispose();
});

/** The three providers' adapters as fakes: Claude's static list, Codex and Antigravity. */
function catalogOf(extra: { codexPreflight?: RuntimePreflight } = {}) {
  const claude = fake({ runtime: 'claude-sdk', models: CLAUDE_MODELS, canPublish: true });
  const codex = fake({
    runtime: 'codex',
    models: CHATGPT_MODELS,
    canPublish: true,
    ...(extra.codexPreflight ? { preflight: () => Promise.resolve(extra.codexPreflight!) } : {}),
  });
  const agy = fake({ runtime: 'agy', models: GEMINI_MODELS, canPublish: false });
  return new ProviderCatalog({
    adapters: () => [claude, codex, agy],
    settings: () => ({ providers: { chatgpt: { model: 'gpt-5.6-terra' } } }),
  });
}

describe('ProviderCatalog (P11-03)', () => {
  it('model names match loosely or refuse with the list', async () => {
    const catalog = catalogOf();
    expect(await catalog.check({ provider: 'gemini', model: 'Gemini 3.8 Flash High' })).toEqual({
      ok: true,
      choice: { provider: 'gemini', model: 'gemini-3.8-flash-high' },
      label: 'Gemini · Gemini 3.8 Flash High',
    });
    expect(await catalog.check({ provider: 'claude', model: 'opus' })).toMatchObject({
      ok: true,
      choice: { provider: 'claude', model: 'opus' },
    });
    expect(await catalog.check({ provider: 'chatgpt', model: 'GPT-5.6 Terra' })).toMatchObject({
      ok: true,
      choice: { provider: 'chatgpt', model: 'gpt-5.6-terra' },
    });
    expect(await catalog.check({ provider: 'chatgpt', model: 'gpt-9' })).toEqual({
      ok: false,
      reason: 'ChatGPT has no model "gpt-9". Available: gpt-6-luna, gpt-5.6-terra, gpt-5.6-luna',
    });
    // No model named: the provider's default applies at spawn time; nothing to match.
    expect(await catalog.check({ provider: 'chatgpt' })).toEqual({
      ok: true,
      choice: { provider: 'chatgpt' },
      label: 'ChatGPT',
    });
  });

  it('images need an image model', async () => {
    const catalog = catalogOf();
    expect(await catalog.check({ provider: 'chatgpt' }, { images: true })).toEqual({
      ok: false,
      reason: 'ChatGPT cannot make images',
    });
    expect(
      await catalog.check({ provider: 'gemini', model: 'gemini-3.8-flash-high' }, { images: true }),
    ).toEqual({ ok: false, reason: 'Gemini · Gemini 3.8 Flash High cannot make images' });
    expect(
      await catalog.check({ provider: 'gemini', model: 'gemini-3.8-image' }, { images: true }),
    ).toMatchObject({ ok: true });
  });

  it('agy cannot publish', async () => {
    const catalog = catalogOf();
    expect(await catalog.check({ provider: 'gemini' }, { publishes: true })).toEqual({
      ok: false,
      reason: 'Gemini cannot publish: GalacticAgents cannot hold its actions back yet',
    });
    expect(await catalog.check({ provider: 'chatgpt' }, { publishes: true })).toMatchObject({
      ok: true,
    });
    expect(await catalog.check({ provider: 'claude' }, { publishes: true })).toMatchObject({
      ok: true,
    });
  });

  it('a provider without an adapter is not set up', async () => {
    const catalog = new ProviderCatalog({ adapters: () => [], settings: () => ({}) });
    expect(catalog.available('chatgpt')).toBe(false);
    expect(await catalog.check({ provider: 'chatgpt' })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^ChatGPT is not set up on this Mac: /),
    });
    expect(await catalog.models('chatgpt')).toEqual([]);
  });

  it('lists models once per time-to-live and knows each default model', async () => {
    let calls = 0;
    const codex = fake({ runtime: 'codex', models: CHATGPT_MODELS });
    const listing = codex.models.bind(codex);
    codex.models = () => {
      calls += 1;
      return listing();
    };
    let now = 0;
    const catalog = new ProviderCatalog({
      adapters: () => [codex],
      settings: () => ({}),
      ttlMs: 1_000,
      now: () => now,
    });
    await catalog.models('chatgpt');
    await catalog.models('chatgpt');
    expect(calls).toBe(1);
    now = 1_001;
    await catalog.models('chatgpt');
    expect(calls).toBe(2);
    // The CLI's default, unless the settings name one.
    expect(await catalog.defaultModel('chatgpt')).toBe('gpt-6-luna');
    expect(await catalogOf().defaultModel('chatgpt')).toBe('gpt-5.6-terra');
  });

  describe('spawn on a logged-out provider fails with the fix', () => {
    let h: BrainHarness | undefined;
    afterEach(async () => {
      await h?.dispose().catch(() => {});
      h = undefined;
    });

    it('check names the problem and the Waykeeper gets a refused spawn, not a crash', async () => {
      const catalog = catalogOf({ codexPreflight: LOGGED_OUT });
      const check = await catalog.check({ provider: 'chatgpt' });
      expect(check.ok).toBe(false);
      expect(!check.ok && check.reason).toContain('Codex is not logged in');
      expect(!check.ok && check.reason).toContain('Run codex login');

      const codex = fake({
        runtime: 'codex',
        preflight: () => Promise.resolve(LOGGED_OUT),
      });
      h = brainHarness({
        adapters: [codex],
        compose: {
          catalog: new ProviderCatalog({ adapters: () => [codex], settings: () => ({}) }),
        },
      });
      const harness = h;
      const project = (
        await harness.commands.createProject({ name: 'CSV tool', workspace: '/w/csv' })
      ).value;
      let taskId: Id = '';
      let refusal: { ok: boolean; message?: string } | undefined;
      const hq = await harness.startHarmonizer();
      const wk = await harness.startBrain(
        waykeeperDefinition(),
        { runtime: 'fake', projectId: project.id, supervisorId: hq.agentId },
        {
          script: (s) =>
            s
              .once('plan', async (t) => {
                const out = await t.call<{ tasks: { taskId: Id }[] }>('plan_tasks', {
                  summary: 'One file',
                  tasks: [{ description: 'a' }],
                });
                taskId = out.tasks[0]!.taskId;
              })
              .once(/was approved/, async (t) => {
                await harness.commands.updateTask(taskId, { provider: 'chatgpt' });
                refusal = await t.try('spawn_steward', { taskId, instructions: 'scenario:echo' });
                t.say('ChatGPT is logged out; I will tell the user.');
              }),
        },
      );
      wk.tell('plan');
      await harness.until(() => harness.log.tables.proposals.all().length > 0);
      await harness.commands.decideProposal(
        harness.log.tables.proposals.all()[0]!.id,
        { decision: 'approve' },
        { type: 'user' },
      );
      await harness.until(() => refusal !== undefined);
      await harness.done();
      expect(refusal).toMatchObject({
        ok: false,
        message: expect.stringContaining('Codex is not logged in'),
      });
      // Nothing was spawned and the Waykeeper is still alive.
      expect(harness.log.tables.agents.all().some((a) => a.taskId === taskId)).toBe(false);
      expect(harness.runtime.liveAgents().some((a) => a.id === wk.agentId)).toBe(true);
    });

    it("spawnAgent gives a Steward without a model its provider's default, checked", async () => {
      const codex = fake({ runtime: 'codex', models: CHATGPT_MODELS });
      h = brainHarness({
        adapters: [codex],
        compose: {
          catalog: new ProviderCatalog({
            adapters: () => [codex],
            settings: () => ({ providers: { chatgpt: { model: 'GPT-5.6 Terra' } } }),
          }),
        },
      });
      const project = (await h.commands.createProject({ name: 'CSV', workspace: '/w/csv' })).value;
      const { waykeeper } = await projectHierarchy(h.commands, project.id);
      const task = (
        await h.commands.createTask({
          description: 'a',
          projectId: project.id,
          provider: 'chatgpt',
        })
      ).value;
      const steward = (
        await h.commands.spawnAgent({
          role: 'steward',
          runtime: 'codex',
          taskId: task.id,
          supervisorId: waykeeper.id,
          prompt: 'scenario:echo',
        })
      ).value;
      // The Settings' loose name, resolved to the listed id.
      expect(steward.meta).toMatchObject({ provider: 'chatgpt', model: 'gpt-5.6-terra' });
      await expect(
        h.commands.spawnAgent({
          role: 'steward',
          runtime: 'codex',
          model: 'gpt-9',
          taskId: (await h.commands.createTask({ description: 'b', projectId: project.id })).value
            .id,
          supervisorId: waykeeper.id,
          prompt: 'scenario:echo',
        }),
      ).rejects.toThrow('ChatGPT has no model "gpt-9"');
    });

    it('an uncertain runtime check does not block; a bare spawn skips the login', async () => {
      const uncertain = (code: 'auth_unreadable' | 'check_failed'): RuntimePreflight => ({
        runtime: 'claude-sdk',
        ok: false,
        installed: true,
        problems: [{ code, severity: 'error', message: `Claude ${code}` }],
      });
      for (const code of ['auth_unreadable', 'check_failed'] as const) {
        const claude = fake({
          runtime: 'claude-sdk',
          preflight: () => Promise.resolve(uncertain(code)),
        });
        const catalog = new ProviderCatalog({ adapters: () => [claude], settings: () => ({}) });
        expect(await catalog.check({ provider: 'claude' })).toMatchObject({ ok: true });
      }
      const loggedOut = new ProviderCatalog({
        adapters: () => [fake({ runtime: 'codex', preflight: () => Promise.resolve(LOGGED_OUT) })],
        settings: () => ({}),
      });
      expect(await loggedOut.check({ provider: 'chatgpt' })).toMatchObject({ ok: false });
      expect(await loggedOut.check({ provider: 'chatgpt' }, {}, { bare: true })).toMatchObject({
        ok: true,
      });

      // …and the Steward spawns through spawnAgent.
      const claude = fake({
        runtime: 'claude-sdk',
        preflight: () => Promise.resolve(uncertain('auth_unreadable')),
      });
      h = brainHarness({
        adapters: [claude],
        compose: {
          catalog: new ProviderCatalog({ adapters: () => [claude], settings: () => ({}) }),
        },
      });
      const project = (await h.commands.createProject({ name: 'CSV', workspace: '/w/csv' })).value;
      const { waykeeper } = await projectHierarchy(h.commands, project.id);
      const task = (await h.commands.createTask({ description: 'a', projectId: project.id })).value;
      const steward = (
        await h.commands.spawnAgent({
          role: 'steward',
          runtime: 'claude-sdk',
          taskId: task.id,
          supervisorId: waykeeper.id,
          prompt: 'scenario:echo',
        })
      ).value;
      expect(steward.runtime).toBe('claude-sdk');
    });

    it('a brain never runs on Codex or Antigravity', async () => {
      const codex = fake({ runtime: 'codex' });
      h = brainHarness({ adapters: [codex] });
      await expect(
        h.commands.spawnAgent({ role: 'harmonizer', runtime: 'codex', cwd: '/w/hq', prompt: 'x' }),
      ).rejects.toThrow('brains run on Claude Code');
    });
  });
});
