import { create } from 'zustand';

/**
 * Scene scale (Phase 3 wave 2 contract): distances from the Sun are given in AU by the catalogue
 * (planets by `meta.orbit` order, asteroids by `meta.orbit.radius`) and mapped to scene units
 * here, so the belt (P3-03) sits between Mars and Jupiter at whatever spacing P3-02 tunes. P3-02
 * owns this file's numbers (the hand-tuned "fake scale" and the "true scale" toggle, corner case
 * 25); everyone else only calls `auToScene` and reads the mode.
 */
export type ScaleMode = 'fake' | 'true';

export const useSceneScale = create<{ mode: ScaleMode; setMode: (mode: ScaleMode) => void }>(
  (set) => ({ mode: 'fake', setMode: (mode) => set({ mode }) }),
);

/** Scene units per AU in true scale. */
export const TRUE_UNITS_PER_AU = 60;

/**
 * Distance from the Sun in scene units. Fake scale compresses the outer system (a square-root
 * curve) so Neptune stays reachable while the inner planets keep room; P3-02 may replace the curve
 * with its spacing table as long as it stays monotonic (the belt relies on that).
 */
export function auToScene(au: number, mode: ScaleMode): number {
  if (mode === 'true') return au * TRUE_UNITS_PER_AU;
  return 18 + Math.sqrt(Math.max(0, au)) * 40;
}
