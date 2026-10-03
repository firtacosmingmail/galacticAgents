import { create } from 'zustand';

/**
 * Scene scale (Phase 3 wave 2 contract): distances from the Sun are given in AU by the catalogue
 * (planets by `meta.orbit` order, asteroids by `meta.orbit.radius`) and mapped to scene units
 * here, so the belt (P3-03) sits between Mars and Jupiter at whatever spacing P3-02 tunes. P3-02
 * owns this file's numbers (the hand-tuned "fake scale" and the "true scale" toggle, corner case
 * 25); everyone else only calls `auToScene` and reads the mode.
 *
 * - **fake** (the default, "readable layout"): a hand-tuned spacing table. Each planet's real
 *   semi-major axis maps to a chosen radius, and distances in between are interpolated linearly,
 *   so the inner planets keep room, the outer ones stay reachable, and the belt (2.2–3.3 AU) lands
 *   in the gap between Mars's moons and Jupiter's.
 * - **true**: distances from the Sun proportional to the real ones (`TRUE_UNITS_PER_AU`). Planet
 *   sizes and moon orbits are enlarged by one common factor (`bodies/layout.ts`), or nothing would
 *   be visible; the UI says so.
 *
 * No three.js here: the panel's first chunk imports this module (the scale toggle).
 */
export type ScaleMode = 'fake' | 'true';

export const useSceneScale = create<{ mode: ScaleMode; setMode: (mode: ScaleMode) => void }>(
  (set) => ({ mode: 'fake', setMode: (mode) => set({ mode }) }),
);

/**
 * Scene units per AU in true scale. Neptune (30.07 AU) and its outermost moon stay inside the
 * star-field shell's radius (`STAR_SHELL.inner` = 1200); the shell is centred on the camera every
 * frame, so the sky stays a backdrop wherever the camera goes, the overview included.
 */
export const TRUE_UNITS_PER_AU = 35;

/** Kilometres per AU. */
export const KM_PER_AU = 149_597_871;

/**
 * True scale: scene units per km for body sizes and moon orbits. At true distances a planet would
 * be far below a pixel, so sizes and moon systems are all enlarged by one common factor
 * (`TRUE_SIZE_EXAGGERATION`, ≈ 85): their proportions to each other stay true, and no moon system
 * reaches a neighbour's lane or the belt. The Sun keeps its readable size (it is not to scale).
 */
export const TRUE_UNITS_PER_KM = 2e-5;

/** How much true scale enlarges sizes and moon orbits against the distances (shown in the UI). */
export const TRUE_SIZE_EXAGGERATION = Math.round(
  TRUE_UNITS_PER_KM / (TRUE_UNITS_PER_AU / KM_PER_AU),
);

/** The real semi-major axes (AU) of the planets, by catalogue orbit (1 = Mercury … 8 = Neptune). */
export const PLANET_AU: readonly number[] = [0.387, 0.723, 1.0, 1.524, 5.203, 9.537, 19.19, 30.07];

/**
 * The fake-scale spacing table: [AU, scene units] knots, one per planet (plus the Sun), strictly
 * increasing in both columns. Hand-tuned: a planet's moons never reach a neighbour's lane, and the
 * belt (2.2–3.3 AU → ≈ 52–66) clears Mars's moons (≤ 46) and Jupiter's (≥ 76).
 */
export const FAKE_SPACING: readonly (readonly [au: number, scene: number])[] = [
  [0, 0],
  [0.387, 16],
  [0.723, 24],
  [1.0, 33],
  [1.524, 43],
  [5.203, 90],
  [9.537, 125],
  [19.19, 160],
  [30.07, 192],
];

/** Scene units per AU past Neptune in fake scale (keeps the curve monotonic for anything farther). */
const FAKE_TAIL_UNITS_PER_AU = 3;

/**
 * Distance from the Sun in scene units. Strictly increasing in `au` for both modes (the belt relies
 * on it); negative input is treated as 0.
 */
export function auToScene(au: number, mode: ScaleMode): number {
  const d = Math.max(0, au);
  if (mode === 'true') return d * TRUE_UNITS_PER_AU;
  for (let i = 1; i < FAKE_SPACING.length; i++) {
    const [a1, s1] = FAKE_SPACING[i]!;
    if (d <= a1) {
      const [a0, s0] = FAKE_SPACING[i - 1]!;
      return s0 + ((d - a0) / (a1 - a0)) * (s1 - s0);
    }
  }
  const [aLast, sLast] = FAKE_SPACING[FAKE_SPACING.length - 1]!;
  return sLast + (d - aLast) * FAKE_TAIL_UNITS_PER_AU;
}
