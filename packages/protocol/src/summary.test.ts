import { describe, expect, it } from 'vitest';
import * as fx from './fixtures/domain.js';
import { summarize } from './summary.js';

describe('system summary', () => {
  it('counts open questions, the user-held ones, and blocked items', () => {
    const summary = summarize({
      questions: [
        { ...fx.question, id: 'q-a', status: 'open', holder: { type: 'user' } },
        { ...fx.question, id: 'q-b', status: 'open', holder: { type: 'agent', id: 'a-wk' } },
        { ...fx.permissionQuestion, id: 'q-c', status: 'open', holder: { type: 'user' } },
        { ...fx.question, id: 'q-d', status: 'answered', holder: { type: 'user' } },
        { ...fx.question, id: 'q-e', status: 'cancelled', holder: { type: 'user' } },
      ],
      tasks: [
        { ...fx.task, id: 't-a', state: 'blocked_on_user' },
        { ...fx.task, id: 't-b', state: 'in_progress' },
      ],
      projects: [
        { ...fx.project, id: 'p-a', state: 'blocked_on_user' },
        { ...fx.project, id: 'p-b', state: 'completed' },
      ],
    });
    expect(summary).toEqual({
      openQuestions: 3,
      userQuestions: 2,
      blockedTasks: 1,
      blockedProjects: 1,
      blockedItems: 2,
    });
  });

  it('an empty world counts nothing', () => {
    expect(summarize({ questions: [], tasks: [], projects: [] })).toEqual({
      openQuestions: 0,
      userQuestions: 0,
      blockedTasks: 0,
      blockedProjects: 0,
      blockedItems: 0,
    });
  });
});
