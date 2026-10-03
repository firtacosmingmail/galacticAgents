import type { Camera } from 'three';

/**
 * The scene's render layers (P3-08). Everything is on three's default layer 0 except the
 * decorations: orbit lines, the star field, the task asteroids' halos, the highlight and
 * own-project rings. The belt's background rocks stay on layer 0: they do hide task asteroids,
 * so the outline must see them. Leaving the halos out means a selected asteroid's outline is no
 * longer hidden behind its own halo (intended). Those sit on `DECOR_LAYER` only
 * (`layers={DECOR_LAYER}` on the object), and the scene's camera renders both layers.
 *
 * Why: the selection outline (P3-05) re-renders the whole scene into a depth buffer on every frame
 * a body is outlined, to tell the outline's visible edges from its hidden ones. Only real
 * occluders matter there; the decorations added most of its draw calls at the system view (each
 * orbit line is a draw). `withoutDecor` renders that pass without them.
 */
export const DECOR_LAYER = 1;

/** Lets the scene's camera see the decorations (called once the canvas is created). */
export function showDecor(camera: Pick<Camera, 'layers'>): void {
  camera.layers.enable(DECOR_LAYER);
}

/** Runs `render` with `camera` blind to the decorations, restoring its layers afterwards. */
export function withoutDecor<T>(camera: Pick<Camera, 'layers'>, render: () => T): T {
  const mask = camera.layers.mask;
  camera.layers.disable(DECOR_LAYER);
  try {
    return render();
  } finally {
    camera.layers.mask = mask;
  }
}
