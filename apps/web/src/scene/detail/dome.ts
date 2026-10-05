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
 * through the detail body itself (its own orbit line) fade out with the cross-fade instead, and
 * so do the system's decorations that may be inside the dome but do not belong to the view
 * (P6-07: every Sun-centred orbit line, the highlight ring around the shown body, the belt's rocks
 * in a planet's or moon's view — `orbitLineFactor`, `ownRingFactor`, `beltFactor`).
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
 * on the way out; so does every line about the Sun (`aboutSun`, P6-07: in a readable layout the
 * neighbours' lines run through the dome, inside it, and showed as stray arcs in the close-up — no
 * Sun-centred line belongs to a detail view). A moon's line keeps full opacity while drawn (it is
 * part of its planet's system, inside a moon's or planet's view).
 */
export function orbitLineFactor(own: boolean, mix: number, aboutSun = false): number {
  return own || aboutSun ? Math.max(0, 1 - mix) : 1;
}

/**
 * The factor (1 drawn as in the system view … 0 gone) of a highlight ring around a body (P6-07):
 * the ring around the body shown in detail (`own`) fades out with the cross-fade — the body fills
 * the view, and the selection ring drawn over everything at ≈ 1.15 of its radius read as a thick
 * light-blue band outside its atmosphere. Rings around its moons (and satellites) stay.
 */
export function ownRingFactor(own: boolean, mix: number): number {
  return own ? Math.max(0, 1 - mix) : 1;
}

/**
 * The factor (1 lit as in the system view … 0 not drawn) of the belt's rocks — the background
 * rocks and the task asteroids other than the shown one — in a detail view of kind `view`
 * (`undefined`: none) at the cross-fade's `mix` (P6-07). A planet's or moon's backdrop is at least
 * `BACKDROP_MIN_RADII` of its radii, which in the readable layout reaches the belt (Earth's: 68
 * units about a planet 19 units from the belt's inner edge), so its rocks were inside the dome,
 * drawn over it in the close-up. They fade to the backdrop's black with the cross-fade instead and
 * are not drawn once it is complete. An asteroid's view lives in the belt: its rocks stay.
 */
export function beltFactor(view: string | undefined, mix: number): number {
  return view === undefined || view === 'asteroid' ? 1 : Math.max(0, 1 - mix);
}
