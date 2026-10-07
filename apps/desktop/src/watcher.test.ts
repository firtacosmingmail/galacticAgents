import { describe, expect, it } from 'vitest';
import { CLOSE_UNAUTHORIZED, type Question } from '@galactic/protocol';
import { domain } from '@galactic/protocol/fixtures';

const { project, proposal, question } = domain;
import {
  BACKFILL_MAX_SHOWN,
  StatusWatcher,
  waitingForUser,
  type ShellNotification,
  type SocketLike,
  type WatcherState,
} from './watcher.js';

const NOW = Date.parse('2026-10-06T10:00:00.000Z');
const at = (msAgo = 0) => new Date(NOW - msAgo).toISOString();

class FakeSocket implements SocketLike {
  readyState = 1;
  sent: unknown[] = [];
  closed: { code?: number | undefined; reason?: string | undefined } | undefined;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
  }
  open() {
    this.onopen?.({});
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  drop(code = 1006, reason = '') {
    this.onclose?.({ code, reason });
  }
}

function setup(tokenValue: string | null = 'secret-token') {
  const token = tokenValue ?? undefined;
  const sockets: FakeSocket[] = [];
  const states: WatcherState[] = [];
  const notes: ShellNotification[] = [];
  const timers: (() => void)[] = [];
  const watcher = new StatusWatcher({
    url: 'ws://127.0.0.1:4400/ws',
    token: () => token,
    onState: (s) => states.push(s),
    onNotify: (n) => notes.push(n),
    openSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    now: () => NOW,
    setTimer: (fn) => timers.push(fn),
    clearTimer: () => {},
  });
  watcher.start();
  const reconnect = () => timers.shift()?.();
  return { watcher, sockets, states, notes, reconnect, last: () => sockets[sockets.length - 1]! };
}

const userQuestion = (id: string, kind: Question['kind'] = 'clarification'): Question => ({
  ...question,
  id,
  kind,
  holder: { type: 'user' },
  status: 'open',
  context: { text: `Question ${id}?` },
});

const snapshot = (seq: number, extra: Record<string, unknown> = {}) => ({
  type: 'snapshot',
  logId: 'log-1',
  seq,
  agents: [],
  bodies: [],
  projects: [project],
  tasks: [],
  questions: [],
  proposals: [],
  statuses: [],
  ...extra,
});

const opened = (seq: number, q: Question, ago = 0) => ({
  type: 'event',
  seq,
  at: at(ago),
  event: { type: 'question.opened', question: q },
});
const answered = (seq: number, id: string) => ({
  type: 'event',
  seq,
  at: at(),
  event: {
    type: 'question.answered',
    questionId: id,
    answer: 'yes',
    answeredBy: { type: 'user' },
    version: 1,
  },
});
const projectDone = (seq: number) => ({
  type: 'event',
  seq,
  at: at(),
  event: {
    type: 'project.state_changed',
    projectId: project.id,
    from: 'in_progress',
    to: 'completed',
  },
});

describe('StatusWatcher', () => {
  it('says hello with the token, then counts what waits for the user', () => {
    const t = setup();
    t.last().open();
    expect(t.last().sent[0]).toEqual({ type: 'hello', token: 'secret-token' });
    t.last().receive(
      snapshot(5, { questions: [userQuestion('q-a'), question], proposals: [proposal] }),
    );
    expect(t.watcher.state).toMatchObject({ connection: 'live', waiting: 2, storage: 'ok' });
  });

  it('never replays history: the snapshot is the baseline', () => {
    const t = setup();
    t.last().open();
    t.last().receive(snapshot(5, { questions: [userQuestion('q-a', 'permission')] }));
    expect(t.notes).toEqual([]);
  });

  it('notifies live questions, permissions and finished projects once, with the protocol ids', () => {
    const t = setup();
    t.last().open();
    t.last().receive(snapshot(5));
    t.last().receive(opened(6, userQuestion('q-a', 'permission')));
    t.last().receive(opened(7, userQuestion('q-b')));
    t.last().receive(projectDone(8));
    expect(t.notes.map((n) => [n.id, n.title])).toEqual([
      ['question:q-a', 'Permission needed'],
      ['question:q-b', 'A question for you'],
      ['project:p-1:completed:8', 'Project finished'],
    ]);
    expect(t.notes[2]!.body).toBe(project.name);
    expect(t.watcher.state.waiting).toBe(2);
  });

  it('a finished project says how many deliverables it left (decision 134)', () => {
    const t = setup();
    t.last().open();
    // The screenshot an agent declared counts; the detected `dev` command does not.
    t.last().receive(
      snapshot(5, { deliverables: [domain.deliverable, domain.commandDeliverable] }),
    );
    t.last().receive(projectDone(6));
    expect(t.notes.map((n) => n.title)).toEqual(['Project finished · 1 deliverable']);
    expect(t.notes[0]!.body).toBe(project.name);
  });

  it('leaves out the kinds the shell does not post (tasks)', () => {
    const t = setup();
    t.last().open();
    t.last().receive(snapshot(5));
    t.last().receive({
      type: 'event',
      seq: 6,
      at: at(),
      event: { type: 'task.state_changed', taskId: 't-1', from: 'in_progress', to: 'completed' },
    });
    expect(t.notes).toEqual([]);
  });

  it('after a reconnect, shows only what is still current from the replay, once', () => {
    const t = setup();
    t.last().open();
    t.last().receive(snapshot(5));
    t.last().receive(opened(6, userQuestion('q-a')));
    t.last().drop();
    expect(t.watcher.state.connection).toBe('disconnected');
    t.reconnect();
    t.last().open();
    expect(t.last().sent[0]).toEqual({
      type: 'hello',
      token: 'secret-token',
      lastEventId: 6,
      logId: 'log-1',
    });
    t.last().receive(opened(6, userQuestion('q-a'))); // duplicate: ignored
    t.last().receive(opened(7, userQuestion('q-b'))); // answered meanwhile: not raised
    t.last().receive(answered(8, 'q-b'));
    t.last().receive(opened(9, userQuestion('q-c'), 2 * 24 * 3600_000)); // too old
    t.last().receive(opened(10, userQuestion('q-d')));
    expect(t.notes.map((n) => n.id)).toEqual(['question:q-a']);
    t.last().receive({ type: 'caught_up', seq: 10 });
    expect(t.notes.map((n) => n.id)).toEqual(['question:q-a', 'question:q-d']);
    expect(t.watcher.state.connection).toBe('live');
  });

  it('folds a long replay into the five most important plus one summary', () => {
    const t = setup();
    t.last().open();
    t.last().receive(snapshot(1));
    t.last().drop();
    t.reconnect();
    t.last().open();
    for (let i = 0; i < 8; i++) {
      t.last().receive(
        opened(2 + i, userQuestion(`q-${i}`, i === 7 ? 'permission' : 'clarification')),
      );
    }
    t.last().receive({ type: 'caught_up', seq: 9 });
    expect(t.notes).toHaveLength(BACKFILL_MAX_SHOWN + 1);
    expect(t.notes[0]!.id).toBe('question:q-7');
    expect(t.notes.at(-1)!.title).toBe('3 more updates while disconnected');
  });

  it('a snapshot after a reconnect is a new baseline (no notification)', () => {
    const t = setup();
    t.last().open();
    t.last().receive(snapshot(1));
    t.last().drop();
    t.reconnect();
    t.last().open();
    t.last().receive(snapshot(9, { logId: 'log-2', questions: [userQuestion('q-x')] }));
    expect(t.notes).toEqual([]);
    expect(t.watcher.state.waiting).toBe(1);
  });

  it('follows the storage health of the snapshot and of status messages', () => {
    const t = setup();
    t.last().open();
    t.last().receive(snapshot(1, { storage: { condition: 'full', held: 2, dropped: 0 } }));
    expect(t.watcher.state.storage).toBe('full');
    t.last().receive({
      type: 'status',
      statuses: [],
      replace: true,
      storage: { condition: 'ok', held: 0, dropped: 0 },
    });
    expect(t.watcher.state.storage).toBe('ok');
  });

  it('reconnects on a gap instead of applying out of order', () => {
    const t = setup();
    t.last().open();
    t.last().receive(snapshot(1));
    t.last().receive(opened(3, userQuestion('q-a')));
    expect(t.last().closed?.reason).toBe('gap in event stream');
    expect(t.notes).toEqual([]);
  });

  it('reports a refused token, and keeps the token out of every state', () => {
    const t = setup();
    t.last().open();
    t.last().drop(CLOSE_UNAUTHORIZED, 'bad token');
    expect(t.watcher.state.connection).toBe('unauthorized');
    expect(JSON.stringify(t.states)).not.toContain('secret-token');
  });

  it('waits and retries while the token cannot be read', () => {
    const t = setup(null);
    expect(t.sockets).toHaveLength(0);
    expect(t.watcher.state).toMatchObject({ connection: 'disconnected' });
  });

  it('counts like the page', () => {
    expect(
      waitingForUser({
        questions: {
          a: userQuestion('a'),
          b: question,
          c: { ...userQuestion('c'), status: 'answered' },
        },
        proposals: { p: proposal, r: { ...proposal, id: 'r', state: 'rejected' } },
      }),
    ).toBe(2);
  });
});
