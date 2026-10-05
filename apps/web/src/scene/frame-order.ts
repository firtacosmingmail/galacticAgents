/**
 * `useFrame` priorities: R3F runs frame callbacks in ascending priority order (callbacks of one
 * priority in mount order), then renders (a positive priority would take over rendering, so none
 * is used here).
 *
 * - `PLACE_BODIES` (−1): everything that moves a body — `bodies/` `useOrbit` (planets and moons
 *   along their orbits) and the belt's spin (task asteroids ride it). It runs first, so every
 *   reader of an anchor's world position this frame sees where the body is now. (drei's
 *   OrbitControls applies its damping at −1 too.)
 * - `PLACE_DETAIL` (−0.75): the detail view's sub-scene (P6-01, `detail/`) copies its body's anchor
 *   matrix into its own frame and places its backdrop, after the bodies moved and before anything
 *   reads them.
 * - `PLACE_OVERLAY` (−0.6): the detail view's project overlay (P6-04, `detail/overlay/`) places
 *   its task markers in the frame `PLACE_DETAIL` just wrote, and the Steward stand-ins' placement
 *   overrides (`satellites/placement.ts`) the satellites' director applies next.
 * - `PLACE_SATELLITES` (−0.5): the satellites' director (`satellites/Satellites.tsx`) reads the
 *   bodies and writes the satellites' frames (the registry), before their own readers. Its pixel
 *   floor reads the camera as the previous frame left it (a pixel, at most, a frame late).
 * - `PLACE_CAMERA` (−0.25): the camera rig (`camera/CameraRig.tsx`) follows or flies to the
 *   focused body (it reads the bodies) and writes the camera's pose, before anything that lays
 *   itself out in the camera's pixels — so the beacons and picking need not be mounted after it.
 * - `READ_BODIES` (0, the default): the readers of bodies, satellites and the camera — the
 *   satellites' activities (`satellites/activity/`), the beacons (`beacons/Beacons.tsx`: billboards
 *   scaled to this frame's camera), labels, picking (hover rings, the beacons' glyph positions),
 *   moon markers. Mounted in any order, they never draw a body, a satellite or the camera one frame
 *   late.
 */
export const PLACE_BODIES = -1;
export const PLACE_DETAIL = -0.75;
export const PLACE_OVERLAY = -0.6;
export const PLACE_SATELLITES = -0.5;
export const PLACE_CAMERA = -0.25;
export const READ_BODIES = 0;
