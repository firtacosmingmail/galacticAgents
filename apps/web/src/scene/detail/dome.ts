import type { Vec3 } from '../camera/flight.js';

/**
 * The detail view's backdrop dome as plain data (P6-01; no three.js, testable): where it is this
 * frame and which parts of the solar system it hides.
 *
 * **Rule.** Once the view has settled (`covered`), the opaque dome is drawn first and writes depth,
 * so anything beyond it fails the depth test and anything inside it is drawn as before. The system
 * may therefore skip drawing what lies **wholly outside** the dome (work saved, nothing seen
 * changes) but must keep drawing whatever may be inside it — belt rocks and other task asteroids
 * near an asteroid's detail view, the planet of a moon's detail view, an orbit line through the
 * dome — or it would pop out the moment the fade ends (P6-01 review, S2). Lines that would run
 * through the detail body itself (its own orbit line) fade out with the cross-fade instead.
 *
 * The dome is published by the sub-scene's `Backdrop` every frame (`PLACE_DETAIL`), read by the
 * system's components at `READ_BODIES` (after it, before the render).
 */
export interface Dome {
  centre: Vec3;
  radius: number;
}

let current: { dome: Dome; owner: object } | undefined;

/** The backdrop publishes its dome (`owner`: the backdrop, so a stale one cannot clear a newer one). */
export function publishDome(owner: object, centre: Vec3, radius: number): void {
  if (current?.owner === owner) {
    current.dome.centre = centre;
    current.dome.radius = radius;
  } else current = { owner, dome: { centre, radius } };
}

/** The backdrop went away. */
export function clearDome(owner: object): void {
  if (current?.owner === owner) current = undefined;
}

/** The dome now, `undefined` when no detail view is mounted. */
export function currentDome(): Dome | undefined {
  return current?.dome;
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Whether a sphere (a body with everything it carries, `extent` from `centre`) is wholly outside. */
export function sphereOutsideDome(centre: Vec3, extent: number, dome: Dome): boolean {
  return dist(centre, dome.centre) - extent > dome.radius;
}

/** Whether a circle of `radius` about the Sun in the orbital plane (an orbit line) is wholly outside. */
export function orbitOutsideDome(radius: number, dome: Dome): boolean {
  const [x, y, z] = dome.centre;
  return Math.hypot(Math.hypot(x, z) - radius, y) > dome.radius;
}

/**
 * Whether a spherical shell about the Sun from `inner` to `outer` (the belt's rocks, whatever
 * their inclination) is wholly outside: the dome lies entirely inside the shell's hole or beyond it.
 */
export function shellOutsideDome(inner: number, outer: number, dome: Dome): boolean {
  const d = Math.hypot(dome.centre[0], dome.centre[1], dome.centre[2]);
  return d + dome.radius < inner || d - dome.radius > outer;
}

/**
 * Whether a system part is drawn this frame: always while the view is not settled; once it is,
 * unless it is wholly outside the dome (`outside`, given the dome). Without a dome (none mounted),
 * drawn.
 */
export function drawnBehindBackdrop(
  covered: boolean,
  outside: (dome: Dome) => boolean,
  dome: Dome | undefined = currentDome(),
): boolean {
  return !covered || dome === undefined || !outside(dome);
}

/**
 * The opacity factor of a system orbit line: its own body's line (`own`: that body is shown in
 * detail) fades out with the cross-fade's `mix` (it would cut through the close-up) and back in
 * on the way out; any other line keeps full opacity while drawn.
 */
export function orbitLineFactor(own: boolean, mix: number): number {
  return own ? Math.max(0, 1 - mix) : 1;
}
