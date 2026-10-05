import type { AgentRole, Id } from '@galactic/protocol';
import type { SatelliteQuality } from '../quality.js';
import type { Vec3Tuple } from '../orbit.js';
import {
  advance,
  createActor,
  easeInOut,
  sampleActor,
  TIMING,
  type SatelliteActor,
  type SatelliteInput,
  type SatelliteMode,
  type SatelliteView,
} from './machine.js';
import {
  blendOrbit,
  ORBIT_TWEEN,
  orbitAngle,
  orbitOffset,
  orbitSlots,
  satelliteOrbit,
  type SatelliteOrbit,
  type SlotHolder,
} from './orbits.js';
import {
  BEAM,
  beamTint,
  SATELLITE_LOOK,
  satelliteBrightness,
  satelliteOrbitRate,
  satelliteScale,
  satelliteTint,
} from './look.js';
import type { SatelliteSpec } from './satellite-model.js';
import { publishSatellites } from './registry.js';
import { CLAIM_AT, placementFor } from './placement.js';

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
 *   the remaining budget goes to scans and activity archetypes — the focused body's satellites
 *   first (when one is given), then those that already had it (no pre-emption), then Waykeepers
 *   before Stewards, by agent id. A satellite past the budget orbits without its beam or
 *   archetype; a satellite whose body has no anchor takes no budget.
 * - **Orbits are sticky** (`orbitSlots`): a satellite keeps its slot while it lives on a body, so
 *   arrivals and departures never move the others; an orbit change that does happen (a role
 *   change) is blended over `ORBIT_TWEEN` from where the satellite is, not jumped.
 * - **Fades**: a satellite grows in when its agent starts and shrinks out when it ends
 *   (`PRESENCE` seconds of scale; the leaving satellite stays in `frames` until then); a beam cut
 *   short (the scan ended early, the budget went elsewhere) fades out over `BEAM_FADE_OUT`
 *   instead of popping. Reduced motion makes both instant.
 * - **State look** (P4-02, `look.ts`): each frame takes its agent's state's tint, pulsing
 *   brightness, size multiplier and beam colour; each satellite runs its own orbit clock at its
 *   state's `orbitRate` (a paused satellite holds still where it is, a failed one drifts; a rate
 *   change never makes it jump), held while it lands.
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
  /** 0 → 1: grows in when its agent starts, back to 0 when it ends (`size` includes it). */
  presence: number;
  /** Colour (CSS) and its multiplier (`look.ts`; P4-02: per agent state, pulsing). */
  tint: string;
  brightness: number;
  /** The beam's colour, linear RGB before its gain (`beamTint`). */
  beamTint: readonly [number, number, number];
  /**
   * P6-04: a view draws its own model at this frame (`placement.ts`: the detail view's Steward
   * robots and drones); the renderer draws neither the satellite nor its beam.
   */
  claimed?: boolean;
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
/** Seconds a satellite takes to grow in (agent started) or shrink out (agent ended). */
export const PRESENCE = 0.4;
/** Seconds a beam cut short takes to fade out (a scan's own end fade is slower, so never cut). */
export const BEAM_FADE_OUT = 0.3;
/**
 * A last drawn position older than this (seconds) is stale as a flight's origin — after a long
 * gap without frames (a hidden tab) the old body has moved on along its own orbit — so the flight
 * starts from the satellite's orbit around the old body's live anchor instead.
 */
export const STALE_ORIGIN = 2;

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

type CapFrame = Pick<SatelliteFrame, 'mode' | 'role' | 'bodyId' | 'animated'> & {
  visible?: boolean;
};

/** The budget's passes, in order (hoisted: no allocation per frame). */
const CAP_PASSES: readonly ((f: CapFrame, had: boolean, focus: Id | undefined) => boolean)[] = [
  (f, _had, focus) => focus !== undefined && f.bodyId === focus,
  (_f, had) => had,
  (f) => f.role !== 'steward',
  () => true,
];
let hadBudget = new Uint8Array(64);

/**
 * The animation budget (pure, in place): sets `animated` on every frame. Flights and landings
 * always; then scans and archetypes in order — the focused body's, those that were animated
 * before this call (a running scan keeps its budget), Waykeepers', then Stewards' (frames are in
 * agent-id order) — until `cap` is reached. A frame with `visible: false` (its body has no
 * anchor) is never animated and takes no budget.
 */
export function applyAnimationCap(
  frames: readonly CapFrame[],
  cap: number,
  focusBodyId?: Id,
): number {
  if (hadBudget.length < frames.length) hadBudget = new Uint8Array(frames.length * 2);
  let used = 0;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (!f) continue;
    hadBudget[i] = f.animated ? 1 : 0;
    f.animated = f.visible !== false && ALWAYS_ANIMATED.has(f.mode);
    if (f.animated) used++;
  }
  for (const wants of CAP_PASSES) {
    for (let i = 0; i < frames.length; i++) {
      if (used >= cap) return used;
      const f = frames[i];
      if (!f || f.animated || f.visible === false || !OPTIONAL_ANIMATED.has(f.mode)) continue;
      if (!wants(f, hadBudget[i] === 1, focusBodyId)) continue;
      f.animated = true;
      used++;
    }
  }
  return used;
}

interface Presence {
  from: number;
  to: number;
  start: number;
}

interface Entry {
  spec: SatelliteSpec;
  input: SatelliteInput;
  actor: SatelliteActor;
  /** The orbit it is going to (or on); `orbitKey` names it (role and slot). */
  orbit: SatelliteOrbit;
  orbitKey: string;
  /** An orbit change in progress: blended from `orbit` since `start` (`ORBIT_TWEEN`). */
  orbitFrom?: { orbit: SatelliteOrbit; start: number } | undefined;
  /** Scratch for the blended orbit (no allocation per frame). */
  blended: SatelliteOrbit;
  presence: Presence;
  /** Its agent ended: it shrinks out, then is dropped. */
  leaving: boolean;
  /** The beam as last drawn and when (the fade-out of a beam cut short). */
  beamShown: number;
  beamAt: number;
  frame: SatelliteFrame;
  /** Where the current flight started (captured on its first frame), by flight start time. */
  flightFrom?: { start: number; point: Vec3Tuple } | undefined;
  /**
   * P4-04: where it was last drawn, on which body and when (`at`, motion clock). A flight starts
   * from this point when it is fresh (`STALE_ORIGIN`) — which covers the usual move, including an
   * old body that stops being drawn in the same render that starts the flight (an asteroid
   * folding into the belt as its task joins a project, decision 63): the satellite was drawn on
   * the last frame. It is the "ghost" origin only after a frame where the satellite itself was
   * hidden (its old body had no anchor then) and the old body is not drawn either.
   */
  lastDrawn?: { bodyId: Id; point: Vec3Tuple; at: number } | undefined;
  /**
   * Its own orbit clock (P4-02): seconds of orbit travelled, at its state's `orbitRate` (a paused
   * satellite holds still, a failed one drifts; landing holds the angle it came down at), last
   * advanced at `clockAt`. At rate 1 it equals the motion clock.
   */
  clock: number;
  clockAt: number;
}

const scratch: Vec3Tuple = [0, 0, 0];
const scratchCentre: Vec3Tuple = [0, 0, 0];

const orbitKeyOf = (role: AgentRole, slot: number) => `${role}:${slot}`;

export class SatelliteDirector {
  private entries = new Map<Id, Entry>();
  /** Every satellite's slot and the body it holds it on (sticky slots, `orbitSlots`). */
  private slotHolders: ReadonlyMap<Id, SlotHolder> = new Map();
  private ordered: Entry[] = [];
  private options: DirectorOptions;
  /** The frames in the specs' order (agent id), then those shrinking out (renderers', cap's). */
  frames: SatelliteFrame[] = [];

  constructor(options: DirectorOptions) {
    this.options = options;
  }

  setOptions(options: DirectorOptions): void {
    this.options = options;
  }

  /**
   * The world's satellites changed: new agents get an actor (orbiting their body, no flight in
   * from anywhere) and grow in; ended ones shrink out and are then dropped; the others keep their
   * actor, slot and orbit and get the new input — a new body makes the next `update` start a
   * flight (to the lowest free slot there).
   *
   * P4-04: landed satellites (completed work) hold no orbit slot — they sit on the surface, and a
   * project body collecting its finished Stewards must not push its live satellites outwards. One
   * that lands keeps the orbit it came down from; one that appears already landed (a reload) gets
   * a slot among its body's landed satellites, which only spreads them over the surface.
   *
   * `snap` (P4-07 review): the scene jumped to another world (a timeline replay opened or exited),
   * so a satellite whose body or landing differs is placed there at once — no flight, no landing.
   * Satellites only in one of the worlds still grow in or shrink out.
   */
  setSpecs(specs: readonly SatelliteSpec[], now: number, opts: { snap?: boolean } = {}): void {
    const reduced = this.options.reducedMotion;
    const flying = specs.filter((s) => !s.landed);
    const slots = orbitSlots(flying, this.slotHolders);
    this.slotHolders = new Map(
      flying.map((s) => [s.agentId, { bodyId: s.bodyId, slot: slots.get(s.agentId) ?? 0 }]),
    );
    const parked = orbitSlots(specs.filter((s) => s.landed));
    const next = new Map<Id, Entry>();
    for (const spec of specs) {
      const input: SatelliteInput = {
        bodyId: spec.bodyId,
        state: spec.state,
        archetype: spec.archetype,
        landed: spec.landed,
      };
      const known = this.entries.get(spec.agentId);
      // P4-04: a landed satellite whose body moved (a promotion) is re-created landed there.
      const relanded =
        spec.landed && known?.actor.mode === 'landed' && known.actor.bodyId !== spec.bodyId;
      const slot = slots.get(spec.agentId) ?? parked.get(spec.agentId) ?? 0;
      // A satellite landing where it orbits keeps its orbit (it comes down from it).
      const keep = spec.landed && known !== undefined && known.actor.bodyId === spec.bodyId;
      const key = keep ? known.orbitKey : orbitKeyOf(spec.role, slot);
      if (known) {
        this.advanceClock(known, now); // up to now at the old state's orbit rate
        known.spec = spec;
        known.input = input;
        const elsewhere =
          known.actor.bodyId !== spec.bodyId || (known.actor.mode === 'landed') !== spec.landed;
        if (opts.snap && elsewhere) {
          // Placed where the new world has it, as if it had always been there.
          known.actor = createActor(spec.agentId, input, now);
          known.orbit = satelliteOrbit(spec.agentId, spec.role, slot);
          known.orbitKey = key;
          known.orbitFrom = undefined;
          known.flightFrom = undefined;
          known.lastDrawn = undefined;
        } else {
          // Taken now, not at the next drawn frame: a flight or landing starts when the world
          // changed, so it ends on time even if no frame is drawn meanwhile.
          known.actor = advance(known.actor, input, now, { reducedMotion: reduced });
          if (relanded && known.actor.mode === 'landed') {
            // No orbit blend across the surface and a fresh grow-in on the new body.
            known.orbit = satelliteOrbit(spec.agentId, spec.role, slot);
            known.orbitKey = key;
            known.orbitFrom = undefined;
            known.presence = { from: reduced ? 1 : 0, to: 1, start: now };
            known.lastDrawn = undefined;
          } else if (known.orbitKey !== key) this.changeOrbit(known, spec, slot, key, now);
        }
        if (known.leaving) {
          known.leaving = false;
          known.presence = { from: this.presenceAt(known, now), to: 1, start: now };
        }
        known.frame.role = spec.role;
        next.set(spec.agentId, known);
        continue;
      }
      const actor = createActor(spec.agentId, input, now);
      const orbit = satelliteOrbit(spec.agentId, spec.role, slot);
      next.set(spec.agentId, {
        spec,
        input,
        actor,
        orbit,
        orbitKey: key,
        blended: { ...orbit },
        presence: { from: reduced ? 1 : 0, to: 1, start: now },
        leaving: false,
        beamShown: 0,
        beamAt: now,
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
          presence: reduced ? 1 : 0,
          tint: satelliteTint(spec),
          brightness: 1,
          beamTint: beamTint(spec),
        },
        clock: now,
        clockAt: now,
      });
    }
    // Ended agents shrink out (at once under reduced motion), then go.
    for (const [id, e] of this.entries) {
      if (next.has(id) || reduced) continue;
      if (!e.leaving) {
        e.leaving = true;
        e.presence = { from: this.presenceAt(e, now), to: 0, start: now };
      } else if (this.gone(e, now)) continue;
      next.set(id, e);
    }
    this.setEntries(next);
  }

  /** Forgets every satellite and publishes none (the scene unmounts, or StrictMode rehearses it). */
  reset(): void {
    this.slotHolders = new Map();
    this.setEntries(new Map());
  }

  private setEntries(next: Map<Id, Entry>): void {
    const changed =
      next.size !== this.entries.size || [...next.keys()].some((id) => !this.entries.has(id));
    this.entries = next;
    this.ordered = [...next.values()];
    this.frames = this.ordered.map((e) => e.frame);
    if (changed) publishSatellites(new Map(this.ordered.map((e) => [e.spec.agentId, e.frame])));
  }

  /**
   * A satellite's orbit changes in place (a role change; a body change flies to the new orbit
   * instead): blended over `ORBIT_TWEEN` from where it is, its phase chosen so its angle carries
   * on — no jump. Instant during a flight (the flight aims at the new orbit) and under reduced
   * motion.
   */
  private changeOrbit(e: Entry, spec: SatelliteSpec, slot: number, key: string, now: number): void {
    const orbit = satelliteOrbit(spec.agentId, spec.role, slot);
    if (!this.options.reducedMotion && e.actor.mode !== 'flying') {
      const current = { ...this.orbitAt(e, now) };
      orbit.phase = orbitAngle(current, e.clock) - orbit.speed * e.clock;
      e.orbitFrom = { orbit: current, start: now };
    } else e.orbitFrom = undefined;
    e.orbit = orbit;
    e.orbitKey = key;
  }

  /** The orbit to draw at `now` (blended while an orbit change runs). */
  private orbitAt(e: Entry, now: number): SatelliteOrbit {
    const from = e.orbitFrom;
    if (!from) return e.orbit;
    const k = (now - from.start) / ORBIT_TWEEN;
    if (k >= 1 || this.options.reducedMotion) {
      e.orbitFrom = undefined;
      return e.orbit;
    }
    return blendOrbit(from.orbit, e.orbit, easeInOut(k), e.blended);
  }

  /** Advances a satellite's orbit clock to `now` at its current rate; returns it. */
  private advanceClock(e: Entry, now: number): number {
    const mode = e.actor.mode;
    const rate = mode === 'landing' || mode === 'landed' ? 0 : satelliteOrbitRate(e.spec);
    e.clock += (now - e.clockAt) * rate;
    e.clockAt = now;
    return e.clock;
  }

  private presenceAt(e: Entry, now: number): number {
    const p = e.presence;
    if (this.options.reducedMotion) return p.to;
    return p.from + (p.to - p.from) * easeInOut((now - p.start) / PRESENCE);
  }

  private gone(e: Entry, now: number): boolean {
    return e.leaving && (this.options.reducedMotion || now - e.presence.start >= PRESENCE - 1e-9);
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
    if (this.ordered.some((e) => this.gone(e, now))) {
      const kept = this.ordered.filter((e) => !this.gone(e, now));
      this.setEntries(new Map(kept.map((e) => [e.spec.agentId, e])));
    }
    for (const e of this.ordered) {
      const clock = this.advanceClock(e, now);
      const t = reduced ? 0 : clock;
      e.actor = advance(e.actor, e.input, now, { reducedMotion: reduced });
      const view = sampleActor(e.actor, now);
      const f = e.frame;
      f.mode = e.actor.mode;
      f.bodyId = e.actor.bodyId;
      f.view = view;
      f.tint = satelliteTint(e.spec);
      f.brightness = satelliteBrightness(e.spec, view, now, reduced);
      f.beamTint = beamTint(e.spec);
      f.presence = this.presenceAt(e, now);
      const radius = anchors(e.actor.bodyId, scratchCentre);
      if (radius === undefined) {
        // Hidden until its body is drawn; a flight keeps its origin (it is keyed by its start).
        f.visible = false;
        f.beam = 0;
        f.claimed = false;
        continue;
      }
      f.bodyRadius = radius;
      f.target[0] = scratchCentre[0];
      f.target[1] = scratchCentre[1];
      f.target[2] = scratchCentre[2];
      const orbit = this.orbitAt(e, now);

      if (e.actor.mode === 'flying' && e.actor.flight && view.flight !== undefined) {
        this.placeFlight(e, f, t, view.flight, anchors, now);
      } else if (e.actor.mode === 'landing' || e.actor.mode === 'landed') {
        e.flightFrom = undefined;
        const angle = orbitAngle(orbit, t); // the clock holds while landing
        const r = (orbit.radius + (SURFACE - orbit.radius) * view.landing) * radius;
        orbitOffset(orbit, angle, r, scratch);
        this.place(f, scratch);
      } else {
        e.flightFrom = undefined;
        orbitOffset(orbit, orbitAngle(orbit, t), orbit.radius * radius, scratch);
        this.place(f, scratch);
      }
      // P6-04: a view shows it elsewhere (a Steward by its task in the detail view), only while it
      // orbits — a flight, a landing and a landed satellite stay the director's.
      f.claimed = this.override(e, f);
      f.visible = true;
      if (e.lastDrawn) {
        e.lastDrawn.bodyId = e.actor.mode === 'flying' ? '' : e.actor.bodyId;
        e.lastDrawn.point[0] = f.position[0];
        e.lastDrawn.point[1] = f.position[1];
        e.lastDrawn.point[2] = f.position[2];
        e.lastDrawn.at = now;
      } else {
        const bodyId = e.actor.mode === 'flying' ? '' : e.actor.bodyId;
        e.lastDrawn = { bodyId, point: [f.position[0], f.position[1], f.position[2]], at: now };
      }

      const look = SATELLITE_LOOK[e.spec.role];
      let size = look.size * radius;
      if (pixelSize) size = Math.max(size, look.minPx * pixelSize(f.position));
      f.size = Math.min(size, look.maxSize * radius) * f.presence * satelliteScale(e.spec);
      if (f.claimed) f.size *= placementFor(e.spec.agentId)?.scale ?? 1; // P6-04
      f.beam = view.beam;
      const scan = e.actor.scan;
      if (scan && !reduced)
        f.sweep = BEAM.sweep * Math.sin((2 * Math.PI * (now - scan.start)) / TIMING.scan);
      else if (e.beamShown <= 0) f.sweep = 0; // a fading beam keeps its last swing
    }
    applyAnimationCap(this.frames, this.options.satellites.maxAnimated, focusBodyId);
    for (const e of this.ordered) {
      // A beam out of the budget, or cut short, fades out at most this fast: it never pops.
      const f = e.frame;
      const wanted = f.animated && f.visible ? f.beam : 0;
      let fading = e.beamShown - Math.max(0, now - e.beamAt) / BEAM_FADE_OUT;
      if (fading < 1e-6) fading = 0;
      f.beam = !f.visible || reduced ? 0 : Math.max(0, wanted, fading);
      e.beamShown = f.beam;
      e.beamAt = now;
    }
    return this.frames;
  }

  /** Moves an orbiting satellite toward its placement override (`placement.ts`); claimed? */
  private override(e: Entry, f: SatelliteFrame): boolean {
    const mode = e.actor.mode;
    if (mode === 'flying' || mode === 'landing' || mode === 'landed') return false;
    const o = placementFor(e.spec.agentId);
    if (!o || !(o.k > 0)) return false;
    const k = Math.min(1, o.k);
    f.position[0] += (o.position[0] - f.position[0]) * k;
    f.position[1] += (o.position[1] - f.position[1]) * k;
    f.position[2] += (o.position[2] - f.position[2]) * k;
    return k >= CLAIM_AT;
  }

  private place(f: SatelliteFrame, offset: Vec3Tuple): void {
    f.position[0] = f.target[0] + offset[0];
    f.position[1] = f.target[1] + offset[1];
    f.position[2] = f.target[2] + offset[2];
  }

  /**
   * A flight: from where the satellite was when it took off (captured on the flight's first
   * frame) to its place on the destination's orbit, which moves with the body, along an arc lifted
   * toward +y. The origin, in order:
   * 1. where it was drawn on the last frame, if that was within `STALE_ORIGIN` — the usual case,
   *    also when the old body stops being drawn in the same render that starts the flight (an
   *    asteroid whose task joined a project folds into the belt): the satellite was drawn on the
   *    frame before;
   * 2. its old orbit around the old body's live anchor (the satellite was hidden on the last
   *    frame, or its last drawn position is stale after a long gap without frames);
   * 3. P4-04's ghost — where it was last drawn on the old body — only after a frame where the
   *    satellite itself was hidden and when the old body is not drawn now either;
   * 4. only then the destination (nothing to fly from).
   */
  private placeFlight(
    e: Entry,
    f: SatelliteFrame,
    t: number,
    p: number,
    anchors: AnchorLookup,
    now: number,
  ): void {
    const flight = e.actor.flight;
    if (!flight) return;
    const orbit = e.orbit; // a flight aims at the new orbit (no blend)
    orbitOffset(orbit, orbitAngle(orbit, t), orbit.radius * f.bodyRadius, scratch);
    const dx = f.target[0] + scratch[0];
    const dy = f.target[1] + scratch[1];
    const dz = f.target[2] + scratch[2];
    if (!e.flightFrom || e.flightFrom.start !== flight.start) {
      let point: Vec3Tuple;
      const fresh = e.lastDrawn !== undefined && now - e.lastDrawn.at <= STALE_ORIGIN;
      if (f.visible && fresh) point = [f.position[0], f.position[1], f.position[2]];
      else {
        const centre: Vec3Tuple = [0, 0, 0];
        const r = anchors(flight.fromBodyId, centre);
        const ghost = e.lastDrawn?.bodyId === flight.fromBodyId ? e.lastDrawn.point : undefined;
        if (r !== undefined) {
          orbitOffset(orbit, orbitAngle(orbit, t), orbit.radius * r, scratch);
          point = [centre[0] + scratch[0], centre[1] + scratch[1], centre[2] + scratch[2]];
        } else if (ghost) point = [ghost[0], ghost[1], ghost[2]];
        else point = [dx, dy, dz];
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
