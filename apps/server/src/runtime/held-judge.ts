import type { Id } from '@galactic/protocol';

/**
 * What a held judge call came to: the judge's answer (`ok`), a failure in words (it threw,
 * rejected or took too long), or `cancelled` when `cancel` withdrew it first.
 */
export type HeldOutcome<T> = { ok: true; value: T } | { ok: false; reason: string } | 'cancelled';

/**
 * The machinery the runtime's judge watches share (P12-06 scope watch, P13-04 approval watch):
 * one model call per held tool call, under a timeout the judge itself does not have, abortable
 * per agent. Never throws: a judge that throws, rejects or never settles becomes a failure, and
 * a call `cancel` withdrew comes back `cancelled` — told apart from a timeout, which aborts too.
 */
export class HeldJudgeCalls {
  private readonly running = new Map<Id, Set<AbortController>>();
  private readonly cancelled = new WeakSet<AbortController>();

  constructor(private readonly timeoutMs: number) {}

  /** Judge calls still waiting for their answer. */
  get inFlight(): number {
    let n = 0;
    for (const set of this.running.values()) n += set.size;
    return n;
  }

  /** Runs `start` for `agentId` under the timeout. */
  async run<T>(agentId: Id, start: (signal: AbortSignal) => Promise<T>): Promise<HeldOutcome<T>> {
    const controller = new AbortController();
    let set = this.running.get(agentId);
    if (!set) this.running.set(agentId, (set = new Set()));
    set.add(controller);
    let outcome: HeldOutcome<T> | undefined;
    try {
      outcome = await this.settle(start, controller);
    } finally {
      set.delete(controller);
      if (set.size === 0 && this.running.get(agentId) === set) this.running.delete(agentId);
    }
    if (!outcome || this.cancelled.has(controller)) return 'cancelled';
    return outcome;
  }

  /** Aborts every judge call of `agentId`: they come back `cancelled`. */
  cancel(agentId: Id): void {
    const set = this.running.get(agentId);
    if (!set) return;
    this.running.delete(agentId);
    for (const controller of set) {
      this.cancelled.add(controller);
      controller.abort(new Error('the agent ended or its call was withdrawn'));
    }
  }

  /** The outcome, or `undefined` when the call was aborted by `cancel`. */
  private settle<T>(
    start: (signal: AbortSignal) => Promise<T>,
    controller: AbortController,
  ): Promise<HeldOutcome<T> | undefined> {
    const seconds = Math.round(this.timeoutMs / 1000);
    return new Promise<HeldOutcome<T> | undefined>((resolve) => {
      const settle = (outcome: HeldOutcome<T> | undefined) => {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', onAbort);
        resolve(outcome);
      };
      const onAbort = () => settle(undefined);
      controller.signal.addEventListener('abort', onAbort);
      const timer = setTimeout(() => {
        settle({ ok: false, reason: `the check took longer than ${seconds} s` });
        controller.abort(new Error('the check timed out'));
      }, this.timeoutMs);
      let pending: Promise<T>;
      try {
        pending = start(controller.signal);
      } catch (error) {
        pending = Promise.reject(error);
      }
      pending.then(
        (value) => settle({ ok: true, value }),
        (error: unknown) =>
          settle({
            ok: false,
            reason: `the check failed: ${error instanceof Error ? error.message : String(error)}`,
          }),
      );
    });
  }
}
