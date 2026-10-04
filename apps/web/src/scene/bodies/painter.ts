import { runPaintJob, type PaintLayers, type PaintRequest } from './paint-jobs.js';

/**
 * Asynchronous surface painting (P3-06). Near-level textures are painted in a worker
 * (`paint-worker.ts`), one job at a time, from a queue kept here: a job whose body no longer wants
 * it (the camera flew on) is dropped before it starts, and the running one is cut short (the
 * worker is terminated and a fresh one takes the next job), so a stale 2048 map never holds up
 * the queue. Without a worker (jsdom, a browser that refuses or fails to load it) the job runs on
 * the main thread after a macrotask, so callers see the same asynchronous contract everywhere —
 * but such painting blocks the UI, so `paintsOffMainThread()` tells the bodies to ask for lighter
 * maps then (`textures.ts`).
 *
 * The pending jobs are ordered by `paintPriority` (P6-02 review): small jobs — near levels, Earth's
 * clouds — before the detail levels (a 4096 level takes seconds), first come first served within a
 * priority. A running job is never preempted: a small job queued while a big one paints waits for
 * it, but no longer for every big job queued before it.
 */
export type { PaintLayers, PaintRequest };

/** What the worker receives (P6-02: also detail levels and clouds, `paint-jobs.ts`)… */
export type PaintJob = PaintRequest & { id: number };

/** …and sends back. */
export interface PaintReply extends PaintLayers {
  id: number;
}

/**
 * When a job runs, lower first: 0 for the near levels and the clouds (small, wanted at once:
 * the clouds pop in otherwise, an orbiting moon would wait on blurry maps), 1 for the detail levels.
 */
export function paintPriority(request: PaintRequest): number {
  return request.kind === 'detail' ? 1 : 0;
}

interface Queued {
  job: PaintJob;
  priority: number;
  signal: AbortSignal | undefined;
  resolve: (layers: PaintLayers) => void;
  reject: (reason: unknown) => void;
}

/** Makes the paint worker; replaceable in tests (`setPaintWorkerFactoryForTest`). */
type WorkerFactory = () => Worker;

const defaultFactory: WorkerFactory | undefined =
  typeof Worker === 'undefined'
    ? undefined
    : () => new Worker(new URL('./paint-worker.ts', import.meta.url), { type: 'module' });

let factory = defaultFactory;
const queue: Queued[] = [];
let running: Queued | undefined;
let nextId = 1;
/**
 * The worker singleton, shared by every body and every scene mount: created on the first job,
 * kept for the page's lifetime (an idle worker costs nothing but its memory; recreating it would
 * reload the module). It is only ever replaced when the running job is abandoned (terminated, a
 * new one is created for the next job) and given up for good when it fails to load or crashes.
 * `undefined`: not created yet (or terminated); `null`: no worker here (paint on the main thread).
 */
let worker: Worker | null | undefined;
const modeListeners = new Set<() => void>();

function abortError(): Error {
  return new DOMException('The paint job was abandoned.', 'AbortError');
}

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  if (!factory) return (worker = null);
  try {
    const w = factory();
    w.onmessage = (event: MessageEvent<PaintReply>) => {
      const current = running;
      if (worker !== w || !current || current.job.id !== event.data.id) return;
      running = undefined;
      const { color, detail, normal } = event.data;
      current.resolve({ color, detail, normal: normal ?? null });
      pump();
    };
    w.onerror = (event) => {
      // The worker could not load or crashed: paint on the main thread from now on. The jobs it
      // had are failed rather than moved to the main thread — they were sized for a worker; the
      // bodies ask again, for lighter maps (`paintsOffMainThread`).
      event.preventDefault();
      if (worker !== w) return;
      w.terminate();
      giveUpWorker();
    };
    worker = w;
  } catch {
    giveUpWorker();
  }
  return worker ?? null;
}

function giveUpWorker(): void {
  worker = null;
  const failed = [...(running ? [running] : []), ...queue.splice(0)];
  running = undefined;
  const error = new Error('The paint worker is unavailable.');
  for (const job of failed) job.reject(error);
  for (const listener of [...modeListeners]) listener();
}

function pump(): void {
  if (running) return;
  let next = queue.shift();
  while (next?.signal?.aborted) {
    next.reject(abortError());
    next = queue.shift();
  }
  if (!next) return;
  running = next;
  const w = getWorker();
  if (w) {
    w.postMessage(next.job);
    return;
  }
  if (running !== next) return; // the worker failed while being created: `next` was failed
  const job = next;
  setTimeout(() => {
    running = undefined;
    if (job.signal?.aborted) job.reject(abortError());
    else {
      try {
        job.resolve(runPaintJob(job.job));
      } catch (error) {
        job.reject(error);
      }
    }
    pump();
  }, 0);
}

/** Paints `request` off the main thread when possible; rejects with an `AbortError` if `signal` fires first. */
export function paintAsync(request: PaintRequest, signal?: AbortSignal): Promise<PaintLayers> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const priority = paintPriority(request);
    const entry: Queued = { job: { ...request, id: nextId++ }, priority, signal, resolve, reject };
    // After every job of the same or a higher priority (lower number), before the lower ones.
    const at = queue.findIndex((q) => q.priority > priority);
    if (at < 0) queue.push(entry);
    else queue.splice(at, 0, entry);
    signal?.addEventListener(
      'abort',
      () => {
        const i = queue.indexOf(entry);
        if (i >= 0) {
          queue.splice(i, 1);
          reject(abortError());
          return;
        }
        if (running === entry && worker) {
          // Painting in the worker: stop it there; the next job gets a fresh worker.
          worker.terminate();
          worker = undefined;
          running = undefined;
          reject(abortError());
          pump();
        }
        // On the main thread the job checks its signal before it starts.
      },
      { once: true },
    );
    pump();
  });
}

/**
 * Whether near maps are painted off the main thread: true while a worker exists or may still be
 * created, false once it is known to be unavailable (no `Worker`, or it failed to load).
 */
export function paintsOffMainThread(): boolean {
  return getWorker() !== null;
}

/** Calls `listener` when painting falls back to the main thread (for `useSyncExternalStore`). */
export function onPaintModeChange(listener: () => void): () => void {
  modeListeners.add(listener);
  return () => void modeListeners.delete(listener);
}

/** Jobs waiting or running (for tests and the dev measurements). */
export function paintBacklog(): number {
  return queue.length + (running ? 1 : 0);
}

/**
 * Tests: paint with workers made by `make` (`undefined`: the platform's), forgetting the current
 * worker. Call it with nothing queued.
 */
export function setPaintWorkerFactoryForTest(make: WorkerFactory | null | undefined): void {
  worker?.terminate();
  worker = undefined;
  factory = make === undefined ? defaultFactory : (make ?? undefined);
}
