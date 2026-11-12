import { describe, expect, it } from 'vitest';
import type { Area, FollowUp, Job, JobRun, Project } from '@galactic/protocol';
import { jobRunPrompt } from './job-prompt.js';

/**
 * Final review I4 — a follow-up spend run is told the spend it carries out is already approved,
 * and `request_spend` is only for any other spend (never "ask before spending" for the approved
 * one, which would loop approve → follow-up → request).
 */

const NOW = '2026-10-01T09:00:00.000Z';
const project = {
  id: 'p-1',
  name: 'Shop',
  purpose: 'Run the shop',
  goals: ['grow'],
} as unknown as Project;
const job = { id: 'j-1', name: 'Ads', instructions: 'Run the weekly ad.' } as unknown as Job;
const area = { id: 'a-1', name: 'Marketing' } as unknown as Area;
const run = (purpose: JobRun['purpose']) =>
  ({ id: 'jr-1', jobId: 'j-1', purpose, dueAt: NOW, startedAt: NOW }) as unknown as JobRun;
const SPEND: FollowUp = {
  questionId: 'q-1',
  kind: 'spend',
  amount: 20,
  currency: 'USD',
  purpose: 'the weekly ad',
};
const ASK_FIRST = 'call `request_spend` and stop';

describe('jobRunPrompt', () => {
  it('a follow-up spend run: the approved spend needs no new request_spend; any other spend does', () => {
    const text = jobRunPrompt({
      project,
      job,
      area,
      run: run('follow_up'),
      memory: [],
      followUp: SPEND,
      declares: true,
    });
    expect(text).toContain('Cosmin approved spending $20.00 for the weekly ad');
    expect(text).toContain(
      '- The spending above is already approved, for exactly $20.00 and the weekly ad: do not call `request_spend` for it.',
    );
    expect(text).toContain(
      '- Any other spending still needs `request_spend` first: call it and stop; a later run does it once Cosmin approves.',
    );
    expect(text).not.toContain(ASK_FIRST);
  });

  it('every other run asks with request_spend before any spending', () => {
    for (const r of [run('scheduled'), run('follow_up')]) {
      const followUp: FollowUp | undefined =
        r.purpose === 'follow_up'
          ? { questionId: 'q-2', kind: 'send', text: 'Thanks!' }
          : undefined;
      const text = jobRunPrompt({
        project,
        job,
        area,
        run: r,
        memory: [],
        ...(followUp ? { followUp } : {}),
        declares: true,
      });
      expect(text).toContain(ASK_FIRST);
      expect(text).not.toContain('already approved');
    }
  });

  it('lists every collected value and its kind under "Report exactly these names"', () => {
    const dataMap = {
      sources: [{ id: 'crm', label: 'CRM', kind: 'mcp' as const, target: 'crm' }],
      collects: [
        { name: 'new_messages', kind: 'number' as const, sourceIds: ['crm'], description: 'New' },
        { name: 'experiments', kind: 'table' as const, sourceIds: ['crm'], description: 'Tests' },
      ],
      steps: [],
    };
    const text = jobRunPrompt({
      project,
      job: { ...job, dataMap },
      area,
      run: run('scheduled'),
      memory: [],
      declares: true,
    });
    expect(text).toContain('Report exactly these names');
    expect(text).toContain('  - new_messages (number)');
    expect(text).toContain('  - experiments (table)');
    expect(text).toContain('sourceProblems');
  });

  it('says nothing about names when the job has no data map', () => {
    const text = jobRunPrompt({
      project,
      job,
      area,
      run: run('scheduled'),
      memory: [],
      declares: true,
    });
    expect(text).not.toContain('Report exactly these names');
  });
});
