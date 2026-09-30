import { describe, expect, it } from 'vitest';
import { AgentInbox, type InboxMessage } from './inbox.js';

const USER = { type: 'user' } as const;
const tick = () => new Promise((r) => setTimeout(r, 0));

function make() {
  const delivered: string[] = [];
  let interrupts = 0;
  let t = 0;
  const inbox = new AgentInbox('a-1', {
    deliver: (m: InboxMessage) => {
      delivered.push(m.text);
    },
    interrupt: () => {
      interrupts++;
    },
    now: () => `2026-09-30T10:00:${String(t++).padStart(2, '0')}.000Z`,
  });
  return { inbox, delivered, interrupts: () => interrupts };
}

describe('AgentInbox', () => {
  it('queues messages while working and delivers them in order after idle', async () => {
    const { inbox, delivered } = make();
    inbox.enqueue('first', { sender: USER });
    inbox.enqueue('second', { sender: { type: 'agent', id: 'a-0' } });
    expect(delivered).toEqual([]);
    expect(inbox.pending().map((m) => [m.text, m.sender])).toEqual([
      ['first', USER],
      ['second', { type: 'agent', id: 'a-0' }],
    ]);
    inbox.idle();
    await tick();
    expect(delivered).toEqual(['first']);
    expect(inbox.currentState).toBe('working');
    inbox.idle();
    await tick();
    expect(delivered).toEqual(['first', 'second']);
    expect(inbox.pending()).toEqual([]);
    expect(inbox.history().map((m) => [m.text, m.deliveredAt !== undefined])).toEqual([
      ['first', true],
      ['second', true],
    ]);
  });

  it('delivers at once when idle', async () => {
    const { inbox, delivered } = make();
    inbox.idle();
    inbox.enqueue('now', { sender: USER });
    await tick();
    expect(delivered).toEqual(['now']);
  });

  it('an interrupt message cancels the turn and goes first', async () => {
    const { inbox, delivered, interrupts } = make();
    inbox.enqueue('later', { sender: USER });
    inbox.enqueue('urgent', { sender: USER, interrupt: true });
    expect(interrupts()).toBe(1);
    expect(inbox.pending().map((m) => m.text)).toEqual(['urgent', 'later']);
    inbox.idle(); // the adapter reports the cancelled turn as idle
    await tick();
    expect(delivered).toEqual(['urgent']);
    inbox.idle();
    await tick();
    expect(delivered).toEqual(['urgent', 'later']);
  });

  it('an interrupt while idle needs no interrupt call', async () => {
    const { inbox, delivered, interrupts } = make();
    inbox.idle();
    inbox.enqueue('urgent', { sender: USER, interrupt: true });
    await tick();
    expect(interrupts()).toBe(0);
    expect(delivered).toEqual(['urgent']);
  });

  it('holds delivery while paused and resumes into the right state', async () => {
    const { inbox, delivered } = make();
    inbox.paused();
    inbox.enqueue('held', { sender: USER });
    inbox.idle(); // an idle report while paused must not deliver
    expect(inbox.currentState).toBe('paused');
    await tick();
    expect(delivered).toEqual([]);
    inbox.resumed(true);
    await tick();
    expect(delivered).toEqual(['held']);
  });

  it('refuses messages after the agent ended and keeps the pending ones visible', () => {
    const { inbox } = make();
    inbox.enqueue('lost', { sender: USER });
    inbox.ended();
    expect(() => inbox.enqueue('x', { sender: USER })).toThrow(/has ended/);
    expect(inbox.pending().map((m) => m.text)).toEqual(['lost']);
    inbox.idle();
    expect(inbox.currentState).toBe('ended');
  });

  it('an idle report during an in-flight delivery is not lost', async () => {
    const delivered: string[] = [];
    let release: (() => void) | undefined;
    const inbox = new AgentInbox('a-1', {
      deliver: (m) => {
        delivered.push(m.text);
        return new Promise<void>((r) => (release = r)); // the adapter accepts slowly
      },
      interrupt: () => {},
    });
    inbox.idle();
    inbox.enqueue('A', { sender: USER });
    inbox.enqueue('B', { sender: USER });
    await tick();
    expect(delivered).toEqual(['A']);
    inbox.idle(); // arrives while A's delivery is still pending
    release!();
    await tick();
    await tick();
    expect(delivered).toEqual(['A', 'B']);
  });

  it('an interrupt queued while paused fires when work resumes', async () => {
    const { inbox, interrupts } = make();
    inbox.paused();
    inbox.enqueue('urgent', { sender: USER, interrupt: true });
    expect(interrupts()).toBe(0);
    inbox.resumed(false);
    expect(interrupts()).toBe(1);
  });

  it('a failing deliver hook is reported, not thrown', async () => {
    const errors: unknown[] = [];
    const inbox = new AgentInbox('a-1', {
      deliver: () => {
        throw new Error('adapter gone');
      },
      interrupt: () => {},
      onError: (e) => errors.push(e),
    });
    inbox.idle();
    inbox.enqueue('x', { sender: USER });
    await tick();
    expect(errors).toHaveLength(1);
    expect(inbox.history().map((m) => [m.text, m.error, m.deliveredAt])).toEqual([
      ['x', 'adapter gone', undefined],
    ]);
  });
});
