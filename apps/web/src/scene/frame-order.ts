/**
 * `useFrame` priorities: R3F runs frame callbacks in ascending priority order, then renders (a
 * positive priority would take over rendering, so none is used here).
 *
 * - `PLACE_BODIES` (−1): everything that moves a body — `bodies/` `useOrbit` (planets and moons
 *   along their orbits) and the belt's spin (task asteroids ride it). It runs first, so every
 *   reader of an anchor's world position this frame sees where the body is now.
 * - `PLACE_SATELLITES` (−0.5): the satellites' director (`satellites/Satellites.tsx`) reads the
 *   bodies and writes the satellites' frames (the registry), before their own readers.
 * - `READ_BODIES` (0, the default): the readers — the satellites' activities (`satellites/activity/`), labels, picking,
 *   moon markers, the camera rig. Mounted in any order, they never draw a body one frame late.
 */
export const PLACE_BODIES = -1;
export const PLACE_SATELLITES = -0.5;
export const READ_BODIES = 0;
