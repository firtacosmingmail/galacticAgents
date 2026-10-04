import {
  add,
  approachDirection,
  azimuth,
  distance,
  flightDuration,
  flightPose,
  focusDistance,
  focusPose,
  framingDistance,
  leaveDistance,
  length,
  overviewPose,
  pushOutside,
  rotateY,
  sub,
  type Pose,
  type Vec3,
  type View,
} from './flight.js';

/** A body as the camera sees it this frame: its world position and its visual radius. */
export interface BodyView {
  position: Vec3;
  radius: number;
}

/** What the director reads from the scene each frame (the anchor registry, in the rig). */
export interface DirectorWorld {
  body(bodyId: string): BodyView | undefined;
  sunRadius: number;
  /** The farthest body's distance from the Sun plus its radius (0 when nothing is registered). */
  extent: number;
}

/** What happened during a step, for the store. */
export type DirectorEvent = 'arrived' | 'overview' | 'left' | 'lost';

export interface StepResult {
  pose: Pose;
  /** True while a flight runs: the frame loop must keep rendering (`invalidate()`). */
  animating: boolean;
  event?: DirectorEvent;
}

/** `radii`: the flight ends that many body radii from the centre (else the framing distance). */
type Goal = { kind: 'focus'; bodyId: string; dir: Vec3; radii?: number } | { kind: 'overview' };

type Mode =
  | { kind: 'free' }
  | { kind: 'flying'; goal: Goal; start: Pose; startedAt: number; duration: number }
  | { kind: 'following'; bodyId: string; last: Vec3 };

/** The camera never comes closer than this many Sun radii to the Sun's centre. */
export const SUN_KEEP_OUT = 1.3;
/** A flight path keeps this many Sun radii from the Sun's centre (it goes around, not through). */
export const SUN_FLIGHT_CLEARANCE = 2;

/**
 * The camera's behaviour, without three.js (P3-04): free (OrbitControls alone), flying to a body
 * or to the overview (eased, the goal recomputed every frame from the live anchor, so a moving
 * body is met where it is), and following a focused body (the camera and its target move with
 * the body and turn with its orbit, so the view the user chose is kept and the Sun stays behind
 * the camera). The rig (`CameraRig`) feeds it the camera's pose and the anchors each frame and
 * writes the pose back.
 *
 * Times are in seconds.
 */
export class CameraDirector {
  private mode: Mode = { kind: 'free' };

  get state(): Mode['kind'] {
    return this.mode.kind;
  }

  /** The focused body (following, or flying to it), else undefined. */
  get bodyId(): string | undefined {
    if (this.mode.kind === 'following') return this.mode.bodyId;
    if (this.mode.kind === 'flying' && this.mode.goal.kind === 'focus')
      return this.mode.goal.bodyId;
    return undefined;
  }

  /**
   * Starts a flight that frames `bodyId` (at `radii` body radii when given: the detail view, P6-01);
   * false (and nothing changes) when it is not in the scene.
   */
  focus(
    bodyId: string,
    pose: Pose,
    view: View,
    world: DirectorWorld,
    now: number,
    reducedMotion: boolean,
    radii?: number,
  ): boolean {
    const body = world.body(bodyId);
    if (!body) return false;
    const dir = approachDirection(
      body.position,
      pose.position,
      world.sunRadius,
      focusDistance(body.radius, view, radii),
    );
    const goal = focusPose(body.position, body.radius, dir, view, radii);
    this.mode = {
      kind: 'flying',
      goal:
        radii === undefined
          ? { kind: 'focus', bodyId, dir }
          : { kind: 'focus', bodyId, dir, radii },
      start: pose,
      startedAt: now,
      duration: flightDuration(pose, goal, reducedMotion),
    };
    return true;
  }

  /** Starts a flight back to the whole system, from any state. */
  overview(pose: Pose, view: View, world: DirectorWorld, now: number, reducedMotion: boolean) {
    this.mode = {
      kind: 'flying',
      goal: { kind: 'overview' },
      start: pose,
      startedAt: now,
      duration: flightDuration(pose, overviewPose(world.extent, view), reducedMotion),
    };
  }

  /** The user grabbed the controls: a flight stops where it is (true if one was running). */
  interrupt(): boolean {
    if (this.mode.kind !== 'flying') return false;
    this.mode = { kind: 'free' };
    return true;
  }

  /** Stops following or flying without moving the camera. */
  release() {
    this.mode = { kind: 'free' };
  }

  /** One frame: the pose to apply (the user's pose, adjusted) and what happened. */
  step(pose: Pose, view: View, world: DirectorWorld, now: number): StepResult {
    const keepOut = world.sunRadius * SUN_KEEP_OUT;
    const mode = this.mode;
    if (mode.kind === 'flying') {
      const goal = this.goalPose(mode.goal, view, world);
      if (!goal) {
        this.mode = { kind: 'free' };
        return { pose: keepOutOfSun(pose, keepOut), animating: false, event: 'lost' };
      }
      const t = mode.duration <= 0 ? 1 : (now - mode.startedAt) / mode.duration;
      if (t >= 1) {
        if (mode.goal.kind === 'focus') {
          this.mode = { kind: 'following', bodyId: mode.goal.bodyId, last: goal.target };
          return { pose: keepOutOfSun(goal, keepOut), animating: false, event: 'arrived' };
        }
        this.mode = { kind: 'free' };
        return { pose: keepOutOfSun(goal, keepOut), animating: false, event: 'overview' };
      }
      const clearance = world.sunRadius * SUN_FLIGHT_CLEARANCE;
      return { pose: flightPose(mode.start, goal, t, clearance), animating: true };
    }
    if (mode.kind === 'following') {
      const body = world.body(mode.bodyId);
      if (!body) {
        this.mode = { kind: 'free' };
        return { pose: keepOutOfSun(pose, keepOut), animating: false, event: 'lost' };
      }
      if (distance(pose.target, mode.last) > leaveDistance(body.radius)) {
        // The user panned away from the body: the camera is theirs again.
        this.mode = { kind: 'free' };
        return { pose: keepOutOfSun(pose, keepOut), animating: false, event: 'left' };
      }
      const followed = follow(pose, mode.last, body.position, world.sunRadius);
      mode.last = body.position;
      return { pose: keepOutOfSun(followed, keepOut), animating: false };
    }
    return { pose: keepOutOfSun(pose, keepOut), animating: false };
  }

  /**
   * OrbitControls' zoom limits for this frame. `holdId`: a body whose limits apply while the
   * camera has no focus (P6-01: the detail view's body, after the user panned off it), so zooming
   * never goes inside it.
   */
  limits(
    pose: Pose,
    view: View,
    world: DirectorWorld,
    holdId?: string,
  ): { minDistance: number; maxDistance: number } {
    const maxDistance = Math.max(length(overviewPose(world.extent, view).position) * 1.6, 200);
    const id = this.bodyId ?? holdId;
    const body = id ? world.body(id) : undefined;
    if (body) {
      // Close enough to fill the view with a tiny asteroid, never inside the body.
      return {
        minDistance: Math.min(body.radius * 1.3, framingDistance(body.radius, view) * 0.5),
        maxDistance,
      };
    }
    // Around the Sun, stop outside it; elsewhere the Sun keep-out does the job.
    const nearSun = length(pose.target) < world.sunRadius;
    return { minDistance: nearSun ? world.sunRadius * SUN_KEEP_OUT : 0.2, maxDistance };
  }

  private goalPose(goal: Goal, view: View, world: DirectorWorld): Pose | undefined {
    if (goal.kind === 'overview') return overviewPose(world.extent, view);
    const body = world.body(goal.bodyId);
    return body ? focusPose(body.position, body.radius, goal.dir, view, goal.radii) : undefined;
  }
}

/**
 * Moves the camera with a body from `from` to `to`: the target is shifted by the body's motion and
 * the camera's offset from it turns with the body's orbit about the Sun, so whatever view the
 * user chose (and its outward lean, corner case 26) is kept while the body goes around.
 */
export function follow(pose: Pose, from: Vec3, to: Vec3, sunRadius: number): Pose {
  const offset = sub(pose.position, pose.target);
  const shift = sub(to, from);
  const target = add(pose.target, shift);
  const orbiting = length(from) > sunRadius && length(to) > sunRadius;
  const turned = orbiting ? rotateY(offset, azimuth(to) - azimuth(from)) : offset;
  return { target, position: add(target, turned) };
}

function keepOutOfSun(pose: Pose, keepOut: number): Pose {
  const position = pushOutside(pose.position, keepOut);
  return position === pose.position ? pose : { ...pose, position };
}
