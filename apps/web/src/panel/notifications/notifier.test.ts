// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notificationOf } from '@galactic/protocol';
import type {
  Agent,
  Event,
  PanelNotification,
  Question,
  ServerMessage,
  StatusRecord,
} from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { useAppStore } from '../../state/store.js';
import { FakeNotification } from './fake-notification.js';
import {
  createNotifier,
  BACKFILL_MAX_SHOWN,
  liveNotificationCount,
  type Notifier,
} from './notifier.js';
import { clearLedgerMemory, LEDGER_KEY, readLedger } from './ledger.js';
import { PREFS_KEY, resetPrefsStorage, useNotificationPrefs } from './prefs.js';
import { focusFor, focusTarget } from './focus.js';

/** The notification of one stream message, as the server's feed would list it. */
function notificationOfMessage(m: ServerMessage): PanelNotification | undefined {
  if (m.type !== 'event') return undefined;
  const { type: _t, ...envelope } = m;
  const w = useAppStore.getState().world;
  return notificationOf(envelope, {
    task: (id) => w.tasks[id],
    project: (id) => w.projects[id],
    question: (id) => w.questions[id],
    agent: (id) => w.agents[id],
  });
}

/** P25-07: desktop notifications folded from the stream, deduped across reconnects and reloads. */

const NOW = Date.parse(fx.NOW);
const at = (s: number) => new Date(NOW + s * 1000).toISOString();

const waykeeper: Agent = {
  ...fx.harmonizer,
  id: 'a-waykeeper-1',
  role: 'waykeeper',
  projectId: 'p-1',
  supervisorId: 'a-harmonizer',
  bodyId: 'b-luna',
};
const steward: Agent = fx.agent; // Steward of t-1 on p-1
const asteroidSteward: Agent = {
  ...fx.agent,
  id: 'a-steward-2',
  taskId: 't-2',
  supervisorId: 'a-harmonizer',
  bodyId: 'b-ast-1',
};
const live = (agentId: string): StatusRecord => ({ ...fx.status, agentId });

const userQuestion = (over: Partial<Question> = {}): Question => ({
  ...fx.question,
  holder: { type: 'user' },
  ...over,
});

function snapshot(seq: number, logId = 'log-1', questions: Question[] = []): ServerMessage {
  return {
    type: 'snapshot',
    logId,
    seq,
    agents: [fx.harmonizer, waykeeper, steward, asteroidSteward],
    bodies: [fx.body, fx.moon, fx.asteroid],
    projects: [fx.project],
    tasks: [fx.task, fx.asteroidTask],
    questions,
    proposals: [],
    statuses: [
      live(fx.harmonizer.id),
      live(waykeeper.id),
      live(steward.id),
      live(asteroidSteward.id),
    ],
  };
}
const event = (seq: number, e: Event, atSec = seq): ServerMessage => ({
  type: 'event',
  seq,
  at: at(atSec),
  event: e,
});

/** One of each trigger SPEC §4.5 names, in seq order from 11. */
const triggers = (): ServerMessage[] => [
  event(11, { type: 'question.opened', question: userQuestion({ id: 'q-c' }) }),
  event(12, {
    type: 'question.opened',
    question: userQuestion({ id: 'q-p', kind: 'permission' }),
  }),
  event(13, { type: 'task.state_changed', taskId: 't-1', from: 'in_progress', to: 'completed' }),
  event(14, { type: 'task.state_changed', taskId: 't-2', from: 'in_progress', to: 'failed' }),
  event(15, {
    type: 'project.state_changed',
    projectId: 'p-1',
    from: 'in_progress',
    to: 'completed',
  }),
  event(16, { type: 'recovery.needs_attention', agentId: steward.id, reason: 'resume failed' }),
  event(17, {
    type: 'proposal.parked',
    proposalId: 'pr-1',
    reason: 'no free planet',
    waitingFor: 'planet',
  }),
];

let notifier: Notifier;
let fetchMock: ReturnType<typeof vi.fn>;
let feed: PanelNotification[] = [];

function enable(on = true) {
  FakeNotification.permission = on ? 'granted' : 'default';
  localStorage.setItem(PREFS_KEY, JSON.stringify({ enabled: on }));
  useNotificationPrefs.getState().reload();
}

/** A page: a fresh store and notifier, both fed every message (as `startSession` wires them). */
function openPage() {
  useAppStore.getState().reset();
  notifier = createNotifier({
    token: 'tok',
    fetchImpl: fetchMock as never,
    now: () => NOW + 60_000,
  });
  return (...messages: ServerMessage[]) => {
    for (const m of messages) {
      useAppStore.getState().apply(m);
      notifier.onMessage(m);
    }
  };
}

const shown = () => FakeNotification.instances.map((n) => n.tag);

beforeEach(() => {
  localStorage.clear();
  clearLedgerMemory();
  resetPrefsStorage();
  FakeNotification.reset();
  vi.stubGlobal('Notification', FakeNotification);
  feed = [];
  fetchMock = vi.fn(async (url: string) => {
    const after = Number(new URL(url, 'http://x').searchParams.get('after'));
    const notifications = feed.filter((n) => n.seq > after);
    return new Response(
      JSON.stringify({
        notifications,
        seq: Math.max(after, ...notifications.map((n) => n.seq)),
        hasMore: false,
      }),
    );
  });
  enable();
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  notifier?.stop();
  vi.unstubAllGlobals();
});

describe('desktop notifications (P25-07)', () => {
  it('raises each trigger exactly once, with names from the world', () => {
    const feedPage = openPage();
    feedPage(snapshot(10), ...triggers());
    expect(shown()).toEqual([
      'question:q-c',
      'question:q-p',
      'task:t-1:completed:13',
      'task:t-2:failed:14',
      'project:p-1:completed:15',
      `interrupted:${steward.id}:16`,
      'no_space:pr-1:17',
    ]);
    const [question, permission, task] = FakeNotification.instances;
    expect(question!.title).toBe('A question for you');
    expect(permission!.title).toBe('Permission needed');
    expect(task!.options.body).toBe(fx.task.description);
  });

  it('raises a question once however often it reaches the user', () => {
    const feedPage = openPage();
    const held = userQuestion({ id: 'q-e', holder: { type: 'agent', id: waykeeper.id } });
    feedPage(
      snapshot(10),
      event(11, { type: 'question.opened', question: held }),
      event(12, {
        type: 'question.escalated',
        questionId: 'q-e',
        from: { type: 'agent', id: waykeeper.id },
        to: { type: 'user' },
        version: 1,
      }),
      event(13, {
        type: 'question.reassigned',
        questionId: 'q-e',
        from: { type: 'user' },
        to: { type: 'agent', id: waykeeper.id },
        version: 2,
      } as Event),
      event(14, {
        type: 'question.escalated',
        questionId: 'q-e',
        from: { type: 'agent', id: waykeeper.id },
        to: { type: 'user' },
        version: 3,
      }),
    );
    expect(shown()).toEqual(['question:q-e']);
  });

  it('does not replay history on the first load of a log', async () => {
    feed = [
      {
        id: 'question:q-old',
        kind: 'question',
        seq: 5,
        at: at(5),
        title: 'x',
        target: { kind: 'question', id: 'q-old' },
      },
    ];
    const feedPage = openPage();
    feedPage(snapshot(10, 'log-1', [userQuestion({ id: 'q-old' })]));
    await notifier.idle();
    expect(shown()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readLedger()).toMatchObject({ logId: 'log-1', seq: 10 });
  });

  it('never duplicates across a reconnect that replays or takes a new snapshot', async () => {
    const feedPage = openPage();
    const all = triggers();
    feedPage(snapshot(10), ...all.slice(0, 3));
    expect(shown()).toHaveLength(3);
    // The connection drops. It cannot resume: a snapshot at 15 (events 14 and 15 folded into it),
    // then 16 and 17 live. The server's feed is the same function over the log, so it lists
    // 11..15 with the same ids the stream gave.
    feed = all.slice(0, 5).map((m) => notificationOfMessage(m)!);
    feedPage(snapshot(15, 'log-1', [userQuestion({ id: 'q-c' }), userQuestion({ id: 'q-p' })]));
    await notifier.idle();
    feedPage(...all.slice(5));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/notifications?after=13&limit=100');
    // Each trigger once (the backfilled two in their own order: newest first).
    expect([...shown()].sort()).toEqual(all.map((m) => notificationOfMessage(m)!.id).sort());
  });

  it('never duplicates when a resumed stream repeats events', () => {
    const feedPage = openPage();
    const all = triggers();
    feedPage(snapshot(10), ...all.slice(0, 3));
    feedPage(...all.slice(1)); // 12 and 13 again, then the rest
    expect(shown()).toEqual(all.map((m) => notificationOfMessage(m)!.id));
  });

  it('never duplicates across a reload, and backfills what happened while it was closed', async () => {
    let feedPage = openPage();
    feedPage(snapshot(10), ...triggers().slice(0, 2));
    expect(shown()).toEqual(['question:q-c', 'question:q-p']);
    notifier.stop();

    // While the page was closed: a task finished (seq 13). The reload's snapshot is at 13.
    feed = [
      {
        id: 'question:q-c',
        kind: 'question',
        seq: 11,
        at: at(11),
        title: 'q',
        target: { kind: 'question', id: 'q-c' },
      },
      {
        id: 'task:t-1:completed:13',
        kind: 'task_completed',
        seq: 13,
        at: at(13),
        title: 'Task finished',
        target: { kind: 'task', id: 't-1' },
      },
    ];
    feedPage = openPage();
    feedPage(snapshot(13, 'log-1', [userQuestion({ id: 'q-c' })]));
    await notifier.idle();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/notifications?after=12&limit=100',
      expect.objectContaining({ headers: { authorization: 'Bearer tok' } }),
    );
    expect(shown()).toEqual(['question:q-c', 'question:q-p', 'task:t-1:completed:13']);

    // A second reload with nothing new: nothing raised, no backfill.
    fetchMock.mockClear();
    notifier.stop();
    feedPage = openPage();
    feedPage(snapshot(13));
    await notifier.idle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(shown()).toHaveLength(3);
  });

  it('a second tab on the same browser does not raise what the first one raised', () => {
    const tabA = openPage();
    tabA(snapshot(10));
    const notifierA = notifier;
    const tabB = (() => {
      const b = createNotifier({ token: 'tok', fetchImpl: fetchMock as never });
      b.onMessage(snapshot(10));
      return (m: ServerMessage) => b.onMessage(m);
    })();
    const [first] = triggers();
    useAppStore.getState().apply(first!);
    notifierA.onMessage(first!);
    tabB(first!);
    expect(shown()).toEqual(['question:q-c']);
  });

  it('decides on the preferences another tab just saved, so the claim never hides a notification', () => {
    enable(false);
    const feedPage = openPage();
    feedPage(snapshot(10));
    // The user turns notifications on in another tab: storage has it, this tab's store does not
    // yet (its `storage` event has not arrived). This tab must show, not claim and drop it.
    FakeNotification.permission = 'granted';
    localStorage.setItem(PREFS_KEY, JSON.stringify({ enabled: true }));
    expect(useNotificationPrefs.getState().enabled).toBe(false);
    feedPage(triggers()[0]!);
    expect(shown()).toEqual(['question:q-c']);
    expect(useNotificationPrefs.getState().enabled).toBe(true);
  });

  it('follows another tab’s change through the storage event', () => {
    enable(false);
    localStorage.setItem(PREFS_KEY, JSON.stringify({ enabled: true, kinds: { question: false } }));
    window.dispatchEvent(new StorageEvent('storage', { key: PREFS_KEY }));
    expect(useNotificationPrefs.getState()).toMatchObject({
      enabled: true,
      kinds: { question: false, permission: true },
    });
  });

  it('once storage refuses writes, the page’s own ledger wins: no repeats', () => {
    const feedPage = openPage();
    feedPage(snapshot(10));
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    try {
      const [first, second] = triggers();
      feedPage(first!, second!);
      feedPage(first!, second!); // a resumed stream repeating them
      expect(shown()).toEqual(['question:q-c', 'question:q-p']);
      expect(readLedger()).toMatchObject({ seq: 12, ids: ['question:q-c', 'question:q-p'] });
      // Storage still holds the stale ledger; it is not read back.
      expect(JSON.parse(localStorage.getItem(LEDGER_KEY)!)).toMatchObject({ seq: 10 });
    } finally {
      setItem.mockRestore();
    }
  });

  it('holds a shown notification until it closes', () => {
    const before = liveNotificationCount();
    const feedPage = openPage();
    feedPage(snapshot(10), triggers()[0]!);
    expect(liveNotificationCount()).toBe(before + 1);
    FakeNotification.instances.at(-1)!.close();
    expect(liveNotificationCount()).toBe(before);
  });

  it('scrolls the inbox into view once the panel has rendered after the navigation', async () => {
    vi.spyOn(window, 'focus').mockImplementation(() => {});
    useAppStore.getState().reset();
    window.history.replaceState(null, '', '/settings');
    focusTarget(undefined);
    // The panel renders after the navigation: the inbox appears only now.
    const inbox = document.createElement('section');
    inbox.setAttribute('aria-label', 'inbox');
    const scroll = vi.fn();
    inbox.scrollIntoView = scroll;
    document.body.appendChild(inbox);
    try {
      await new Promise((r) => setTimeout(r, 60));
      expect(scroll).toHaveBeenCalled();
    } finally {
      inbox.remove();
    }
  });

  it('caps the backfill: a day old at most, five shown, the rest in one summary', async () => {
    let feedPage = openPage();
    feedPage(snapshot(10));
    notifier.stop();
    const task = (seq: number, atSec: number): PanelNotification => ({
      id: `task:t-${seq}:completed:${seq}`,
      kind: 'task_completed',
      seq,
      at: at(atSec),
      title: 'Task finished',
      target: { kind: 'task', id: `t-${seq}` },
    });
    feed = [
      task(11, -2 * 24 * 3600), // two days old: dropped
      ...[12, 13, 14, 15, 16, 17, 18].map((s) => task(s, s)),
      {
        id: 'question:q-z',
        kind: 'permission',
        seq: 19,
        at: at(19),
        title: 'Permission needed',
        target: { kind: 'question', id: 'q-z' },
      },
    ];
    feedPage = openPage();
    feedPage(snapshot(19));
    await notifier.idle();
    // The permission first, then the newest tasks; the remaining three folded into one summary.
    expect(shown()).toEqual([
      'question:q-z',
      'task:t-18:completed:18',
      'task:t-17:completed:17',
      'task:t-16:completed:16',
      'task:t-15:completed:15',
      'galactic:backfill-summary',
    ]);
    expect(shown().length - 1).toBe(BACKFILL_MAX_SHOWN);
    expect(FakeNotification.instances.at(-1)!.title).toBe(
      '3 more updates while the page was closed',
    );
  });

  it('a kind switched off is not raised, now or later', () => {
    useNotificationPrefs.getState().setKind('task_completed', false);
    const feedPage = openPage();
    feedPage(snapshot(10), ...triggers());
    expect(shown()).not.toContain('task:t-1:completed:13');
    expect(shown()).toContain('task:t-2:failed:14');
    expect(readLedger()!.ids).toContain('task:t-1:completed:13');
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!)).toMatchObject({
      kinds: { task_completed: false },
    });
  });

  it('while off nothing is raised and the cursor still advances; on, only new events notify', () => {
    enable(false);
    const feedPage = openPage();
    feedPage(snapshot(10), ...triggers().slice(0, 3));
    expect(shown()).toEqual([]);
    expect(readLedger()!.seq).toBe(13);
    enable(true);
    feedPage(...triggers().slice(3, 4));
    expect(shown()).toEqual(['task:t-2:failed:14']);
  });

  it('a browser that refused permission raises nothing', () => {
    FakeNotification.permission = 'denied';
    const feedPage = openPage();
    feedPage(snapshot(10), ...triggers());
    expect(shown()).toEqual([]);
  });

  it('a new database (another logId) starts a new baseline', async () => {
    let feedPage = openPage();
    feedPage(snapshot(10), ...triggers().slice(0, 1));
    feed = [
      {
        id: 'question:q-new',
        kind: 'question',
        seq: 3,
        at: at(3),
        title: 'q',
        target: { kind: 'question', id: 'q-new' },
      },
    ];
    notifier.stop();
    feedPage = openPage();
    feedPage(snapshot(4, 'log-2'));
    await notifier.idle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readLedger()).toMatchObject({ logId: 'log-2', seq: 4, ids: [] });
    expect(localStorage.getItem(LEDGER_KEY)).toContain('log-2');
  });

  it('a click focuses the window and selects the item the notification is about', () => {
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
    const feedPage = openPage();
    feedPage(snapshot(10), ...triggers());
    const click = (tag: string) => {
      const n = FakeNotification.instances.find((i) => i.tag === tag)!;
      n.onclick!();
      expect(n.closed).toBe(true);
      return useAppStore.getState().selection;
    };
    // A Steward's question on p-1: the thread of p-1's Waykeeper (decision 55).
    expect(click('question:q-c')).toEqual({ kind: 'waykeeper', id: waykeeper.id });
    // A task: its Steward (decision 53).
    expect(click('task:t-1:completed:13')).toEqual({ kind: 'steward', id: steward.id });
    expect(click('task:t-2:failed:14')).toEqual({ kind: 'steward', id: asteroidSteward.id });
    // A project: its Waykeeper.
    expect(click('project:p-1:completed:15')).toEqual({ kind: 'waykeeper', id: waykeeper.id });
    // The interrupted agent's own view.
    expect(click(`interrupted:${steward.id}:16`)).toEqual({ kind: 'steward', id: steward.id });
    // A parked request: the Harmonizer (its card and the inbox).
    expect(click('no_space:pr-1:17')).toEqual({ kind: 'harmonizer' });
    expect(window.location.pathname).toBe('/');
    expect(focus).toHaveBeenCalled();
  });
});

describe('focusFor', () => {
  const world = () => useAppStore.getState().world;
  beforeEach(() => {
    useAppStore.getState().reset();
    useAppStore.getState().apply(snapshot(10, 'log-1', [userQuestion({ id: 'q-c' })]));
  });

  it('sends an unknown question to the inbox and a Harmonizer question to its thread', () => {
    expect(focusFor(world(), { kind: 'question', id: 'missing' })).toEqual({
      selection: { kind: 'harmonizer' },
      inbox: true,
    });
    const own = userQuestion({ id: 'q-h', originAgentId: fx.harmonizer.id });
    useAppStore.getState().apply(event(11, { type: 'question.opened', question: own }));
    expect(focusFor(world(), { kind: 'question', id: 'q-h' })).toEqual({
      selection: { kind: 'harmonizer' },
      inbox: false,
    });
  });

  it('falls back to the project’s Waykeeper for a task with no Steward, else the Harmonizer', () => {
    useAppStore.getState().apply(
      event(11, {
        type: 'task.created',
        task: { ...fx.task, id: 't-9', state: 'approved' },
      }),
    );
    expect(focusFor(world(), { kind: 'task', id: 't-9' }).selection).toEqual({
      kind: 'waykeeper',
      id: waykeeper.id,
    });
    expect(focusFor(world(), { kind: 'project', id: 'p-unknown' }).selection).toEqual({
      kind: 'harmonizer',
    });
  });
});
