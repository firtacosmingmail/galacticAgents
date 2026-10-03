import type { BodyLook } from './appearance.js';
import { paintSurfaceLayers, type SurfaceLayers } from './surface.js';

/**
 * Asynchronous surface painting (P3-06). Near-level textures are painted in a worker
 * (`paint-worker.ts`), one job at a time, from a queue kept here: a job whose body no longer wants
 * it (the camera flew on) is dropped before it starts. Without workers (jsdom, a browser that
 * refuses the worker) the job runs on the main thread after a macrotask, so callers see the same
 * asynchronous contract everywhere.
 */
export interface PaintRequest {
  look: BodyLook;
  width: number;
  height: number;
  detail: boolean;
}

/** What the worker receives… */
export interface PaintJob extends PaintRequest {
  id: number;
}

/** …and sends back. */
export interface PaintReply extends SurfaceLayers {
  id: number;
}

interface Queued {
  job: PaintJob;
  signal: AbortSignal | undefined;
  resolve: (layers: SurfaceLayers) => void;
  reject: (reason: unknown) => void;
}

const queue: Queued[] = [];
let running: Queued | undefined;
let nextId = 1;
/** `undefined`: not tried yet; `null`: no worker here (fall back to the main thread). */
let worker: Worker | null | undefined;

function abortError(): Error {
  return new DOMException('The paint job was abandoned.', 'AbortError');
}

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  if (typeof Worker === 'undefined') return (worker = null);
  try {
    const w = new Worker(new URL('./paint-worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (event: MessageEvent<PaintReply>) => {
      const current = running;
      if (!current || current.job.id !== event.data.id) return;
      running = undefined;
      current.resolve({ color: event.data.color, detail: event.data.detail });
      pump();
    };
    w.onerror = (event) => {
      // The worker could not load or crashed: paint on the main thread from now on.
      event.preventDefault();
      w.terminate();
      worker = null;
      const current = running;
      running = undefined;
      if (current) queue.unshift(current);
      pump();
    };
    worker = w;
  } catch {
    worker = null;
  }
  return worker;
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
  const job = next;
  setTimeout(() => {
    running = undefined;
    if (job.signal?.aborted) job.reject(abortError());
    else {
      try {
        job.resolve(
          paintSurfaceLayers(job.job.look, job.job.width, job.job.height, job.job.detail),
        );
      } catch (error) {
        job.reject(error);
      }
    }
    pump();
  }, 0);
}

/** Paints `request` off the main thread when possible; rejects with an `AbortError` if `signal` fires first. */
export function paintAsync(request: PaintRequest, signal?: AbortSignal): Promise<SurfaceLayers> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const entry: Queued = { job: { ...request, id: nextId++ }, signal, resolve, reject };
    queue.push(entry);
    signal?.addEventListener(
      'abort',
      () => {
        const i = queue.indexOf(entry);
        if (i >= 0) {
          queue.splice(i, 1);
          reject(abortError());
        }
      },
      { once: true },
    );
    pump();
  });
}

/** Jobs waiting or running (for tests and the dev measurements). */
export function paintBacklog(): number {
  return queue.length + (running ? 1 : 0);
}
