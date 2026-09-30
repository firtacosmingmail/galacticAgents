import { describe, expect, it } from 'vitest';
import { domain as fx } from '@galactic/protocol/fixtures';
import type { EventEnvelope } from '@galactic/protocol';
import { openDatabase } from '../db/database.js';
import { EventLog } from './event-log.js';

const fresh = (opts = {}) => new EventLog(openDatabase(':memory:'), { now: () => fx.NOW, ...opts });

describe('EventLog.runCommand', () => {
  it('commits the mutation and the event together, seq = rowid, published after commit', () => {
    const log = fresh();
    const seen: EventEnvelope[] = [];
    let rowVisibleAtPublish = false;
    log.subscribe((e) => {
      seen.push(e);
      rowVisibleAtPublish = log.tables.bodies.get('b-earth') !== undefined;
    });

    const out = log.runCommand(({ tables, emit }) => {
      const body = tables.bodies.insert(fx.body);
      emit({ type: 'body.assigned', bodyId: body.id, host: { kind: 'project', id: 'p-1' } });
      return body;
    });

    expect(out.value).toEqual(fx.body);
    expect(out.events).toEqual([
      {
        seq: 1,
        at: fx.NOW,
        event: { type: 'body.assigned', bodyId: 'b-earth', host: { kind: 'project', id: 'p-1' } },
      },
    ]);
    expect(seen).toEqual(out.events);
    expect(rowVisibleAtPublish).toBe(true);
    expect(log.currentSeq()).toBe(1);
  });

  it('rolls back both the row and the event when the command throws', () => {
    const log = fresh();
    const seen: EventEnvelope[] = [];
    log.subscribe((e) => seen.push(e));

    expect(() =>
      log.runCommand(({ tables, emit }) => {
        tables.bodies.insert(fx.body);
        emit({ type: 'body.freed', bodyId: 'b-earth' });
        throw new Error('boom');
      }),
    ).toThrow('boom');

    expect(log.tables.bodies.get('b-earth')).toBeUndefined();
    expect(log.currentSeq()).toBe(0);
    expect(log.eventsSince(0)).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('rolls back when the event insert fails after the mutation', () => {
    const log = fresh();
    expect(() =>
      log.runCommand(({ tables, emit }) => {
        tables.bodies.insert(fx.body);
        emit({ type: 'agent.output', agentId: 'a', kind: 'text', text: 'no' });
      }),
    ).toThrow(/transcript_chunks/);
    expect(log.tables.bodies.get('b-earth')).toBeUndefined();
  });

  it('delivers events to every subscriber strictly in seq order', () => {
    const log = fresh();
    const a: number[] = [];
    const b: number[] = [];
    log.subscribe((e) => a.push(e.seq));
    log.subscribe((e) => b.push(e.seq));

    for (let i = 0; i < 50; i++) {
      log.runCommand(({ emit }) => {
        emit({ type: 'agent.idle', agentId: `a-${i}` });
        if (i % 5 === 0) emit({ type: 'agent.progress', agentId: `a-${i}`, summary: 'tick' });
      });
    }
    const expected = Array.from({ length: log.currentSeq() }, (_, i) => i + 1);
    expect(a).toEqual(expected);
    expect(b).toEqual(expected);
    expect(log.eventsSince(0).map((e) => e.seq)).toEqual(expected);
  });

  it('a subscriber that runs a command keeps the order strict for every subscriber (P0-13)', () => {
    const log = fresh();
    const a: number[] = [];
    const b: number[] = [];
    log.subscribe((e) => {
      a.push(e.seq);
      // A projection reacting to the first event with a command of its own.
      if (e.seq === 1) {
        const out = log.runCommand(({ emit }) => emit({ type: 'agent.idle', agentId: 'reaction' }));
        expect(out.events[0]?.seq).toBe(3); // committed at once …
        expect(b).toEqual([]); // … but not yet published: B has not even seen 1
      }
    });
    log.subscribe((e) => b.push(e.seq));
    log.runCommand(({ emit }) => {
      emit({ type: 'agent.idle', agentId: 'x' });
      emit({ type: 'agent.idle', agentId: 'y' });
    });
    expect(a).toEqual([1, 2, 3]);
    expect(b).toEqual([1, 2, 3]);
    expect(log.eventsSince(0).map((e) => e.event)).toMatchObject([
      { agentId: 'x' },
      { agentId: 'y' },
      { agentId: 'reaction' },
    ]);
  });

  it('a command that fails inside a subscriber does not lose the rest of the batch', () => {
    const log = fresh();
    const seen: number[] = [];
    log.subscribe((e) => {
      seen.push(e.seq);
      if (e.seq === 1) {
        expect(() =>
          log.runCommand(({ emit }) => {
            emit({ type: 'agent.idle', agentId: 'doomed' });
            throw new Error('boom');
          }),
        ).toThrow('boom');
      }
    });
    log.runCommand(({ emit }) => {
      emit({ type: 'agent.idle', agentId: 'x' });
      emit({ type: 'agent.idle', agentId: 'y' });
    });
    expect(seen).toEqual([1, 2]);
    expect(log.currentSeq()).toBe(2);
  });

  it('a failing subscriber does not stop the others or the command', () => {
    const errors: unknown[] = [];
    const log = fresh({ onSubscriberError: (e: unknown) => errors.push(e) });
    const seen: number[] = [];
    log.subscribe(() => {
      throw new Error('subscriber bug');
    });
    log.subscribe((e) => seen.push(e.seq));
    const out = log.runCommand(({ emit }) => emit({ type: 'agent.idle', agentId: 'a' }));
    expect(out.events).toHaveLength(1);
    expect(seen).toEqual([1]);
    expect(errors).toHaveLength(1);
  });

  it('nested commands join the outer transaction and publish once, in order', () => {
    const log = fresh();
    const seen: string[] = [];
    log.subscribe((e) => seen.push(`${e.seq}:${e.event.type}`));

    log.runCommand(({ tables, emit }) => {
      tables.bodies.insert(fx.body);
      emit({ type: 'body.freed', bodyId: 'b-earth' });
      const inner = log.runCommand(({ tables: t, emit: e }) => {
        t.bodies.insert(fx.moon);
        e({ type: 'body.assigned', bodyId: 'b-luna', host: { kind: 'project', id: 'p-1' } });
        expect(seen).toEqual([]); // nothing published before the outer commit
        return 'inner';
      });
      expect(inner.value).toBe('inner');
      expect(inner.events.map((e) => e.seq)).toEqual([1]);
      emit({ type: 'agent.idle', agentId: 'a' });
    });
    expect(seen).toEqual(['1:body.assigned', '2:body.freed', '3:agent.idle']);

    expect(() =>
      log.runCommand(({ tables }) => {
        tables.bodies.insert(fx.asteroid);
        log.runCommand(({ emit }) => emit({ type: 'agent.idle', agentId: 'b' }));
        throw new Error('outer fails');
      }),
    ).toThrow('outer fails');
    expect(log.tables.bodies.get('b-ast-1')).toBeUndefined();
    expect(log.currentSeq()).toBe(3);
    expect(seen).toHaveLength(3);
  });

  it('rejects invalid events before touching the database', () => {
    const log = fresh();
    expect(() => log.runCommand(({ emit }) => emit({ type: 'agent.idle' } as never))).toThrow();
    expect(log.currentSeq()).toBe(0);
  });
});

describe('EventLog readers', () => {
  it('eventsSince pages through the log and canReplayFrom respects the cap', () => {
    const log = fresh({ maxReplay: 5 });
    for (let i = 0; i < 8; i++)
      log.runCommand(({ emit }) => emit({ type: 'agent.idle', agentId: 'a' }));
    expect(log.eventsSince(6).map((e) => e.seq)).toEqual([7, 8]);
    expect(log.eventsSince(0, 3).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(log.eventsSince(8)).toEqual([]);
    expect(log.canReplayFrom(8)).toBe(true);
    expect(log.canReplayFrom(3)).toBe(true);
    expect(log.canReplayFrom(2)).toBe(false); // 6 missed > maxReplay 5
    expect(log.canReplayFrom(9)).toBe(false); // ahead of the log
    log.db.prepare('DELETE FROM events WHERE id <= 4').run(); // simulate retention pruning
    expect(log.oldestSeq()).toBe(5);
    expect(log.canReplayFrom(4)).toBe(true);
    expect(log.canReplayFrom(3)).toBe(false);
  });

  it('builds a snapshot consistent with its seq', () => {
    const log = fresh();
    expect(log.snapshot()).toEqual({
      seq: 0,
      agents: [],
      bodies: [],
      projects: [],
      tasks: [],
      questions: [],
      proposals: [],
      statuses: [],
    });
    log.runCommand(({ tables, emit }) => {
      tables.bodies.insert(fx.body);
      tables.bodies.insert(fx.moon);
      tables.projects.insert(fx.project);
      tables.tasks.insert(fx.task);
      tables.agents.insert(fx.harmonizer);
      tables.proposals.insert(fx.proposal);
      tables.questions.insert({ ...fx.question, originAgentId: 'a-harmonizer' });
      emit({ type: 'project.created', project: fx.project });
    });
    const snap = log.snapshot();
    expect(snap.seq).toBe(1);
    expect(snap.bodies).toEqual([fx.body, fx.moon]);
    expect(snap.projects).toEqual([fx.project]);
    expect(snap.tasks).toEqual([fx.task]);
    expect(snap.agents).toEqual([fx.harmonizer]);
    expect(snap.proposals).toEqual([fx.proposal]);
    expect(snap.questions[0]?.id).toBe('q-1');
  });
});
