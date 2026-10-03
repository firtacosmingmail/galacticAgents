import { paintSurfaceLayers } from './surface.js';
import type { PaintJob, PaintReply } from './painter.js';

/**
 * The surface painter's worker (P3-06): paints near-level textures (up to 2048 × 1024, about
 * 1.5 s of noise in V8) off the main thread, so arriving at a planet never freezes the scene.
 * The buffers go back as transferables (no copy).
 */
interface WorkerScope {
  onmessage: ((event: MessageEvent<PaintJob>) => void) | null;
  postMessage(message: PaintReply, transfer: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event) => {
  const { id, look, width, height, detail } = event.data;
  const layers = paintSurfaceLayers(look, width, height, detail);
  const transfer: Transferable[] = [layers.color.buffer];
  if (layers.detail) transfer.push(layers.detail.buffer);
  scope.postMessage({ id, ...layers }, transfer);
};
