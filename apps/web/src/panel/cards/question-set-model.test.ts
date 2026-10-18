import { describe, expect, it } from 'vitest';
import type { Question } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import {
  canSend,
  pagesOf,
  resumeIndex,
  sendCount,
  toAnswers,
  toggleChoice,
  viaAgentIds,
} from './question-set-model.js';
import {
  authRow,
  browsersRow,
  routesRow,
  setRows,
  setWaykeeper,
  withSupervisorAnswer,
} from './question-set-fixtures.js';

describe('question-set model (P8-21)', () => {
  it('splits the rows into the pages to answer and the rows a supervisor answered', () => {
    const { asking, answeredBySupervisor } = pagesOf(withSupervisorAnswer());
    expect(asking.map((q) => q.id)).toEqual(['q-s1', 'q-s3']);
    expect(answeredBySupervisor.map((q) => q.id)).toEqual(['q-s2']);
  });

  it('resumes at the first row without a draft, else at the review page', () => {
    expect(resumeIndex(setRows, {})).toBe(0);
    expect(resumeIndex(setRows, { 'q-s1': { choices: ['Yes'] } })).toBe(1);
    expect(
      resumeIndex(setRows, {
        'q-s1': { choices: ['Yes'] },
        'q-s2': { choices: [], skipped: true },
        'q-s3': { choices: [], text: 'only Chrome' },
      }),
    ).toBe(3);
    // An empty draft is no draft.
    expect(resumeIndex(setRows, { 'q-s1': { choices: [], text: '  ' } })).toBe(0);
  });

  it('can send only when every row has a valid answer or a skip', () => {
    const drafts = {
      'q-s1': { choices: ['Yes'] },
      'q-s2': { choices: [], skipped: true },
      'q-s3': { choices: ['Chrome', 'Safari'] },
    };
    expect(canSend(setRows, drafts)).toBe(true);
    expect(canSend(setRows, { ...drafts, 'q-s3': { choices: [] } })).toBe(false);
    expect(canSend(setRows, { 'q-s1': drafts['q-s1'], 'q-s2': drafts['q-s2'] })).toBe(false);
    // Two choices on a single-choice row do not fit.
    expect(canSend(setRows, { ...drafts, 'q-s1': { choices: ['Yes', 'No, remove them'] } })).toBe(
      false,
    );
    expect(canSend([], {})).toBe(false);
  });

  it('maps the drafts to the send, a skip as a skip, with each row’s version', () => {
    const answers = toAnswers(setRows, {
      'q-s1': { choices: ['Yes'], text: '  ' },
      'q-s2': { choices: ['Clerk'], skipped: true },
      'q-s3': { choices: [], text: ' only Chrome ' },
    });
    expect(answers).toEqual([
      { questionId: 'q-s1', version: 1, answer: { choices: ['Yes'] } },
      { questionId: 'q-s2', version: 1, answer: { choices: [], skipped: true } },
      { questionId: 'q-s3', version: 1, answer: { choices: [], text: 'only Chrome' } },
    ]);
    expect(
      sendCount(setRows, {
        'q-s1': { choices: ['Yes'] },
        'q-s2': { choices: [], skipped: true },
        'q-s3': { choices: ['Chrome'] },
      }),
    ).toBe(2);
  });

  it('toggles choices: one at a time on a single-choice row, several on a multi-select one', () => {
    expect(toggleChoice(routesRow, undefined, 'Yes')).toEqual({ choices: ['Yes'] });
    expect(toggleChoice(routesRow, { choices: ['Yes'] }, 'No, remove them')).toEqual({
      choices: ['No, remove them'],
    });
    expect(toggleChoice(routesRow, { choices: ['Yes'] }, 'Yes')).toEqual({ choices: [] });
    const two = toggleChoice(browsersRow, { choices: ['Chrome'] }, 'Safari');
    expect(two).toEqual({ choices: ['Chrome', 'Safari'] });
    expect(toggleChoice(browsersRow, two, 'Chrome')).toEqual({ choices: ['Safari'] });
    // Choosing un-skips, and keeps the written text.
    expect(toggleChoice(authRow, { choices: [], text: 'hm', skipped: true }, 'Clerk')).toEqual({
      choices: ['Clerk'],
      text: 'hm',
    });
  });

  it('names who the set came through: the supervisors it moved past and the ones that answered', () => {
    const agents = { [fx.harmonizer.id]: fx.harmonizer, [setWaykeeper.id]: setWaykeeper };
    // Moved once (version 1): through the Waykeeper's supervisor.
    expect(viaAgentIds(setRows, agents)).toEqual([fx.harmonizer.id]);
    // Asked straight to the user (version 0): nobody in between.
    const direct: Question[] = setRows.map((q) => ({ ...q, version: 0 }));
    expect(viaAgentIds(direct, agents)).toEqual([]);
    // A supervisor that answered a row is named even when the open rows never moved.
    const answered = withSupervisorAnswer().map((q) =>
      q.status === 'open' ? { ...q, version: 0 } : q,
    );
    expect(viaAgentIds(answered, agents)).toEqual([fx.harmonizer.id]);
  });
});
