/**
 * The one orbit convention of the scene (Phase 3 wave 2), shared by the planets and moons (P3-02)
 * and the belt (P3-03), so an angle means the same everywhere: the Sun (or the parent planet) at
 * the origin, y up, angle 0 on +x, angles growing **counter-clockwise seen from above** (+y), so
 * angle π/2 is on −z (the far side from the default camera on +z). `inclination` lifts the point
 * out of the plane (+y for a positive one) and keeps its distance from the centre.
 *
 * The belt's `phase` (the server's `drawBeltOrbit`, `packages/protocol`) is a uniform angle in
 * [0, 2π) with no handedness of its own; it is read with this convention. A positive
 * `rotation.y` of a group turns its children the same way (the belt's spin, the planets' motion).
 *
 * No three.js here (the placement takes anything with `position.set`).
 */
export type Vec3Tuple = [number, number, number];

/** The point at `distance`, `angle` and `inclination`, written into `out` (no allocation). */
export function orbitPoint(
  distance: number,
  angle: number,
  inclination = 0,
  out: Vec3Tuple = [0, 0, 0],
): Vec3Tuple {
  const flat = inclination === 0 ? distance : distance * Math.cos(inclination);
  out[0] = flat * Math.cos(angle);
  out[1] = inclination === 0 ? 0 : distance * Math.sin(inclination);
  out[2] = -flat * Math.sin(angle);
  return out;
}

const scratch: Vec3Tuple = [0, 0, 0];

/** Moves `object` to its orbit point; allocation-free, so it can run per body per frame. */
export function placeOnOrbit(
  object: { position: { set(x: number, y: number, z: number): unknown } },
  distance: number,
  angle: number,
  inclination = 0,
): void {
  orbitPoint(distance, angle, inclination, scratch);
  object.position.set(scratch[0], scratch[1], scratch[2]);
}
