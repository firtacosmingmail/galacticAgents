import { describe, expect, it } from 'vitest';
import { domain as fx, events as ev } from '@galactic/protocol/fixtures';
import type { EventEnvelope } from '@galactic/protocol';
import { applyEvent, applySnapshot, emptyWorld } from './reduce.js';

const env = (seq: number, event: EventEnvelope['event']): EventEnvelope => ({
  seq,
  at: fx.NOW,
  event,
});

describe('applySnapshot', () => {
  it('indexes every collection by id and takes the seq', () => {
    const w = applySnapshot({
      logId: 'log-a',
      seq: 7,
      agents: [fx.agent],
      bodies: [fx.body, fx.moon],
      projects: [fx.project],
      tasks: [fx.task],
      questions: [fx.question],
      proposals: [fx.proposal],
      statuses: [fx.status],
    });
    expect(w.seq).toBe(7);
    expect(w.bodies['b-luna']).toEqual(fx.moon);
    expect(w.statuses['a-steward-1']).toEqual(fx.status);
  });
});

describe('applyEvent', () => {
  it('is pure and advances seq', () => {
    const before = emptyWorld();
    const after = applyEvent(before, env(1, ev['project.created']));
    expect(before.projects).toEqual({});
    expect(after.seq).toBe(1);
    expect(after.projects['p-1']).toEqual(fx.project);
  });

  it('folds project and task lifecycle events', () => {
    let w = emptyWorld();
    w = applyEvent(w, env(1, ev['project.created']));
    w = applyEvent(w, env(2, ev['project.updated']));
    w = applyEvent(
      w,
      env(3, {
        type: 'project.state_changed',
        projectId: 'p-1',
        from: 'in_progress',
        to: 'awaiting_closure',
      }),
    );
    expect(w.projects['p-1']).toMatchObject({ name: 'Auth v2', state: 'awaiting_closure' });
    w = applyEvent(w, env(4, ev['task.created']));
    w = applyEvent(w, env(5, ev['task.updated']));
    w = applyEvent(w, env(6, ev['task.state_changed']));
    expect(w.tasks['t-1']).toMatchObject({ priority: 'urgent', state: 'blocked_on_user' });
    expect(w.seq).toBe(6);
  });

  it('moves hosts between bodies', () => {
    let w = applySnapshot({
      logId: 'log-a',
      seq: 0,
      agents: [],
      bodies: [fx.body, fx.moon, fx.asteroid],
      projects: [],
      tasks: [],
      questions: [],
      proposals: [],
      statuses: [],
    });
    w = applyEvent(w, env(1, ev['body.moved'])); // task t-2 from the asteroid to Luna
    expect(w.bodies['b-ast-1']?.host).toBeUndefined();
    expect(w.bodies['b-luna']?.host).toEqual({ kind: 'task', id: 't-2' });
    w = applyEvent(w, env(2, ev['body.freed']));
    expect(w.bodies['b-ast-1']).toEqual({
      id: 'b-ast-1',
      kind: 'asteroid',
      name: 'Ceres-1',
      meta: { seed: 42 },
    });
    w = applyEvent(
      w,
      env(3, { type: 'body.assigned', bodyId: 'b-earth', host: { kind: 'project', id: 'p-9' } }),
    );
    expect(w.bodies['b-earth']?.host).toEqual({ kind: 'project', id: 'p-9' });
    const fresh = { id: 'b-new', kind: 'asteroid', name: 'Vesta-7' } as const;
    w = applyEvent(w, env(4, { type: 'body.created', body: fresh }));
    expect(w.bodies['b-new']).toEqual(fresh);
    w = applyEvent(
      w,
      env(5, { type: 'body.assigned', bodyId: 'b-new', host: { kind: 'task', id: 't-7' } }),
    );
    expect(w.bodies['b-new']?.host).toEqual({ kind: 'task', id: 't-7' });
  });

  it('tracks questions and proposals', () => {
    let w = emptyWorld();
    w = applyEvent(w, env(1, ev['question.opened']));
    w = applyEvent(w, env(2, ev['question.escalated']));
    expect(w.questions['q-1']).toMatchObject({ holder: { type: 'user' }, version: 1 });
    w = applyEvent(w, env(3, ev['question.answered']));
    expect(w.questions['q-1']).toMatchObject({ status: 'answered', answer: 'yes' });
    w = applyEvent(w, env(4, ev['proposal.created']));
    w = applyEvent(w, env(5, ev['proposal.edited']));
    expect(w.proposals['pr-1']).toMatchObject({ state: 'edited', kind: 'asteroid' });
    w = applyEvent(w, env(6, ev['proposal.parked']));
    expect(w.proposals['pr-1']?.state).toBe('parked');
  });

  it('keeps status records exactly as the server sent them: agent.* events only advance seq', () => {
    let w = applySnapshot({
      logId: 'log-a',
      seq: 0,
      agents: [fx.agent],
      bodies: [],
      projects: [],
      tasks: [],
      questions: [],
      proposals: [],
      statuses: [fx.status],
    });
    w = applyEvent(w, env(1, ev['agent.needs_input']));
    w = applyEvent(w, env(2, ev['agent.finished']));
    w = applyEvent(w, env(3, { type: 'agent.idle', agentId: 'unknown' }));
    expect(w.statuses).toEqual({ [fx.status.agentId]: fx.status });
    expect(w.seq).toBe(3);
  });

  it('accepts every event type without throwing', () => {
    let w = emptyWorld();
    let seq = 0;
    for (const event of Object.values(ev)) w = applyEvent(w, env(++seq, event));
    expect(w.seq).toBe(Object.keys(ev).length);
  });
});
