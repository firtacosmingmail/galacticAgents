/**
 * The camera's flight maths (P3-04), on plain `[x, y, z]` tuples: no three.js, so the camera
 * store and the tests stay out of the scene chunk. The Sun sits at the origin; the orbital plane
 * is XZ and +Y is "up".
 */
export type Vec3 = readonly [number, number, number];

/** Where the camera is and what it looks at (OrbitControls' target). */
export interface Pose {
  position: Vec3;
  target: Vec3;
}

/** The perspective camera's vertical field of view and its aspect ratio. */
export interface View {
  fovDeg: number;
  aspect: number;
}

export const UP: Vec3 = [0, 1, 0];

/** The Sun's radius when no `star` anchor is registered (the scene's Sun sphere, `SUN_RADIUS`). */
export const DEFAULT_SUN_RADIUS = 6;

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b));
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => add(a, scale(sub(b, a), t));

/** The unit vector along `a`, or `fallback` when `a` is (nearly) zero. */
export function normalize(a: Vec3, fallback: Vec3 = UP): Vec3 {
  const l = length(a);
  return l < 1e-9 ? fallback : scale(a, 1 / l);
}

/** Rotates `a` about the +Y axis by `angle` radians (counter-clockwise seen from above). */
export function rotateY(a: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [a[0] * c + a[2] * s, a[1], -a[0] * s + a[2] * c];
}

/** The azimuth of `a` about +Y, matching `rotateY` (rotating by the difference maps one onto the other). */
export function azimuth(a: Vec3): number {
  return Math.atan2(a[0], a[2]);
}

/** Smooth start and stop; `t` is clamped to [0, 1]. */
export function easeInOutCubic(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

/** Half of the narrower field of view (vertical, or horizontal on a portrait viewport), radians. */
export function halfFov(view: View): number {
  const v = (view.fovDeg * Math.PI) / 360;
  const h = Math.atan(Math.tan(v) * Math.max(view.aspect, 1e-3));
  return Math.min(v, h);
}

/** How much of the narrower half field of view a focused body fills (its angular radius). */
export const FOCUS_FILL = 0.3;
/** The smallest radius the camera frames (a tiny asteroid still gets a sensible distance). */
export const MIN_FRAMED_RADIUS = 0.05;

/**
 * The radius the camera frames a body by: its visual radius, never below `MIN_FRAMED_RADIUS`. The
 * one unit of every camera distance measured in body radii (the framing, a detail flight's
 * `radii`, P6-01's zoom thresholds and backdrop), so a flight that lands at N radii is N radii
 * away for every reader, however tiny the body (true scale's moons).
 */
export function framedRadius(radius: number): number {
  return Math.max(radius, MIN_FRAMED_RADIUS);
}

/**
 * The distance from a body's centre at which a sphere of `radius` fills `fill` of the narrower half
 * field of view: `sin(angular radius) = radius / distance`. Never closer than 1.5 radii.
 */
export function framingDistance(radius: number, view: View, fill = FOCUS_FILL): number {
  const r = framedRadius(radius);
  return Math.max(r / Math.sin(halfFov(view) * fill), r * 1.5);
}

/**
 * When the current direction is blocked, the approach turns until it points at least this much
 * away from the Sun (the cosine with the Sun→body direction): with any outward component, the
 * segment from the camera to the body stays farther from the Sun than the body itself.
 */
export const MIN_OUTWARD = 0.3;
/** The line of sight from the camera to a focused body keeps this many Sun radii from its centre. */
export const SIGHT_CLEARANCE = 1.5;

/** The closest distance from the origin (the Sun) to the segment `a`–`b`. */
export function segmentClearance(a: Vec3, b: Vec3): number {
  const ab = sub(b, a);
  const ll = dot(ab, ab);
  const t = ll < 1e-12 ? 0 : Math.min(1, Math.max(0, -dot(a, ab) / ll));
  return length(add(a, scale(ab, t)));
}

/**
 * The unit direction from a body to the camera that frames it from `distance` (corner case 26).
 * It keeps the current viewing direction (so the flight feels continuous, and from the overview
 * the body is seen lit) whenever the line of sight from there clears the Sun; otherwise it turns
 * just enough to put the camera `MIN_OUTWARD` on the far side of the body from the Sun, keeping
 * the sideways part of the current direction. The Sun itself (a body inside `sunRadius`) is
 * approached from wherever the camera is.
 */
export function approachDirection(
  body: Vec3,
  camera: Vec3,
  sunRadius: number,
  distance: number,
): Vec3 {
  const view = normalize(sub(camera, body), normalize([0, 0.3, 1]));
  if (length(body) <= sunRadius) return view;
  const eye = add(body, scale(view, distance));
  if (segmentClearance(eye, body) >= sunRadius * SIGHT_CLEARANCE) return view;
  const out = normalize(body);
  const along = dot(view, out);
  if (along >= MIN_OUTWARD) return view;
  // No sideways part (looking straight across the Sun): lean up out of the orbital plane.
  const side = sub(view, scale(out, along));
  const sideways = normalize(side, normalize(sub(UP, scale(out, dot(UP, out))), [1, 0, 0]));
  return normalize(
    add(scale(out, MIN_OUTWARD), scale(sideways, Math.sqrt(1 - MIN_OUTWARD * MIN_OUTWARD))),
  );
}

/**
 * The pose that frames a body: looking at its centre from `dir` at its framing distance, or at
 * `radii` body radii when given (P6-01: the detail view comes closer than the system framing).
 */
export function focusPose(body: Vec3, radius: number, dir: Vec3, view: View, radii?: number): Pose {
  return { target: body, position: add(body, scale(dir, focusDistance(radius, view, radii))) };
}

/**
 * How far from a body's centre a focus flight ends: `radii` framed radii (`framedRadius`), else
 * the framing distance.
 */
export function focusDistance(radius: number, view: View, radii?: number): number {
  return radii === undefined ? framingDistance(radius, view) : framedRadius(radius) * radii;
}

/** The overview looks down at the orbital plane at this slope (the initial camera's, 40 over 140). */
export const OVERVIEW_DIRECTION: Vec3 = normalize([0, 40, 140]);
/** The overview's distance when nothing is registered yet: the initial camera, (0, 40, 140). */
export const DEFAULT_OVERVIEW_DISTANCE = length([0, 40, 140]);

/**
 * The whole system: the Sun at the centre of the view, at a distance where a sphere of `extent`
 * (the farthest body's distance plus its radius) spans the narrower field of view.
 */
export function overviewPose(extent: number, view: View): Pose {
  const d =
    extent > 0
      ? Math.max(extent / Math.tan(halfFov(view)), DEFAULT_OVERVIEW_DISTANCE)
      : DEFAULT_OVERVIEW_DISTANCE;
  return { target: [0, 0, 0], position: scale(OVERVIEW_DIRECTION, d) };
}

export const MIN_FLIGHT_S = 0.8;
export const MAX_FLIGHT_S = 1.5;

/** Flight time in seconds: longer for longer trips, within 0.8–1.5 s; 0 for reduced motion. */
export function flightDuration(from: Pose, to: Pose, reducedMotion: boolean): number {
  if (reducedMotion) return 0;
  const travel = Math.max(distance(from.position, to.position), distance(from.target, to.target));
  const t = MIN_FLIGHT_S + (MAX_FLIGHT_S - MIN_FLIGHT_S) * Math.min(1, travel / 400);
  return Math.round(t * 1000) / 1000;
}

/** `point` moved radially out of the sphere of `radius` about the origin (unchanged outside it). */
export function pushOutside(point: Vec3, radius: number): Vec3 {
  const l = length(point);
  if (l >= radius) return point;
  return scale(normalize(point, UP), radius);
}

/**
 * The camera's pose `t` (0–1, eased here) along a flight from `start` to `goal`. Both points move
 * on straight lines, but the camera is kept outside `clearance` about the Sun, so a flight across
 * the system goes around the Sun instead of through it.
 */
export function flightPose(start: Pose, goal: Pose, t: number, clearance: number): Pose {
  const e = easeInOutCubic(t);
  return {
    position: pushOutside(lerp(start.position, goal.position, e), clearance),
    target: lerp(start.target, goal.target, e),
  };
}

/**
 * The user has left a focused body once a pan takes the target off it: farther from its centre
 * than its radius and a half.
 */
export function leaveDistance(radius: number): number {
  return framedRadius(radius) * 1.5;
}
