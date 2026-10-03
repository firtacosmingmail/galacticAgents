import type { AgentRole, Id } from '@galactic/protocol';
import type { SatelliteQuality } from '../quality.js';
import type { Vec3Tuple } from '../orbit.js';
import {
  advance,
  createActor,
  sampleActor,
  TIMING,
  type SatelliteActor,
  type SatelliteInput,
  type SatelliteMode,
  type SatelliteView,
} from './machine.js';
import {
  orbitAngle,
  orbitOffset,
  orbitSlots,
  satelliteOrbit,
  type SatelliteOrbit,
} from './orbits.js';
import { BEAM, SATELLITE_LOOK, satelliteBrightness, satelliteTint } from './look.js';
import type { SatelliteSpec } from './satellite-model.js';
import { publishSatellites } from './registry.js';

/**
 * The satellites' frame logic (P4-01), without three.js so it is tested without WebGL: it owns one
 * actor (`machine.ts`) and one orbit (`orbits.ts`) per satellite, and on every frame turns them,
 * the anchors' live positions and the clock into one `SatelliteFrame` each — where to draw the
 * satellite, how big, which way its beam points and how bright it is. The renderers
 * (`Satellites.tsx`: a mesh pair per satellite, or two instanced meshes) only copy frames into
 * matrices.
 *
 * - **Bodies** are read through a lookup (the anchor registry in the scene, a fake in tests); a
 *   satellite whose body has no anchor (not drawn yet) is hidden, not dropped.
 * - **Time** is the scene's motion clock (`motionSeconds`): orbits and flights keep their place
 *   across frame-loop changes, and a flight is over by the first frame after its end, whether or
 *   not frames were drawn meanwhile (corner case 26).
 * - **Reduced motion**: orbits stand still at their seeded phase, nothing scans, flights and
 *   landings are instant (the machine's `reducedMotion`).
 * - **The animation cap** (`maxAnimated`, corner case 21): flights and landings always animate;
 *   the remaining budget goes to scans and activity archetypes, Waykeepers before Stewards, by
 *   agent id (the focused body's satellites first, when one is given). A satellite past the
 *   budget orbits without its beam or archetype.
 */
export interface SatelliteFrame {
  agentId: Id;
  role: AgentRole;
  /** The body it belongs to (a flight's destination). */
  bodyId: Id;
  mode: SatelliteMode;
  view: SatelliteView;
  /** False while its body has no anchor. */
  visible: boolean;
  /** World position. */
  position: Vec3Tuple;
  /** The point it faces and its beam aims at: its body's centre (a flight's destination). */
  target: Vec3Tuple;
  /** Its body's visual radius (scene units). */
  bodyRadius: number;
  /** Its span, scene units. */
  size: number;
  /** Beam strength 0 → 1, after the cap. */
  beam: number;
  /** The beam's swing across the surface (radians). */
  sweep: number;
  /** Whether it is within the animation budget this frame. */
  animated: boolean;
  /** Colour (CSS) and its multiplier (`look.ts`). */
  tint: string;
  brightness: number;
}

/** A body's live centre (written into `out`) and visual radius; `undefined` = not drawn. */
export type AnchorLookup = (bodyId: Id, out: Vec3Tuple) => number | undefined;

/** World units per screen pixel at a point (from the camera); omitted in tests = no floor. */
export type PixelSize = (position: Vec3Tuple) => number;

export interface DirectorOptions {
  satellites: SatelliteQuality;
  reducedMotion: boolean;
}

/** How high (relative to the distance flown) a flight arcs above the straight line. */
export const FLIGHT_ARC = 0.18;
/** Where a landed satellite sits, in body radii. */
export const SURFACE = 1.03;

/** Whether `count` satellites take the instanced path. */
export function instancedPath(count: number, quality: SatelliteQuality): boolean {
  return count > quality.instanceAbove;
}

const ALWAYS_ANIMATED: ReadonlySet<SatelliteMode> = new Set(['flying', 'landing']);
const OPTIONAL_ANIMATED: ReadonlySet<SatelliteMode> = new Set([
  'scanning',
  'gathering',
  'transporting',
  'building',
]);

/**
 * The animation budget (pure, in place): sets `animated` on every frame. Flights and landings
 * always; then scans and archetypes in order — the focused body's, Waykeepers', then Stewards'
 * (frames are in agent-id order) — until `cap` is reached.
 */
export function applyAnimationCap(
  frames: readonly Pick<SatelliteFrame, 'mode' | 'role' | 'bodyId' | 'animated'>[],
  cap: number,
  focusBodyId?: Id,
): number {
  let used = 0;
  for (const f of frames) {
    f.animated = ALWAYS_ANIMATED.has(f.mode);
    if (f.animated) used++;
  }
  const passes: ((f: Pick<SatelliteFrame, 'role' | 'bodyId'>) => boolean)[] = [
    (f) => focusBodyId !== undefined && f.bodyId === focusBodyId,
    (f) => f.role !== 'steward',
    () => true,
  ];
  for (const wants of passes) {
    for (const f of frames) {
      if (used >= cap) return used;
      if (f.animated || !OPTIONAL_ANIMATED.has(f.mode) || !wants(f)) continue;
      f.animated = true;
      used++;
    }
  }
  return used;
}

interface Entry {
  spec: SatelliteSpec;
  input: SatelliteInput;
  actor: SatelliteActor;
  orbit: SatelliteOrbit;
  frame: SatelliteFrame;
  /** Where the current flight started (captured on its first frame), by flight start time. */
  flightFrom?: { start: number; point: Vec3Tuple } | undefined;
}

const scratch: Vec3Tuple = [0, 0, 0];
const scratchCentre: Vec3Tuple = [0, 0, 0];

export class SatelliteDirector {
  private entries = new Map<Id, Entry>();
  private ordered: Entry[] = [];
  private options: DirectorOptions;
  /** The frames in agent-id order (the renderers' and the cap's order). */
  frames: SatelliteFrame[] = [];

  constructor(options: DirectorOptions) {
    this.options = options;
  }

  setOptions(options: DirectorOptions): void {
    this.options = options;
  }

  /**
   * The world's satellites changed: new agents get an actor (orbiting their body, no flight in
   * from anywhere), ended ones are dropped, the others keep their actor and get the new input — a
   * new body makes the next `update` start a flight.
   */
  setSpecs(specs: readonly SatelliteSpec[], now: number): void {
    const slots = orbitSlots(specs);
    const next = new Map<Id, Entry>();
    for (const spec of specs) {
      const input: SatelliteInput = {
        bodyId: spec.bodyId,
        state: spec.state,
        archetype: spec.archetype,
        landed: spec.landed,
      };
      const orbit = satelliteOrbit(spec.agentId, spec.role, slots.get(spec.agentId) ?? 0);
      const known = this.entries.get(spec.agentId);
      if (known) {
        known.spec = spec;
        known.input = input;
        // Taken now, not at the next drawn frame: a flight or landing starts when the world
        // changed, so it ends on time even if no frame is drawn meanwhile.
        known.actor = advance(known.actor, input, now, {
          reducedMotion: this.options.reducedMotion,
        });
        known.orbit = orbit;
        known.frame.role = spec.role;
        next.set(spec.agentId, known);
        continue;
      }
      const actor = createActor(spec.agentId, input, now);
      next.set(spec.agentId, {
        spec,
        input,
        actor,
        orbit,
        frame: {
          agentId: spec.agentId,
          role: spec.role,
          bodyId: spec.bodyId,
          mode: actor.mode,
          view: sampleActor(actor, now),
          visible: false,
          position: [0, 0, 0],
          target: [0, 0, 0],
          bodyRadius: 1,
          size: 0,
          beam: 0,
          sweep: 0,
          animated: false,
          tint: satelliteTint(spec),
          brightness: 1,
        },
      });
    }
    const changed =
      next.size !== this.entries.size || [...next.keys()].some((id) => !this.entries.has(id));
    this.entries = next;
    this.ordered = [...next.values()];
    this.frames = this.ordered.map((e) => e.frame);
    if (changed) publishSatellites(new Map(this.ordered.map((e) => [e.spec.agentId, e.frame])));
  }

  /** The actor of an agent (tests, the debug harness of P4-06). */
  actor(agentId: Id): SatelliteActor | undefined {
    return this.entries.get(agentId)?.actor;
  }

  /**
   * Advances every actor to `now` and rewrites every frame. `focusBodyId` is the body the camera
   * is on: its satellites get the animation budget first.
   */
  update(
    now: number,
    anchors: AnchorLookup,
    pixelSize?: PixelSize,
    focusBodyId?: Id,
  ): SatelliteFrame[] {
    const reduced = this.options.reducedMotion;
    const t = reduced ? 0 : now;
    for (const e of this.ordered) {
      e.actor = advance(e.actor, e.input, now, { reducedMotion: reduced });
      const view = sampleActor(e.actor, now);
      const f = e.frame;
      f.mode = e.actor.mode;
      f.bodyId = e.actor.bodyId;
      f.view = view;
      f.tint = satelliteTint(e.spec);
      f.brightness = satelliteBrightness(e.spec, view, now);
      const radius = anchors(e.actor.bodyId, scratchCentre);
      if (radius === undefined) {
        f.visible = false;
        f.beam = 0;
        e.flightFrom = undefined;
        continue;
      }
      f.bodyRadius = radius;
      f.target[0] = scratchCentre[0];
      f.target[1] = scratchCentre[1];
      f.target[2] = scratchCentre[2];
      const orbit = e.orbit;

      if (e.actor.mode === 'flying' && e.actor.flight && view.flight !== undefined) {
        this.placeFlight(e, f, t, view.flight, anchors);
      } else if (e.actor.mode === 'landing' || e.actor.mode === 'landed') {
        e.flightFrom = undefined;
        const angle = orbitAngle(orbit, reduced ? 0 : e.actor.tween.start);
        const r = (orbit.radius + (SURFACE - orbit.radius) * view.landing) * radius;
        orbitOffset(orbit, angle, r, scratch);
        this.place(f, scratch);
      } else {
        e.flightFrom = undefined;
        orbitOffset(orbit, orbitAngle(orbit, t), orbit.radius * radius, scratch);
        this.place(f, scratch);
      }
      f.visible = true;

      const look = SATELLITE_LOOK[e.spec.role];
      let size = look.size * radius;
      if (pixelSize) size = Math.max(size, look.minPx * pixelSize(f.position));
      f.size = Math.min(size, look.maxSize * radius);
      f.beam = view.beam;
      const scan = e.actor.scan;
      f.sweep =
        scan && !reduced
          ? BEAM.sweep * Math.sin((2 * Math.PI * (now - scan.start)) / TIMING.scan)
          : 0;
    }
    applyAnimationCap(this.frames, this.options.satellites.maxAnimated, focusBodyId);
    for (const f of this.frames) if (!f.animated || !f.visible) f.beam = 0;
    return this.frames;
  }

  private place(f: SatelliteFrame, offset: Vec3Tuple): void {
    f.position[0] = f.target[0] + offset[0];
    f.position[1] = f.target[1] + offset[1];
    f.position[2] = f.target[2] + offset[2];
  }

  /**
   * A flight: from where the satellite was when it took off (captured on the flight's first
   * frame: its last drawn position, else its old orbit, else the destination) to its place on the
   * destination's orbit, which moves with the body, along an arc lifted toward +y.
   */
  private placeFlight(
    e: Entry,
    f: SatelliteFrame,
    t: number,
    p: number,
    anchors: AnchorLookup,
  ): void {
    const flight = e.actor.flight;
    if (!flight) return;
    const orbit = e.orbit;
    orbitOffset(orbit, orbitAngle(orbit, t), orbit.radius * f.bodyRadius, scratch);
    const dx = f.target[0] + scratch[0];
    const dy = f.target[1] + scratch[1];
    const dz = f.target[2] + scratch[2];
    if (!e.flightFrom || e.flightFrom.start !== flight.start) {
      let point: Vec3Tuple;
      if (f.visible) point = [f.position[0], f.position[1], f.position[2]];
      else {
        const centre: Vec3Tuple = [0, 0, 0];
        const r = anchors(flight.fromBodyId, centre);
        if (r === undefined) point = [dx, dy, dz];
        else {
          orbitOffset(orbit, orbitAngle(orbit, t), orbit.radius * r, scratch);
          point = [centre[0] + scratch[0], centre[1] + scratch[1], centre[2] + scratch[2]];
        }
      }
      e.flightFrom = { start: flight.start, point };
    }
    const [sx, sy, sz] = e.flightFrom.point;
    const distance = Math.hypot(dx - sx, dy - sy, dz - sz);
    const lift = FLIGHT_ARC * distance * Math.sin(Math.PI * p);
    f.position[0] = sx + (dx - sx) * p;
    f.position[1] = sy + (dy - sy) * p + lift;
    f.position[2] = sz + (dz - sz) * p;
  }
}
