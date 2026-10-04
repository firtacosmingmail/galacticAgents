import { runPaintJob, transferablesOf } from '../detail/visuals/paint-jobs.js';
import type { PaintJob, PaintReply } from './painter.js';

/**
 * The surface painter's worker (P3-06): paints near-level textures (up to 2048 × 1024, about
 * 1.5 s of noise in V8; P6-02's 4096 detail levels several seconds) off the main thread, so arriving at a planet never freezes the scene.
 * The buffers go back as transferables (no copy).
 */
interface WorkerScope {
  onmessage: ((event: MessageEvent<PaintJob>) => void) | null;
  postMessage(message: PaintReply, transfer: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event) => {
  const layers = runPaintJob(event.data);
  scope.postMessage({ id: event.data.id, ...layers }, transferablesOf(layers));
};
