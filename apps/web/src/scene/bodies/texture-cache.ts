/**
 * The near-level texture cache (P3-06): reference-counted entries keyed by content, painted
 * asynchronously, kept for a while after the last body lets go (flying away from Jupiter and back
 * should not repaint its 2048-texel surface), within a byte budget set by the quality tier.
 *
 * Generic over anything with `dispose()` and free of three.js, so its bookkeeping is testable
 * without WebGL. Rules:
 *
 * - `acquire` adds a reference and starts the load if the key is new; it returns the value when it
 *   is already there, and a promise either way (resolving to `undefined` when the load is abandoned
 *   or fails);
 * - `release` drops a reference. A pending entry nobody wants any more is aborted and forgotten;
 *   a ready one becomes idle (least recently used first out);
 * - idle entries are disposed as soon as the ready entries' total exceeds the budget, and all of
 *   them on `dropIdle` (a tier change, the scene unmounting); entries in use are never disposed;
 * - a load that finishes after its entry was abandoned disposes what it made.
 */
export interface Disposable {
  dispose(): void;
}

interface Entry<T> {
  key: string;
  bytes: number;
  refs: number;
  value: T | undefined;
  abort: AbortController;
  promise: Promise<T | undefined>;
  /** When it last became idle (a counter, for least-recently-used eviction). */
  idleSince: number;
}

export interface CacheStats {
  entries: number;
  pending: number;
  idle: number;
  /** Bytes held by ready entries (pending ones hold nothing yet). */
  bytes: number;
}

export class TextureCache<T extends Disposable> {
  private readonly entries = new Map<string, Entry<T>>();
  private clock = 0;

  constructor(private budgetBytes: number) {}

  acquire(
    key: string,
    bytes: number,
    load: (signal: AbortSignal) => Promise<T>,
  ): { value: T | undefined; promise: Promise<T | undefined> } {
    const existing = this.entries.get(key);
    if (existing) {
      existing.refs++;
      return { value: existing.value, promise: existing.promise };
    }
    const abort = new AbortController();
    const entry: Entry<T> = {
      key,
      bytes,
      refs: 1,
      value: undefined,
      abort,
      idleSince: 0,
      promise: Promise.resolve(undefined),
    };
    this.entries.set(key, entry);
    entry.promise = load(abort.signal).then(
      (value) => {
        if (this.entries.get(key) !== entry || abort.signal.aborted) {
          value.dispose();
          return undefined;
        }
        entry.value = value;
        this.evict();
        return value;
      },
      () => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        return undefined;
      },
    );
    return { value: undefined, promise: entry.promise };
  }

  /** The value under `key` if it is ready (without taking a reference). */
  peek(key: string): T | undefined {
    return this.entries.get(key)?.value;
  }

  release(key: string): void {
    const entry = this.entries.get(key);
    if (!entry || entry.refs === 0) return;
    entry.refs--;
    if (entry.refs > 0) return;
    if (entry.value === undefined) {
      entry.abort.abort();
      this.entries.delete(key);
      return;
    }
    entry.idleSince = ++this.clock;
    this.evict();
  }

  setBudget(bytes: number): void {
    this.budgetBytes = bytes;
    this.evict();
  }

  /** Disposes every idle entry. */
  dropIdle(): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.refs === 0) this.dispose(entry);
    }
  }

  stats(): CacheStats {
    let pending = 0;
    let idle = 0;
    let bytes = 0;
    for (const e of this.entries.values()) {
      if (e.value === undefined) pending++;
      else {
        bytes += e.bytes;
        if (e.refs === 0) idle++;
      }
    }
    return { entries: this.entries.size, pending, idle, bytes };
  }

  private evict(): void {
    let total = this.stats().bytes;
    if (total <= this.budgetBytes) return;
    const idle = [...this.entries.values()]
      .filter((e) => e.refs === 0 && e.value !== undefined)
      .sort((a, b) => a.idleSince - b.idleSince);
    for (const entry of idle) {
      if (total <= this.budgetBytes) break;
      total -= entry.bytes;
      this.dispose(entry);
    }
  }

  private dispose(entry: Entry<T>): void {
    this.entries.delete(entry.key);
    entry.abort.abort();
    entry.value?.dispose();
  }
}
