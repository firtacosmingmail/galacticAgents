import { randomUUID } from 'node:crypto';
import type { Actor, Id } from '@galactic/protocol';

/**
 * The per-agent inbox (P1-07; TECHNOLOGY §3.4 "send: enqueued, delivered when idle"). The
 * runtime owns the queue, not the adapter: messages wait here while the agent works, are handed
 * to the adapter one at a time when it is idle, and every one records who sent it. An
 * `interrupt` message asks the runtime to cancel the current turn and then goes first.
 *
 * The inbox knows nothing about events; the runtime tells it `working()` / `idle()` / `paused()`
 * from the agent's stream.
 */

export interface InboxMessage {
  id: string;
  agentId: Id;
  text: string;
  sender: Actor;
  interrupt: boolean;
  queuedAt: string;
  deliveredAt?: string;
  /** Set when the adapter refused the message; it is kept in the history, not retried. */
  error?: string;
}

export interface InboxHooks {
  /** Hands one message to the adapter. Resolves when it was accepted (not when answered). */
  deliver: (message: InboxMessage) => Promise<void> | void;
  /** Cancels the agent's current turn; `idle()` follows when the adapter reports it. */
  interrupt: () => Promise<void> | void;
  now?: () => string;
  onError?: (error: unknown) => void;
}

export type InboxState = 'working' | 'idle' | 'paused' | 'ended';

export class AgentInbox {
  private readonly queue: InboxMessage[] = [];
  private readonly delivered: InboxMessage[] = [];
  private state: 'working' | 'idle' | 'ended' = 'working';
  private isPaused = false;
  private delivering = false;
  private readonly now: () => string;

  constructor(
    readonly agentId: Id,
    private readonly hooks: InboxHooks,
  ) {
    this.now = hooks.now ?? (() => new Date().toISOString());
  }

  get currentState(): InboxState {
    return this.state !== 'ended' && this.isPaused ? 'paused' : this.state;
  }

  /** Messages waiting for delivery, in the order they will go. */
  pending(): InboxMessage[] {
    return [...this.queue];
  }

  /** Messages already handed to the adapter, oldest first. */
  history(): InboxMessage[] {
    return [...this.delivered];
  }

  /**
   * Queues a message. Delivered at once when the agent is idle; with `interrupt`, the current
   * turn is cancelled and the message jumps the queue.
   */
  enqueue(text: string, opts: { sender: Actor; interrupt?: boolean }): InboxMessage {
    if (this.state === 'ended') throw new Error(`agent ${this.agentId} has ended`);
    const message: InboxMessage = {
      id: randomUUID(),
      agentId: this.agentId,
      text,
      sender: opts.sender,
      interrupt: opts.interrupt ?? false,
      queuedAt: this.now(),
    };
    if (message.interrupt) {
      this.queue.unshift(message);
      if (this.state === 'working' && !this.isPaused)
        void this.safely(() => this.hooks.interrupt());
    } else {
      this.queue.push(message);
    }
    this.pump();
    return message;
  }

  /** The agent reported idle: the next queued message goes out. */
  idle(): void {
    if (this.state === 'ended') return;
    this.state = 'idle';
    this.pump();
  }

  /** The agent is busy (output, tool call, question): nothing is delivered. */
  working(): void {
    if (this.state === 'ended') return;
    this.state = 'working';
  }

  /** Delivery is held until `resumed()`; idle/working reports are still remembered. */
  paused(): void {
    if (this.state === 'ended') return;
    this.isPaused = true;
  }

  /** Back from a pause; the runtime says whether the agent is idle now. */
  resumed(idle?: boolean): void {
    if (this.state === 'ended') return;
    this.isPaused = false;
    if (idle !== undefined) this.state = idle ? 'idle' : 'working';
    // An interrupt queued during the pause still means "cancel the turn" once work resumes.
    if (this.state === 'working' && this.queue[0]?.interrupt) {
      void this.safely(() => this.hooks.interrupt());
    }
    this.pump();
  }

  /** Finished, failed or stopped: pending messages are kept for inspection, nothing is delivered. */
  ended(): void {
    this.state = 'ended';
  }

  private pump(): void {
    if (this.state !== 'idle' || this.isPaused || this.delivering || this.queue.length === 0)
      return;
    const message = this.queue.shift()!;
    this.delivering = true;
    this.state = 'working';
    void (async () => {
      try {
        await this.hooks.deliver(message);
        message.deliveredAt = this.now();
      } catch (error) {
        message.error = (error as Error).message;
        (this.hooks.onError ?? (() => {}))(error);
      }
      this.delivered.push(message);
      this.delivering = false;
      // An idle report may have arrived while the delivery was in flight.
      this.pump();
    })();
  }

  private async safely(fn: () => Promise<void> | void): Promise<void> {
    try {
      await fn();
    } catch (error) {
      (this.hooks.onError ?? (() => {}))(error);
    }
  }
}
