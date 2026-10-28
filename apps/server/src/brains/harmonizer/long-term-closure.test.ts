import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { brainHarness, type BrainHarness, type ToolOutcome } from '../testing/index.js';
import { harmonizerBrain } from './index.js';

/**
 * P10-02 — the Harmonizer never runs the "anything else?" relay for a long-term project (SPEC
 * decision 142): `ask_closure` refuses it, and a closure request recorded on it is not relayed
 * again when a Harmonizer starts.
 */

const LONG_TERM = { purpose: 'Grow the app', goals: ['1000 users'] };

let h: BrainHarness;
let root: string;
beforeEach(() => {
  h = brainHarness();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-lt-closure-')));
});
afterEach(async () => {
  await h.dispose().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

describe('Harmonizer closure relay and long-term projects (P10-02)', () => {
  it('ask_closure refuses a long-term project and opens no question', async () => {
    const project = (
      await h.commands.createProject({ name: 'App', workspace: '/w/app', longTerm: LONG_TERM })
    ).value;
    let refusal: ToolOutcome | undefined;
    const hq = await h.startHarmonizer({
      definition: harmonizerBrain({ projectsRoot: root }),
      script: (s) =>
        s.once('relay', async (t) => {
          refusal = await t.try('ask_closure', { projectId: project.id, summary: 'done' });
        }),
    });
    h.tell(hq.agentId, 'relay');
    await h.settle();
    expect(refusal).toMatchObject({
      ok: false,
      error: 'invalid',
      message: 'long-term projects are closed by the user only',
    });
    expect(h.log.tables.questions.all().filter((q) => q.status === 'open')).toEqual([]);
  });

  it('a starting Harmonizer does not relay a closure request recorded on a long-term project', async () => {
    const lt = (
      await h.commands.createProject({ name: 'App', workspace: '/w/app', longTerm: LONG_TERM })
    ).value;
    const plain = (await h.commands.createProject({ name: 'Tool', workspace: '/w/tool' })).value;
    for (const p of [lt, plain]) {
      await h.commands.updateProject(p.id, {
        meta: { closureRequest: { by: 'a-wk', summary: 'all done', tasks: 1 } },
      });
    }
    const hq = await h.startHarmonizer({ definition: harmonizerBrain({ projectsRoot: root }) });
    await h.settle();
    const first = hq.prompts()[0]!;
    expect(first).toContain(`project ${plain.id} ("Tool") asked for closure`);
    expect(first).not.toContain(`project ${lt.id}`);
  });
});
