import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Project } from '@galactic/protocol';
import { brainHarness, type BrainHarness, type ToolOutcome } from '../testing/index.js';
import { providerFakes } from '../testing/provider-fakes.js';
import { waykeeperDefinition, WAYKEEPER_SYSTEM_PROMPT } from './index.js';

/**
 * P11-08: a Waykeeper's plan carries each task's provider, model and flags, checked against the
 * provider catalogue before the card exists; a refusal creates nothing.
 */

let h: BrainHarness;
let fakes: ReturnType<typeof providerFakes>;
beforeEach(() => {
  fakes = providerFakes();
  h = brainHarness({ adapters: fakes.adapters, compose: { catalog: fakes.catalog } });
});
afterEach(async () => {
  await h.dispose().catch(() => {});
  await fakes.dispose();
});

async function planning(project: Project, tool: string, input: unknown) {
  const out: { result?: ToolOutcome } = {};
  const hq = await h.startHarmonizer();
  const wk = await h.startBrain(
    waykeeperDefinition(),
    { runtime: 'fake', projectId: project.id, supervisorId: hq.agentId },
    {
      script: (s) =>
        s
          .once('go', async (t) => {
            out.result = await t.try(tool, input);
          })
          .on(/was (approved|rejected)/, () => {}),
    },
  );
  wk.tell('go');
  await h.settle();
  return out;
}

const project = async () =>
  (await h.commands.createProject({ name: 'App', workspace: '/tmp/app' })).value;

describe('plan_tasks carries providers (P11-08)', () => {
  it('plan carries provider and model per task', async () => {
    const out = await planning(await project(), 'plan_tasks', {
      summary: 'Images, then publish',
      tasks: [
        { description: 'Make images', provider: 'gemini', makesImages: true },
        {
          description: 'Publish',
          provider: 'chatgpt',
          model: 'GPT 5.6 terra',
          publishes: true,
          blockedBy: [0],
        },
        { description: 'Plain' },
      ],
    });
    expect(out.result, JSON.stringify(out.result)).toMatchObject({ ok: true, turnEnded: true });
    const tasks = h.log.tables.tasks.all();
    expect(tasks).toHaveLength(3);
    expect(tasks[0]).toMatchObject({ provider: 'gemini', makesImages: true });
    expect(tasks[1]).toMatchObject({
      provider: 'chatgpt',
      model: 'gpt-5.6-terra',
      publishes: true,
    });
    expect(tasks[2]!.provider).toBeUndefined();
    expect(h.log.tables.proposals.all()).toHaveLength(1);
  });

  it('plan with an unknown model creates nothing', async () => {
    const out = await planning(await project(), 'plan_tasks', {
      summary: 'x',
      tasks: [
        { description: 'fine', provider: 'claude' },
        { description: 'bad', provider: 'chatgpt', model: 'gpt-9' },
      ],
    });
    expect(out.result).toMatchObject({ ok: false });
    expect((out.result as { message?: string }).message).toContain(
      'ChatGPT has no model "gpt-9". Available: ',
    );
    expect(JSON.stringify(out.result)).toContain('task 2 of the plan');
    expect(h.log.tables.tasks.all()).toHaveLength(0);
    expect(h.log.tables.proposals.all()).toHaveLength(0);
  });

  it('publishing task on Gemini is refused', async () => {
    const out = await planning(await project(), 'plan_tasks', {
      summary: 'x',
      tasks: [{ description: 'Post it', provider: 'gemini', publishes: true }],
    });
    expect(out.result).toMatchObject({ ok: false });
    expect(JSON.stringify(out.result)).toContain('cannot publish');
    expect(h.log.tables.tasks.all()).toHaveLength(0);
  });

  it.each([
    [
      'an image task on a text-only model',
      { description: 'a', provider: 'chatgpt', makesImages: true },
      'cannot make images',
    ],
    ['a model without a provider', { description: 'b', model: 'gpt-6-luna' }, 'needs the provider'],
    ['an unknown provider', { description: 'c', provider: 'bard' }, 'provider must be one of'],
  ])('%s is refused and creates nothing', async (_name, task, reason) => {
    const out = await planning(await project(), 'plan_tasks', { summary: 'x', tasks: [task] });
    expect(out.result).toMatchObject({ ok: false });
    expect((out.result as { message?: string }).message).toContain(reason);
    expect(h.log.tables.tasks.all()).toHaveLength(0);
    expect(h.log.tables.proposals.all()).toHaveLength(0);
  });

  it('the project default is checked for a task that names no provider', async () => {
    const p = await project();
    await h.commands.setProjectProvider({
      projectId: p.id,
      provider: 'gemini',
      by: { type: 'user' },
    });
    const out = await planning(p, 'plan_tasks', {
      summary: 'x',
      tasks: [{ description: 'Post it', publishes: true }],
    });
    expect(out.result).toMatchObject({ ok: false });
    expect(JSON.stringify(out.result)).toContain('cannot publish');
  });

  it('a flagged task with no provider anywhere is checked on Claude and told to name one', async () => {
    const out = await planning(await project(), 'plan_tasks', {
      summary: 'x',
      tasks: [{ description: 'Make images', makesImages: true }],
    });
    expect(out.result).toMatchObject({ ok: false });
    const message = (out.result as { message?: string }).message;
    expect(message).toContain('cannot make images');
    expect(message).toContain('name a provider for this task');
    expect(h.log.tables.tasks.all()).toHaveLength(0);
  });

  it('a flagged task with no provider uses the Settings default for the check', async () => {
    h.composed.catalog.defaults = () => ({ defaultProvider: 'gemini' });
    const out = await planning(await project(), 'plan_tasks', {
      summary: 'x',
      tasks: [{ description: 'Post it', publishes: true }],
    });
    expect((out.result as { message?: string }).message).toContain('Gemini');
    expect((out.result as { message?: string }).message).toContain('name a provider for this task');
  });

  it('create_task carries the provider after the plan was approved', async () => {
    const p = await project();
    let later: ToolOutcome | undefined;
    let refused: ToolOutcome | undefined;
    const hq = await h.startHarmonizer();
    const wk = await h.startBrain(
      waykeeperDefinition(),
      { runtime: 'fake', projectId: p.id, supervisorId: hq.agentId },
      {
        script: (s) =>
          s
            .once('plan', async (t) => {
              await t.call('plan_tasks', { summary: 's', tasks: [{ description: 'first' }] });
            })
            .once(/was approved/, async (t) => {
              refused = await t.try('create_task', {
                description: 'bad',
                provider: 'gemini',
                publishes: true,
              });
              later = await t.try('create_task', {
                description: 'Publish',
                provider: 'chatgpt',
                publishes: true,
              });
            }),
      },
    );
    wk.tell('plan');
    await h.until(() => h.log.tables.proposals.all().length > 0);
    await h.commands.decideProposal(
      h.log.tables.proposals.all()[0]!.id,
      { decision: 'approve' },
      { type: 'user' },
    );
    await h.settle();
    expect(refused).toMatchObject({ ok: false });
    expect(later).toMatchObject({ ok: true });
    const created = h.log.tables.tasks.all().filter((t) => t.description !== 'first');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ provider: 'chatgpt', publishes: true });
  });
});

describe('the Waykeeper prompt (P11-08)', () => {
  it('says how a plan carries providers', () => {
    expect(WAYKEEPER_SYSTEM_PROMPT).toContain(
      'The approved request may carry a provider note. Give each task the provider and model it names (provider alone means its default model), mark image-making tasks makesImages and publishing tasks publishes, and leave the rest to the project default. A publishing task never goes to Gemini.',
    );
  });
});
