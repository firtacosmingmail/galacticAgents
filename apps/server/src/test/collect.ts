/**
 * Collects items from an async iterable in the background until `stop()` is called. Tests use it
 * to assert on events emitted by an adapter or the supervisor without blocking on the stream.
 */
export function collect<T>(source: AsyncIterable<T>): {
  items: T[];
  /** Resolves once `predicate` holds for the items collected so far (or rejects on timeout). */
  waitFor(predicate: (items: T[]) => boolean, timeoutMs?: number): Promise<T[]>;
  stop(): void;
} {
  const items: T[] = [];
  const watchers = new Set<() => void>();
  let stopped = false;
  void (async () => {
    for await (const item of source) {
      if (stopped) break;
      items.push(item);
      for (const w of [...watchers]) w();
    }
  })();
  return {
    items,
    waitFor(predicate, timeoutMs = 5_000) {
      if (predicate(items)) return Promise.resolve(items);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          watchers.delete(check);
          reject(
            new Error(
              `waitFor timed out after ${timeoutMs}ms; collected: ${JSON.stringify(items).slice(0, 2000)}`,
            ),
          );
        }, timeoutMs);
        const check = () => {
          if (predicate(items)) {
            clearTimeout(timer);
            watchers.delete(check);
            resolve(items);
          }
        };
        watchers.add(check);
      });
    },
    stop() {
      stopped = true;
    },
  };
}
