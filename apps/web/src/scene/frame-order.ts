/**
 * `useFrame` priorities: R3F runs frame callbacks in ascending priority order, then renders (a
 * positive priority would take over rendering, so none is used here).
 *
 * - `PLACE_BODIES` (−1): everything that moves a body — `bodies/` `useOrbit` (planets and moons
 *   along their orbits) and the belt's spin (task asteroids ride it). It runs first, so every
 *   reader of an anchor's world position this frame sees where the body is now.
 * - `READ_BODIES` (0, the default): the readers — satellites (`satellites/`), labels, picking,
 *   moon markers, the camera rig. Mounted in any order, they never draw a body one frame late.
 */
export const PLACE_BODIES = -1;
export const READ_BODIES = 0;
