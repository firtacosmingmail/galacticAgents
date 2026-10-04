import type { PaintJob, PaintReply } from './painter.js';
import { runPaintJob } from './paint-jobs.js';

/**
 * Tests only: a stand-in for the paint worker (jsdom has no `Worker`). `paint` answers each job
 * after a macrotask with the real pixels; `hold` keeps the jobs until `reply()`; `fail` reports a
 * load error on the first job, like a worker whose script cannot be fetched.
 */
export class FakePaintWorker {
  static made: FakePaintWorker[] = [];
  onmessage: ((event: MessageEvent<PaintReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly jobs: PaintJob[] = [];
  terminated = false;

  constructor(readonly mode: 'paint' | 'hold' | 'fail' = 'paint') {
    FakePaintWorker.made.push(this);
  }

  postMessage(job: PaintJob): void {
    this.jobs.push(job);
    if (this.mode === 'paint') setTimeout(() => this.reply(job), 0);
    if (this.mode === 'fail') setTimeout(() => this.onerror?.(new ErrorEvent('error')), 0);
  }

  /** Answers `job` (default: the last one) unless terminated. */
  reply(job: PaintJob | undefined = this.jobs.at(-1)): void {
    if (this.terminated || !job) return;
    const layers = runPaintJob(job);
    this.onmessage?.({ data: { id: job.id, ...layers } } as MessageEvent<PaintReply>);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** A factory for `setPaintWorkerFactoryForTest`. */
  static factory(mode: FakePaintWorker['mode'] = 'paint'): () => Worker {
    return () => new FakePaintWorker(mode) as unknown as Worker;
  }
}
