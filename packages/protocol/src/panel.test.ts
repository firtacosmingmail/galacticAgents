import { describe, expect, it } from 'vitest';
import type { EventEnvelope } from './events.js';
import {
  ConversationQuery,
  NotificationsQuery,
  Settings,
  SettingsPatch,
  TranscriptQuery,
  notificationOf,
} from './panel.js';
import { DEFAULT_PERMISSION_POLICY, type Question } from './domain.js';

const at = '2026-10-02T10:00:00.000Z';
const env = (seq: number, event: EventEnvelope['event']): EventEnvelope => ({ seq, at, event });

const question = (over: Partial<Question> = {}): Question => ({
  id: 'q1',
  kind: 'clarification',
  originAgentId: 'a1',
  holder: { type: 'user' },
  status: 'open',
  context: { text: 'Which format?' },
  version: 0,
  createdAt: at,
  updatedAt: at,
  ...over,
});

describe('panel query schemas (P25-01)', () => {
  it('coerces and bounds the page size', () => {
    expect(ConversationQuery.parse({})).toEqual({ limit: 50 });
    expect(ConversationQuery.parse({ limit: '10', before: 'c' })).toEqual({
      limit: 10,
      before: 'c',
    });
    expect(ConversationQuery.safeParse({ limit: '0' }).success).toBe(false);
    expect(ConversationQuery.safeParse({ limit: '201' }).success).toBe(false);
    expect(ConversationQuery.safeParse({ before: 'a', after: 'b' }).success).toBe(false);
    expect(NotificationsQuery.parse({ after: '7' })).toEqual({ after: 7, limit: 50 });
  });

  it('parses transcript kinds and refuses unknown ones', () => {
    expect(TranscriptQuery.parse({ kinds: 'text,tool', after: '3' })).toEqual({
      kinds: ['text', 'tool'],
      after: 3,
      limit: 50,
    });
    expect(TranscriptQuery.safeParse({ kinds: 'text,secret' }).success).toBe(false);
    expect(TranscriptQuery.safeParse({ before: '2', after: '1' }).success).toBe(false);
  });
});

describe('settings schemas (P25-01)', () => {
  const valid: Settings = {
    projectsRoot: '~/GalacticProjects',
    defaultPermissionPolicy: DEFAULT_PERMISSION_POLICY,
    retentionDays: 7,
    caps: {
      maxConcurrentAgents: 4,
      maxStewardsPerWaykeeper: 3,
      maxSpawnsPerHour: 30,
      maxSpawnsPerHourPerBrain: 20,
      maxWallClockMs: 7_200_000,
      maxToolCalls: 500,
    },
    qualityTier: 'high',
    stewardsLoadUserSettings: true,
  };

  it('accepts the defaults', () => {
    expect(Settings.parse(valid)).toEqual(valid);
  });

  it('refuses invalid values and unknown keys in a patch', () => {
    for (const bad of [
      { retentionDays: 0 },
      { retentionDays: -1 },
      { caps: { maxConcurrentAgents: 0 } },
      { caps: { maxToolCalls: 1.5 } },
      { caps: { maxWallClockMs: 1000 } },
      { caps: { bogus: 1 } },
      { qualityTier: 'ultra' },
      { projectsRoot: '' },
      { defaultPermissionPolicy: { rules: { network: 'maybe' } } },
      { token: 'steal-me-please-123' },
    ]) {
      expect(SettingsPatch.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(SettingsPatch.parse({ caps: { maxSpawnsPerHour: 5 } })).toEqual({
      caps: { maxSpawnsPerHour: 5 },
    });
    expect(SettingsPatch.parse({ defaultPermissionPolicy: null })).toEqual({
      defaultPermissionPolicy: null,
    });
  });
});

describe('notificationOf (P25-01; SPEC §4.5)', () => {
  it('notifies a question or a permission for the user, with one id per question', () => {
    const opened = notificationOf(env(5, { type: 'question.opened', question: question() }));
    expect(opened).toMatchObject({
      id: 'question:q1',
      kind: 'question',
      body: 'Which format?',
      target: { kind: 'question', id: 'q1' },
    });
    const permission = notificationOf(
      env(6, { type: 'question.opened', question: question({ id: 'q2', kind: 'permission' }) }),
    );
    expect(permission).toMatchObject({ id: 'question:q2', kind: 'permission' });
    // Held by a supervisor: no notification; escalated to the user later: the same id.
    expect(
      notificationOf(
        env(7, {
          type: 'question.opened',
          question: question({ id: 'q3', holder: { type: 'agent', id: 'w1' } }),
        }),
      ),
    ).toBeUndefined();
    const escalated = notificationOf(
      env(8, {
        type: 'question.escalated',
        questionId: 'q3',
        from: { type: 'agent', id: 'w1' },
        to: { type: 'user' },
        version: 1,
      }),
      { question: () => ({ kind: 'clarification', context: { text: 'Escalated?' } }) },
    );
    expect(escalated).toMatchObject({ id: 'question:q3', body: 'Escalated?' });
  });

  it('notifies finished and failed work, with names from the lookup', () => {
    const done = notificationOf(
      env(9, {
        type: 'task.state_changed',
        taskId: 't1',
        from: 'awaiting_closure',
        to: 'completed',
      }),
      { task: () => ({ description: 'Write the parser' }) },
    );
    expect(done).toMatchObject({
      id: 'task:t1:completed:9',
      kind: 'task_completed',
      body: 'Write the parser',
      target: { kind: 'task', id: 't1' },
    });
    expect(
      notificationOf(
        env(10, {
          type: 'project.state_changed',
          projectId: 'p1',
          from: 'in_progress',
          to: 'failed',
        }),
      ),
    ).toMatchObject({ kind: 'project_failed', target: { kind: 'project', id: 'p1' } });
    expect(
      notificationOf(
        env(11, { type: 'task.state_changed', taskId: 't1', from: 'approved', to: 'in_progress' }),
      ),
    ).toBeUndefined();
  });

  it('notifies work recovery left interrupted and a refusal for lack of space only', () => {
    const lookup = { agent: () => ({ role: 'steward' as const }) };
    expect(
      notificationOf(
        env(12, { type: 'recovery.needs_attention', agentId: 's1', reason: 'resume failed: x' }),
        lookup,
      ),
    ).toMatchObject({
      id: 'interrupted:s1:12',
      kind: 'interrupted',
      role: 'steward',
      target: { kind: 'agent', id: 's1' },
    });
    // A shutdown of an agent that comes back, or a brain's session reset, is not news.
    for (const reason of ['server shutdown', 'session reset', 'server restarted', 'resume failed: x']) {
      expect(
        notificationOf(env(12, { type: 'agent.interrupted', agentId: 's1', reason }), lookup),
        reason,
      ).toBeUndefined();
    }
    expect(
      notificationOf(
        env(13, {
          type: 'proposal.parked',
          proposalId: 'pr1',
          reason: 'no free planet',
          waitingFor: 'planet',
          occupied: [],
          offers: [],
        }),
      ),
    ).toMatchObject({ id: 'no_space:pr1:13', kind: 'no_space' });
    expect(
      notificationOf(env(14, { type: 'proposal.parked', proposalId: 'pr2', reason: 'later' })),
    ).toBeUndefined();
    expect(
      notificationOf(env(15, { type: 'proposal.approved', proposalId: 'pr1' })),
    ).toBeUndefined();
  });
});
