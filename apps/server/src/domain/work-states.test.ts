import { describe, expect, it } from 'vitest';
import { WorkState } from '@galactic/protocol';
import { canTransition } from './states.js';
import {
  PROJECT_RULES,
  TASK_RULES,
  derive,
  deriveProjectState,
  deriveTaskState,
  type AgentFact,
  type AgentPhase,
  type WorkFacts,
} from './work-states.js';

/** P2-15 — the rule tables, case by case (SPEC §4.4). */

const ag = (phase: AgentPhase, endedSeq?: number): AgentFact =>
  endedSeq === undefined ? { phase } : { phase, endedSeq };
const facts = (over: Partial<WorkFacts>): WorkFacts => ({
  current: 'in_progress',
  held: false,
  userQuestions: 0,
  agents: [],
  ...over,
});

type Row = [string, Partial<WorkFacts>, WorkState];

describe('task state derivation', () => {
  const rows: Row[] = [
    // the happy path
    ['approved, no agent yet', { current: 'approved' }, 'approved'],
    ['approved, Steward starting', { current: 'approved', agents: [ag('running')] }, 'in_progress'],
    ['running Steward', { agents: [ag('running')] }, 'in_progress'],
    ['user-held question', { agents: [ag('running')], userQuestions: 1 }, 'blocked_on_user'],
    [
      'question answered (none left)',
      { current: 'blocked_on_user', agents: [ag('running')] },
      'in_progress',
    ],
    ['Steward ended its turn', { agents: [ag('idle')] }, 'awaiting_closure'],
    ['Steward finished', { agents: [ag('finished', 9)] }, 'awaiting_closure'],
    // blocked on user beats everything that is not sticky
    ['question beats paused', { agents: [ag('paused')], userQuestions: 1 }, 'blocked_on_user'],
    ['question beats idle', { agents: [ag('idle')], userQuestions: 2 }, 'blocked_on_user'],
    [
      'question beats an explicit pause',
      { current: 'paused', held: true, agents: [ag('paused')], userQuestions: 1 },
      'blocked_on_user',
    ],
    [
      'question beats awaiting closure',
      { current: 'awaiting_closure', agents: [ag('running')], userQuestions: 1 },
      'blocked_on_user',
    ],
    // precedence between agents
    ['running beats paused', { agents: [ag('paused'), ag('running')] }, 'in_progress'],
    ['running beats idle', { agents: [ag('idle'), ag('running')] }, 'in_progress'],
    ['paused beats idle', { agents: [ag('idle'), ag('paused')] }, 'paused'],
    ['paused beats an ended one', { agents: [ag('failed', 3), ag('paused')] }, 'paused'],
    ['every agent paused', { agents: [ag('paused')] }, 'paused'],
    // ended agents: the latest one speaks
    ['Steward failed', { agents: [ag('failed', 4)] }, 'failed'],
    ['interrupted by a restart', { agents: [ag('interrupted', 4)] }, 'interrupted'],
    ['failed, then a retry finished', { agents: [ag('failed', 4), ag('finished', 8)] }, 'awaiting_closure'],
    ['finished, then a retry failed', { agents: [ag('finished', 4), ag('failed', 8)] }, 'failed'],
    ['failed, retry running', { current: 'failed', agents: [ag('failed', 4), ag('running')] }, 'in_progress'],
    ['stopped: no opinion', { agents: [ag('stopped', 4)] }, 'in_progress'],
    ['stopped after a failure', { agents: [ag('failed', 2), ag('stopped', 4)] }, 'in_progress'],
    // sticky states are never left by derivation
    ['proposed', { current: 'proposed', agents: [ag('running')], userQuestions: 1 }, 'proposed'],
    ['completed', { current: 'completed', agents: [ag('running')], userQuestions: 1 }, 'completed'],
    ['archived', { current: 'archived', agents: [ag('failed', 2)] }, 'archived'],
    ['moved', { current: 'moved', agents: [ag('running')], userQuestions: 1 }, 'moved'],
    // an explicit state holds until an agent of the item is (re)started
    ['explicit pause holds', { current: 'paused', held: true, agents: [ag('running')] }, 'paused'],
    ['explicit failure holds', { current: 'failed', held: true, agents: [ag('idle')] }, 'failed'],
    [
      'explicit failure is not reopened by a question',
      { current: 'failed', held: true, userQuestions: 1 },
      'failed',
    ],
    ['reopened (approved) holds', { current: 'approved', held: true, agents: [ag('finished', 3)] }, 'approved'],
  ];
  it.each(rows)('%s', (_name, over, expected) => {
    expect(deriveTaskState(facts(over))).toBe(expected);
  });

  it('every derived change from a non-sticky state is in the transition table', () => {
    const phases: AgentPhase[] = ['running', 'idle', 'paused', 'finished', 'failed', 'stopped', 'interrupted'];
    for (const current of WorkState.options) {
      for (const phase of phases) {
        for (const userQuestions of [0, 1]) {
          const f = facts({ current, agents: [ag(phase, 1)], userQuestions });
          const to = deriveTaskState(f);
          if (to !== current) {
            expect(canTransition(current, to), `${current} → ${to}`).toBe(true);
          }
        }
      }
    }
  });

  it('names the deciding rule', () => {
    expect(derive(TASK_RULES, facts({ agents: [ag('running')], userQuestions: 1 })).rule).toBe(
      'user-held question',
    );
    expect(derive(TASK_RULES, facts({ current: 'completed' })).rule).toBe('sticky state');
  });
});

describe('project state derivation', () => {
  const rows: Row[] = [
    ['approved, nothing yet', { current: 'approved' }, 'approved'],
    ['Waykeeper planning', { current: 'approved', agents: [ag('running')] }, 'in_progress'],
    ['Waykeeper idle, plan approved', { agents: [ag('idle')], tasks: ['approved'] }, 'in_progress'],
    ['a task running', { agents: [ag('idle')], tasks: ['in_progress', 'approved'] }, 'in_progress'],
    ['a user-held question anywhere', { agents: [ag('idle')], tasks: ['in_progress'], userQuestions: 1 }, 'blocked_on_user'],
    [
      'a task awaiting closure waits on the Waykeeper',
      { agents: [ag('idle')], tasks: ['awaiting_closure', 'completed'] },
      'in_progress',
    ],
    ['every task closed', { agents: [ag('idle')], tasks: ['completed', 'archived'] }, 'awaiting_closure'],
    ['all closed, Waykeeper still working', { agents: [ag('running')], tasks: ['completed'] }, 'in_progress'],
    ['work paused', { agents: [ag('idle')], tasks: ['paused', 'completed'] }, 'paused'],
    ['Waykeeper paused', { agents: [ag('paused')], tasks: ['completed'] }, 'paused'],
    ['running beats paused', { agents: [ag('idle')], tasks: ['paused', 'in_progress'] }, 'in_progress'],
    ['interrupted by a restart', { agents: [ag('interrupted', 5)], tasks: ['interrupted'] }, 'interrupted'],
    ['a failed task: no opinion', { agents: [ag('idle')], tasks: ['failed', 'completed'] }, 'in_progress'],
    ['only moved tasks: no opinion', { agents: [ag('idle')], tasks: ['moved'] }, 'in_progress'],
    ['completed is sticky', { current: 'completed', agents: [ag('running')], userQuestions: 1 }, 'completed'],
    ['archived is sticky', { current: 'archived', tasks: ['in_progress'] }, 'archived'],
    ['explicit pause holds', { current: 'paused', held: true, tasks: ['in_progress'] }, 'paused'],
  ];
  it.each(rows)('%s', (_name, over, expected) => {
    expect(deriveProjectState(facts(over))).toBe(expected);
  });

  it('the last rule is a catch-all', () => {
    expect(PROJECT_RULES.at(-1)!.when(facts({}))).toBe(true);
    expect(TASK_RULES.at(-1)!.when(facts({}))).toBe(true);
  });
});
