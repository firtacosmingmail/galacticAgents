import { afterEach, describe, expect, it } from 'vitest';
import type { Id } from '@galactic/protocol';
import type { BrainDefinition } from './definition.js';
import { brainDefinition, brainHarness, tool, type BrainHarness } from './testing/index.js';

/**
 * P9-14 (SPEC decision 135) through the brain runner: a Waykeeper's question the user dismisses,
 * or that the user's own message supersedes, reaches the Waykeeper's next turn as "do not wait"
 * and its former holder (the Harmonizer) as "needs no answer from you".
 */

const lives: BrainHarness[] = [];
afterEach(async () => {
  for (const h of lives.splice(0)) await h.dispose().catch(() => {});
});

const escalate = tool(
  'escalate',
  async (input, ctx) => {
    const { text } = input as { text: string };
    const { value } = await ctx.commands.openQuestion({
      kind: 'clarification',
      originAgentId: ctx.brainId,
      context: { text },
    });
    return { questionId: value.id };
  },
  { endsTurn: true },
);
const note = tool('note', () => Promise.resolve({ ok: true }));

const harmonizer: BrainDefinition = brainDefinition('harmonizer', [note], {
  systemPrompt: 'You are the Harmonizer.',
});
const waykeeper: BrainDefinition = brainDefinition('waykeeper', [escalate, note], {
  systemPrompt: 'You are the Waykeeper.',
});

async function setUp(waykeeperScript: Parameters<BrainHarness['startBrain']>[2]['script']) {
  const h = brainHarness();
  lives.push(h);
  const prompts: string[] = [];
  const hq = await h.startHarmonizer({
    definition: harmonizer,
    script: (s) =>
      s.on(async (t) => {
        prompts.push(t.prompt);
        await Promise.resolve();
      }),
  });
  const project = (await h.commands.createProject({ name: 'CSV', workspace: '/w/csv' })).value;
  const wk = await h.startBrain(
    waykeeper,
    { runtime: 'fake', projectId: project.id, supervisorId: hq.agentId },
    { script: waykeeperScript },
  );
  return { h, hq, wk, harmonizerPrompts: prompts };
}

describe('dismissed questions reach the brains (P9-14)', () => {
  it('the user dismisses a Waykeeper question: it carries on, the Harmonizer lets go', async () => {
    const seen: string[] = [];
    const { h, wk, harmonizerPrompts } = await setUp((s) =>
      s
        .once('plan the export', (t) => t.call('escalate', { text: 'Which date format?' }))
        .once(/dismissed/, async (t) => {
          seen.push(t.prompt);
          await t.call('note', {});
        }),
    );
    wk.tell('plan the export');
    await wk.waitForTurns(2);
    const questionId = (wk.calls('escalate')[0]!.value as { questionId: Id }).questionId;
    await h.commands.dismissQuestion({ questionId, by: { type: 'user' } });
    await h.done();
    expect(seen[0]).toContain(`the user dismissed ${questionId} ("Which date format?")`);
    expect(seen[0]).toContain('do not wait for an answer');
    expect(harmonizerPrompts.some((p) => p.includes('needs no answer from you'))).toBe(true);
  });

  it("the user's message supersedes it: the Waykeeper reads the message, not an answer", async () => {
    const seen: string[] = [];
    const { h, wk } = await setUp((s) =>
      s
        .once('plan the export', (t) => t.call('escalate', { text: 'Which date format?' }))
        .once(/use ISO/, async (t) => {
          seen.push(t.prompt);
          await t.call('note', {});
        }),
    );
    wk.tell('plan the export');
    await wk.waitForTurns(2);
    wk.tell('use ISO dates and stop asking');
    await h.commands.supersedeQuestions(wk.agentId);
    await h.done();
    expect(seen[0]).toContain('the user said: "use ISO dates and stop asking"');
    expect(seen[0]).toContain("superseded by the user's message");
  });
});
