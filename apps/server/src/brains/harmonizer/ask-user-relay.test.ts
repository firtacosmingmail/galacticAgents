import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PICKED_OPTION_PREFIX, relayedQuestionOf, type Id } from '@galactic/protocol';
import { userWordsFor } from '../../runtime/user-words.js';
import { brainDefinition } from '../testing/canned.js';
import { brainHarness, type BrainHarness } from '../testing/index.js';
import type { ToolOutcome } from '../testing/transcript.js';
import { harmonizerBrain } from './index.js';

/**
 * P13-10: the Harmonizer's `ask_user` relaying a clarification it holds keeps the link
 * (`meta.relaysQuestionId`), so the user's answer counts as his words on the asking project.
 */

const lives: { h: BrainHarness; root: string }[] = [];
afterEach(async () => {
  for (const { h, root } of lives.splice(0)) {
    await h.dispose().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

const HELD = /asked (\S+) \(held by you\)/;
const OPTIONS = [
  'Push, post the 4 replies and re-request Dean (Recommended)',
  'Push and post the 4 replies',
  'Push only, no replies',
  'Hold',
];

async function setup(relayId: (held: Id) => Id) {
  const h = brainHarness();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-hq-relay-')));
  lives.push({ h, root });
  let outcome: ToolOutcome | undefined;
  const hq = await h.startHarmonizer({
    definition: harmonizerBrain({ projectsRoot: root }),
    script: (s) =>
      s
        .on(
          HELD,
          async (t) => {
            const held = HELD.exec(t.prompt)![1]!;
            outcome = await t.try('ask_user', {
              text: 'The Waykeeper asks: may it push and post the 4 replies?',
              options: OPTIONS,
              questionId: relayId(held),
            });
          },
          'relay the held question',
        )
        .on(
          () => true,
          () => {},
          'anything else',
        ),
  });
  const project = (await h.commands.createProject({ name: 'PR', workspace: join(root, 'pr') }))
    .value;
  const task = (
    await h.commands.createTask({ description: 'address review', projectId: project.id })
  ).value;
  const wk = await h.startBrain(
    brainDefinition('waykeeper', []),
    { runtime: 'fake', projectId: project.id, supervisorId: hq.agentId },
    {
      script: (s) =>
        s.on(
          () => true,
          () => {},
          'anything',
        ),
    },
  );
  await h.settle();
  const q1 = (
    await h.commands.openQuestion({
      kind: 'clarification',
      originAgentId: wk.agentId,
      context: { text: 'May I push them and post the 4 replies?' },
    })
  ).value;
  await h.settle();
  return { h, hq, q1, task, outcome: () => outcome };
}

describe('ask_user relays a held question (P13-10)', () => {
  it("keeps the link, and the user's picked option counts as his words for the project", async () => {
    const { h, q1, task, outcome } = await setup((held) => held);
    expect(outcome()).toMatchObject({ ok: true });
    const { questionId } = outcome()!.value as { questionId: Id };
    const q2 = h.log.tables.questions.get(questionId)!;
    expect(relayedQuestionOf(q2)).toBe(q1.id);
    await h.commands.answerQuestion({
      questionId,
      answer: 'Push and post the 4 replies',
      by: { type: 'user' },
    });
    expect(userWordsFor(h.log, task.id)).toContain(
      `${PICKED_OPTION_PREFIX}Push and post the 4 replies`,
    );
  });

  it('refuses a link to a question it does not hold', async () => {
    const { h, outcome } = await setup(() => 'q-nope');
    expect(outcome()).toMatchObject({ ok: false });
    expect(JSON.stringify(outcome())).toContain('not an open clarification question you hold');
    expect(h.log.tables.questions.all().filter((q) => q.holder.type === 'user')).toHaveLength(0);
  });
});
