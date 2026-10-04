import { describe, expect, it } from 'vitest';
import {
  BODY_KEEP_OUT,
  CameraDirector,
  follow,
  keepOutOfBody,
  SUN_KEEP_OUT,
  type BodyView,
  type DirectorWorld,
} from './director.js';
import {
  distance,
  dot,
  framingDistance,
  length,
  normalize,
  overviewPose,
  sub,
  type Pose,
  type Vec3,
  type View,
} from './flight.js';

const VIEW: View = { fovDeg: 45, aspect: 16 / 9 };
const SUN = 6;

function world(bodies: Record<string, BodyView>): DirectorWorld {
  const extent = Math.max(0, ...Object.values(bodies).map((b) => length(b.position) + b.radius));
  return { sunRadius: SUN, extent, body: (id) => bodies[id] };
}

const START: Pose = { position: [0, 40, 140], target: [0, 0, 0] };

/** Steps until the flight ends (at most 3 s at 60 fps); returns the poses and events. */
function fly(d: CameraDirector, w: DirectorWorld, from: Pose, t0: number) {
  let pose = from;
  const events: string[] = [];
  let t = t0;
  for (let i = 0; i < 180; i++) {
    t += 1 / 60;
    const r = d.step(pose, VIEW, w, t);
    pose = r.pose;
    if (r.event) events.push(r.event);
    if (!r.animating) break;
  }
  return { pose, events, t };
}

describe('CameraDirector', () => {
  it('flies to a body and frames it by its radius', () => {
    const d = new CameraDirector();
    const w = world({ mars: { position: [50, 0, 0], radius: 2 } });
    expect(d.focus('mars', START, VIEW, w, 0, false)).toBe(true);
    expect(d.state).toBe('flying');
    expect(d.bodyId).toBe('mars');
    const first = d.step(START, VIEW, w, 0.1);
    expect(first.animating).toBe(true);
    const { pose, events } = fly(d, w, first.pose, 0.1);
    expect(events).toEqual(['arrived']);
    expect(d.state).toBe('following');
    expect(pose.target).toEqual([50, 0, 0]);
    expect(distance(pose.position, pose.target)).toBeCloseTo(framingDistance(2, VIEW));
  });

  it('ignores an unknown body', () => {
    const d = new CameraDirector();
    expect(d.focus('nowhere', START, VIEW, world({}), 0, false)).toBe(false);
    expect(d.state).toBe('free');
  });

  it('jumps at once with reduced motion', () => {
    const d = new CameraDirector();
    const w = world({ mars: { position: [50, 0, 0], radius: 2 } });
    d.focus('mars', START, VIEW, w, 5, true);
    const r = d.step(START, VIEW, w, 5);
    expect(r.event).toBe('arrived');
    expect(r.animating).toBe(false);
    expect(r.pose.target).toEqual([50, 0, 0]);
  });

  it('meets a moving body where it is, then follows it and turns with its orbit', () => {
    const d = new CameraDirector();
    const bodies: Record<string, BodyView> = { mars: { position: [50, 0, 0], radius: 2 } };
    const w = world(bodies);
    d.focus('mars', START, VIEW, w, 0, false);
    bodies['mars'] = { position: [0, 0, 50], radius: 2 };
    const { pose } = fly(d, w, START, 0);
    expect(pose.target).toEqual([0, 0, 50]);
    const outward = dot(normalize(sub(pose.position, pose.target)), [0, 0, 1]);
    // A quarter orbit later the camera has turned with the body: same outward lean.
    bodies['mars'] = { position: [50, 0, 0], radius: 2 };
    const r = d.step(pose, VIEW, w, 10);
    expect(r.pose.target[0]).toBeCloseTo(50);
    expect(r.pose.target[2]).toBeCloseTo(0);
    expect(dot(normalize(sub(r.pose.position, r.pose.target)), [1, 0, 0])).toBeCloseTo(outward);
    expect(distance(r.pose.position, r.pose.target)).toBeCloseTo(
      distance(pose.position, pose.target),
    );
  });

  it('keeps the focus while the user orbits or zooms, and lets go when they pan away', () => {
    const d = new CameraDirector();
    const w = world({ mars: { position: [50, 0, 0], radius: 2 } });
    d.focus('mars', START, VIEW, w, 0, true);
    let pose = d.step(START, VIEW, w, 0).pose;
    // Zoom: the camera moves, the target stays.
    pose = { ...pose, position: [70, 10, 0] };
    expect(d.step(pose, VIEW, w, 1).event).toBeUndefined();
    expect(d.state).toBe('following');
    // Pan: the target slides off the body.
    pose = { position: [70, 10, 2], target: [50, 0, 2] };
    expect(d.step(pose, VIEW, w, 1.5).event).toBeUndefined(); // still on the body
    pose = { position: [70, 10, 4], target: [50, 0, 4] };
    expect(d.step(pose, VIEW, w, 2).event).toBe('left');
    expect(d.state).toBe('free');
  });

  it('a user grab stops a flight where it is', () => {
    const d = new CameraDirector();
    const w = world({ mars: { position: [50, 0, 0], radius: 2 } });
    d.focus('mars', START, VIEW, w, 0, false);
    const mid = d.step(START, VIEW, w, 0.3).pose;
    expect(d.interrupt()).toBe(true);
    expect(d.state).toBe('free');
    expect(d.step(mid, VIEW, w, 0.4).pose).toEqual(mid);
    expect(d.interrupt()).toBe(false);
  });

  it('drops the focus when the body leaves the scene', () => {
    const d = new CameraDirector();
    const bodies: Record<string, BodyView> = { a: { position: [50, 0, 0], radius: 1 } };
    const w = world(bodies);
    d.focus('a', START, VIEW, w, 0, true);
    d.step(START, VIEW, w, 0);
    delete bodies['a'];
    expect(d.step(START, VIEW, w, 1).event).toBe('lost');
    expect(d.state).toBe('free');
  });

  it('flies back to the overview from any state, and goes around the Sun', () => {
    const d = new CameraDirector();
    const w = world({ neptune: { position: [-240, 0, 0], radius: 4 } });
    const behind: Pose = { position: [-300, 0, 0], target: [-240, 0, 0] };
    d.overview(behind, VIEW, w, 0, false);
    let pose = behind;
    let minFromSun = Infinity;
    let event: string | undefined;
    for (let t = 1 / 60; t < 3; t += 1 / 60) {
      const r = d.step(pose, VIEW, w, t);
      pose = r.pose;
      minFromSun = Math.min(minFromSun, length(pose.position));
      if (r.event) event = r.event;
      if (!r.animating) break;
    }
    expect(event).toBe('overview');
    expect(pose).toEqual(overviewPose(w.extent, VIEW));
    expect(minFromSun).toBeGreaterThan(SUN * 2 - 1e-9);
    expect(d.state).toBe('free');
  });

  it('never lets the camera inside the Sun', () => {
    const d = new CameraDirector();
    const w = world({});
    const r = d.step({ position: [1, 0, 0], target: [0, 0, 0] }, VIEW, w, 0);
    expect(length(r.pose.position)).toBeCloseTo(SUN * SUN_KEEP_OUT);
  });

  it('every body is reachable and framed in front of the Sun, from any camera (corner case 26)', () => {
    const bodies: Record<string, BodyView> = {
      mercury: { position: [20, 0, 0], radius: 0.8 },
      jupiter: { position: [0, 0, -120], radius: 5 },
      rock: { position: [-80, 1, 30], radius: 0.05 },
      moon: { position: [26, 0.5, 0], radius: 0.3 },
      sun: { position: [0, 0, 0], radius: SUN },
    };
    const w = world(bodies);
    const cameras: Pose[] = [
      START,
      { position: [-400, 0, 0], target: [0, 0, 0] },
      { position: [0, -300, 1], target: [0, 0, 0] },
      { position: [10, 0, 0], target: [20, 0, 0] },
    ];
    for (const from of cameras) {
      for (const id of Object.keys(bodies)) {
        const d = new CameraDirector();
        expect(d.focus(id, from, VIEW, w, 0, false)).toBe(true);
        const { pose, events } = fly(d, w, from, 0);
        expect(events).toEqual(['arrived']);
        const body = bodies[id]!;
        expect(pose.target).toEqual(body.position);
        if (id !== 'sun') {
          // The Sun is not between the camera and the body.
          const toBody = sub(body.position, pose.position);
          const t = Math.min(1, Math.max(0, -dot(pose.position, toBody) / dot(toBody, toBody)));
          const closest: Vec3 = [
            pose.position[0] + toBody[0] * t,
            pose.position[1] + toBody[1] * t,
            pose.position[2] + toBody[2] * t,
          ];
          expect(length(closest)).toBeGreaterThan(SUN);
        }
        // The zoom limits allow the framing distance.
        const limits = d.limits(pose, VIEW, w);
        expect(limits.minDistance).toBeLessThanOrEqual(distance(pose.position, pose.target));
        expect(limits.minDistance).toBeGreaterThan(body.radius);
        expect(limits.maxDistance).toBeGreaterThan(distance(pose.position, pose.target));
      }
    }
  });
});

describe('keeping out of the held body (P6-01 review, S3)', () => {
  it('moves the camera straight out from the centre to the minimum, keeping the target', () => {
    const pose: Pose = { position: [10.5, 0, 0], target: [14, 3, 0] };
    const kept = keepOutOfBody(pose, [10, 0, 0], 1.3);
    expect(kept.position[0]).toBeCloseTo(11.3);
    expect(kept.position[1]).toBeCloseTo(0);
    expect(kept.target).toEqual(pose.target);
    // Far enough: the same pose object.
    const far: Pose = { position: [20, 0, 0], target: [10, 0, 0] };
    expect(keepOutOfBody(far, [10, 0, 0], 1.3)).toBe(far);
    // At the very centre: out along the view's axis, away from the target.
    const centre = keepOutOfBody({ position: [10, 0, 0], target: [10, 0, -5] }, [10, 0, 0], 2);
    expect(centre.position).toEqual([10, 0, 2]);
  });

  it('after a pan off the detail body, zooming toward it stops at BODY_KEEP_OUT radii', () => {
    const d = new CameraDirector(); // free: the pan released the focus
    const w = world({ jupiter: { position: [100, 0, 0], radius: 4 } });
    // The target was panned off the body; the camera dollied in toward it, ending inside the body.
    const pose: Pose = { position: [101, 0.5, 1], target: [100, 0, -30] };
    const r = d.step(pose, VIEW, w, 0, 'jupiter');
    expect(distance(r.pose.position, [100, 0, 0])).toBeCloseTo(4 * BODY_KEEP_OUT);
    expect(r.pose.target).toEqual(pose.target);
    // No held body: the camera is left where the user put it (outside the Sun).
    expect(d.step(pose, VIEW, w, 0).pose).toBe(pose);
    // A flight owns the camera: no clamp while it runs.
    d.focus('jupiter', START, VIEW, w, 0, false);
    const mid = d.step(START, VIEW, w, 0.01, 'jupiter');
    expect(mid.animating).toBe(true);
  });
});

describe('follow', () => {
  it('only translates around the Sun itself', () => {
    const pose: Pose = { position: [0, 5, 20], target: [0, 0, 0] };
    expect(follow(pose, [0, 0, 0], [1, 0, 0], SUN)).toEqual({
      position: [1, 5, 20],
      target: [1, 0, 0],
    });
  });
});
