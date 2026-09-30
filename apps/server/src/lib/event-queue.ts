/**
 * An unbounded push queue exposed as an `AsyncIterable`: the shape `AgentAdapter.events` takes.
 * One consumer at a time; `close()` ends the iteration once the buffered items are drained.
 */
export class EventQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private waiting: ((r: IteratorResult<T>) => void) | undefined;
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: item, done: false });
    } else {
      this.buffer.push(item);
    }
  }

  close(): void {
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: undefined, done: true });
    }
  }

  get size(): number {
    return this.buffer.length;
  }

  /** Items pushed so far and not yet consumed, without consuming them. Tests only. */
  peek(): readonly T[] {
    return this.buffer;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        if (this.waiting) throw new Error('EventQueue supports one pending read at a time');
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
      // A consumer that breaks out of `for await` detaches; the producer keeps running and a
      // later iteration sees what was pushed meanwhile. Only `close()` ends the stream.
      return: (): Promise<IteratorResult<T>> => {
        this.waiting = undefined;
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
