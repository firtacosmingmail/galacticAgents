import type { BodyKind, Id, QualityTier } from '@galactic/protocol';
import { planetLook } from '../../bodies/appearance.js';
import type { SatelliteFrame } from '../director.js';
import { ARCHETYPES, easeInOut, hashId, seedFraction, type ActivityArchetype } from '../machine.js';

/**
 * What the Steward activity archetypes draw (P4-03; SPEC §4.1, TECHNOLOGY §2.1), without three.js
 * so it is tested without WebGL. Every frame it turns the satellites' frames (`director.ts`) into
 * two instance lists — `solid` pieces (robots, platform struts, shuttle hulls: unlit, opaque) and
 * `glow` pieces (drones, sparks, the shuttle's trail: additive, HDR where there is bloom) — that
 * `Activities.tsx` copies into two instanced meshes: two draw calls whatever the count.
 *
 * - **gathering**: drones rise from the surface under the satellite up to it, in a loop;
 * - **transporting**: a shuttle runs back and forth between the Steward's satellite and its
 *   Waykeeper's when both orbit the same body; otherwise between the satellite and the surface
 *   under it (the work's own body, e.g. a standalone task's asteroid);
 * - **building**: on a body with a surface (rocky planets, Earth, Venus, every moon and asteroid)
 *   robots stand at a work site on the surface — the point under the satellite when the building
 *   began — and hammer, with sparks; on a gas or ice giant (Jupiter, Saturn, Uranus, Neptune) an
 *   orbital platform is assembled under the satellite, strut by strut.
 *
 * Only satellites in the animation budget (`frame.animated`, the cap of corner case 21) draw an
 * archetype, so the instance count is bounded by the cap: `capacityFor(maxAnimated)`. Strength
 * follows the machine's mode blend (`view.blend`, 0.6 s): an archetype grows in while its mode
 * blends in, and the previous one shrinks out meanwhile; a satellite that loses the budget fades
 * its archetype over `FADE_OUT` rather than popping. Under reduced motion everything is static (the
 * clock stands at 0: drones and shuttles parked, robots still, the platform complete) and appears
 * at once. Lighter tiers draw fewer pieces (`ACTIVITY_QUALITY`).
 */

/** Where building happens on a body. */
export type Footing = 'surface' | 'platform';

/** Gas and ice giants have no surface: their Stewards build an orbital platform. */
export function footingOf(body: { kind: BodyKind; name: string } | undefined): Footing {
  if (!body || body.kind !== 'planet') return 'surface';
  const style = planetLook(body.name).style;
  return style === 'gas' || style === 'ice' ? 'platform' : 'surface';
}

/** How much each tier draws per satellite. */
export interface ActivityQuality {
  drones: number;
  robots: number;
  /** Glowing trail pieces behind the shuttle. */
  trail: number;
  /** Sparks at the robots and the platform (bloom tiers only: they glow). */
  sparks: boolean;
}

export const ACTIVITY_QUALITY: Readonly<Record<QualityTier, ActivityQuality>> = {
  high: { drones: 4, robots: 4, trail: 2, sparks: true },
  balanced: { drones: 3, robots: 3, trail: 2, sparks: true },
  mobile: { drones: 2, robots: 2, trail: 0, sparks: false },
};

/** The most pieces one archetype of one satellite draws, per list. */
export const PER_ARCHETYPE = { solid: 5, glow: 4 } as const;

/** Instance capacity for a cap: two archetypes per satellite at most (one in, one out). */
export function capacityFor(maxAnimated: number): { solid: number; glow: number } {
  return {
    solid: maxAnimated * 2 * PER_ARCHETYPE.solid,
    glow: maxAnimated * 2 * PER_ARCHETYPE.glow,
  };
}

/** Durations (seconds) and proportions. */
export const ACTIVITY_LOOK = {
  /** A drone's climb from the surface to the satellite. */
  droneCycle: 1.8,
  /** The drones' spread on the surface around the point under the satellite (radians-ish). */
  droneSpread: 0.35,
  /** A shuttle's round trip. */
  shuttleCycle: 4,
  /** How high its path arcs, relative to the distance. */
  shuttleArc: 0.15,
  /** How far apart the robots stand (radians on the body). */
  robotSpread: 0.12,
  /** Hammer strokes per second. */
  hammer: 1.6,
  /** One assembly of the platform, strut by strut. */
  platformCycle: 6,
  /** The platform's depth under the satellite (fraction of the satellite's distance to centre). */
  platformDepth: 0.86,
  /** An archetype that lost the budget fades out this fast. */
  fadeOut: 0.4,
  /** Sizes, in the satellite's span (`frame.size`, which has a pixel floor). */
  drone: 0.22,
  shuttle: [0.18, 0.5] as const,
  robot: [0.26, 0.38] as const,
  spark: 0.16,
  platformSpan: 1.4,
  strut: 0.1,
  /** Colours: linear RGB; glow colours are scaled by `glowGain`. */
  droneColor: [0.45, 1.25, 0.8] as const,
  shuttleColor: [1.0, 0.86, 0.6] as const,
  trailColor: [1.1, 0.75, 0.35] as const,
  robotColor: [1.0, 0.62, 0.22] as const,
  platformColor: [0.78, 0.8, 0.86] as const,
  sparkColor: [1.4, 1.2, 0.7] as const,
  /** Glow with a composer reaches bloom; without, a soft additive speck. */
  glowGain: { bloom: 1.2, plain: 0.55 },
} as const;

/** One list of instances: flat arrays, `count` used, never reallocated per frame. */
export class InstanceList {
  count = 0;
  readonly position: Float32Array;
  /** The instance's local +y in world space (unit). */
  readonly axis: Float32Array;
  /** Local x, y, z scale. */
  readonly scale: Float32Array;
  readonly color: Float32Array;
  constructor(readonly capacity: number) {
    this.position = new Float32Array(capacity * 3);
    this.axis = new Float32Array(capacity * 3);
    this.scale = new Float32Array(capacity * 3);
    this.color = new Float32Array(capacity * 3);
  }
  push(
    p: Vec,
    axis: Vec,
    sx: number,
    sy: number,
    sz: number,
    rgb: readonly number[],
    gain: number,
  ): void {
    if (this.count >= this.capacity) return;
    const i = this.count++ * 3;
    this.position[i] = p[0];
    this.position[i + 1] = p[1];
    this.position[i + 2] = p[2];
    this.axis[i] = axis[0];
    this.axis[i + 1] = axis[1];
    this.axis[i + 2] = axis[2];
    this.scale[i] = sx;
    this.scale[i + 1] = sy;
    this.scale[i + 2] = sz;
    this.color[i] = (rgb[0] ?? 0) * gain;
    this.color[i + 1] = (rgb[1] ?? 0) * gain;
    this.color[i + 2] = (rgb[2] ?? 0) * gain;
  }
}

type Vec = [number, number, number];

/** What the layer needs from the scene besides the frames. */
export interface ActivityContext {
  now: number;
  reducedMotion: boolean;
  bloom: boolean;
  quality: ActivityQuality;
  /** The footing of a body (from the world's bodies). */
  footing: (bodyId: Id) => Footing;
  /** A Steward's supervisor (its Waykeeper), from the satellite specs. */
  supervisor: (agentId: Id) => Id | undefined;
  /** Another satellite's live frame (the registry). */
  satellite: (agentId: Id) => SatelliteFrame | undefined;
}

interface Shown {
  /** Strength per archetype, as last drawn, and when. */
  strength: Record<ActivityArchetype, number>;
  at: number;
  /** The building site: the direction from the body's centre, fixed when building began. */
  site: Vec | undefined;
  siteBody: Id | undefined;
}

const UP: Vec = [0, 1, 0];
const RIGHT: Vec = [1, 0, 0];

/** Per-archetype, per-satellite instance drawing. Allocation-free per frame once warmed up. */
export class ActivityLayer {
  readonly solid: InstanceList;
  readonly glow: InstanceList;
  private shown = new Map<Id, Shown>();
  private seen = new Set<Id>();
  // Scratch vectors.
  private up: Vec = [0, 0, 0];
  private t1: Vec = [0, 0, 0];
  private t2: Vec = [0, 0, 0];
  private a: Vec = [0, 0, 0];
  private b: Vec = [0, 0, 0];
  private p: Vec = [0, 0, 0];
  private d: Vec = [0, 0, 0];

  constructor(maxAnimated: number) {
    const cap = capacityFor(maxAnimated);
    this.solid = new InstanceList(cap.solid);
    this.glow = new InstanceList(cap.glow);
  }

  /** Rewrites both lists from this frame's satellites. */
  build(frames: readonly SatelliteFrame[], ctx: ActivityContext): void {
    this.solid.count = 0;
    this.glow.count = 0;
    this.seen.clear();
    for (const f of frames) {
      if (f.role !== 'steward') continue;
      this.seen.add(f.agentId);
      const shown = this.strengths(f, ctx);
      if (!shown || !f.visible) continue;
      for (const arch of ARCHETYPES) {
        const s = shown.strength[arch] * f.presence;
        if (s <= 1e-3) continue;
        if (arch === 'gathering') this.gathering(f, s, ctx);
        else if (arch === 'transporting') this.transporting(f, s, ctx);
        else this.building(f, shown, s, ctx);
      }
    }
    for (const id of this.shown.keys()) if (!this.seen.has(id)) this.shown.delete(id);
  }

  /** The archetype strengths of a satellite this frame (`view.blend`, budget, fade-out). */
  private strengths(f: SatelliteFrame, ctx: ActivityContext): Shown | undefined {
    let shown = this.shown.get(f.agentId);
    const live = f.visible && f.animated;
    const view = f.view;
    let any = false;
    for (const arch of ARCHETYPES) {
      let wanted = 0;
      if (live) {
        if (f.mode === arch) wanted = view.blend;
        else if (view.from === arch) wanted = 1 - view.blend;
      }
      const before = shown ? shown.strength[arch] : 0;
      let s = wanted;
      if (!ctx.reducedMotion && shown) {
        const fading = before - Math.max(0, ctx.now - shown.at) / ACTIVITY_LOOK.fadeOut;
        s = Math.max(wanted, fading, 0);
      }
      if (s > 0 && !shown) {
        shown = {
          strength: { gathering: 0, transporting: 0, building: 0 },
          at: ctx.now,
          site: undefined,
          siteBody: undefined,
        };
        this.shown.set(f.agentId, shown);
      }
      if (shown) shown.strength[arch] = s < 1e-4 ? 0 : s;
      if (s > 0) any = true;
    }
    if (shown) {
      shown.at = ctx.now;
      if (f.mode !== 'building' && shown.strength.building === 0) shown.site = undefined;
    }
    return any ? shown : undefined;
  }

  /** The body-centred frame at the satellite: `up` from the centre to it, `t1`, `t2` tangents. */
  private basis(f: SatelliteFrame): number {
    const up = this.up;
    up[0] = f.position[0] - f.target[0];
    up[1] = f.position[1] - f.target[1];
    up[2] = f.position[2] - f.target[2];
    const dist = Math.hypot(up[0], up[1], up[2]) || 1;
    up[0] /= dist;
    up[1] /= dist;
    up[2] /= dist;
    tangents(up, this.t1, this.t2);
    return dist;
  }

  private gathering(f: SatelliteFrame, s: number, ctx: ActivityContext): void {
    this.basis(f);
    const n = ctx.quality.drones;
    const seed = hashId(f.agentId);
    const t = ctx.reducedMotion ? 0 : ctx.now;
    const gain = glowGain(ctx);
    const size = ACTIVITY_LOOK.drone * f.size * s;
    for (let i = 0; i < n; i++) {
      const u = fract(t / ACTIVITY_LOOK.droneCycle + (i + 0.5) / n + seedFraction(seed, i));
      const angle = 2 * Math.PI * (i / n + seedFraction(seed, 50));
      const spread = ACTIVITY_LOOK.droneSpread * (0.5 + 0.5 * seedFraction(seed, 60 + i));
      // Start: on the surface, around the point under the satellite.
      offsetDir(this.up, this.t1, this.t2, angle, spread, this.a);
      const r = f.bodyRadius * 1.01;
      this.p[0] = f.target[0] + this.a[0] * r;
      this.p[1] = f.target[1] + this.a[1] * r;
      this.p[2] = f.target[2] + this.a[2] * r;
      // Towards the satellite.
      this.d[0] = f.position[0] - this.p[0];
      this.d[1] = f.position[1] - this.p[1];
      this.d[2] = f.position[2] - this.p[2];
      const k = easeInOut(u);
      this.b[0] = this.p[0] + this.d[0] * k;
      this.b[1] = this.p[1] + this.d[1] * k;
      this.b[2] = this.p[2] + this.d[2] * k;
      normalize(this.d);
      const pulse = Math.sqrt(Math.sin(Math.PI * u)); // appears at the surface, docks at the top
      const sz = size * pulse;
      this.glow.push(this.b, this.d, sz, sz * 1.6, sz, ACTIVITY_LOOK.droneColor, gain);
    }
  }

  private transporting(f: SatelliteFrame, s: number, ctx: ActivityContext): void {
    this.basis(f);
    const seed = hashId(f.agentId);
    // The other end: the Waykeeper's satellite on the same body, else the surface under it.
    const other = this.partner(f, ctx);
    const end = this.a;
    if (other) {
      end[0] = other.position[0];
      end[1] = other.position[1];
      end[2] = other.position[2];
    } else {
      const r = f.bodyRadius * 1.02;
      end[0] = f.target[0] + this.up[0] * r;
      end[1] = f.target[1] + this.up[1] * r;
      end[2] = f.target[2] + this.up[2] * r;
    }
    const t = ctx.reducedMotion ? 0 : ctx.now;
    const phase = ctx.reducedMotion
      ? 0.06
      : fract(t / ACTIVITY_LOOK.shuttleCycle + seedFraction(seed, 7));
    const outward = phase < 0.5;
    const k = easeInOut(outward ? phase * 2 : (1 - phase) * 2);
    this.shuttleAt(f, end, k, this.p);
    // Heading: along the path in the direction of travel.
    const ahead = Math.min(1, Math.max(0, k + (outward ? 0.02 : -0.02)));
    this.shuttleAt(f, end, ahead, this.b);
    this.d[0] = this.b[0] - this.p[0];
    this.d[1] = this.b[1] - this.p[1];
    this.d[2] = this.b[2] - this.p[2];
    if (!normalize(this.d)) {
      this.d[0] = end[0] - f.position[0];
      this.d[1] = end[1] - f.position[1];
      this.d[2] = end[2] - f.position[2];
      if (!normalize(this.d)) copy(this.up, this.d);
    }
    const [w, l] = ACTIVITY_LOOK.shuttle;
    this.solid.push(
      this.p,
      this.d,
      w * f.size * s,
      l * f.size * s,
      w * f.size * s,
      ACTIVITY_LOOK.shuttleColor,
      1,
    );
    const gain = glowGain(ctx);
    for (let j = 1; j <= ctx.quality.trail; j++) {
      const back = Math.min(1, Math.max(0, k + (outward ? -0.035 : 0.035) * j));
      this.shuttleAt(f, end, back, this.b);
      const sz = w * f.size * s * (1 - 0.3 * j);
      this.glow.push(this.b, this.d, sz, sz, sz, ACTIVITY_LOOK.trailColor, gain * (1 - 0.35 * j));
    }
  }

  /** The supervisor's satellite when it is drawn on the same body. */
  private partner(f: SatelliteFrame, ctx: ActivityContext): SatelliteFrame | undefined {
    const id = ctx.supervisor(f.agentId);
    if (!id) return undefined;
    const other = ctx.satellite(id);
    if (!other || !other.visible || other.bodyId !== f.bodyId || other.presence < 0.5)
      return undefined;
    if (other.mode === 'flying') return undefined;
    return other;
  }

  /** A point on the shuttle's arc from the satellite (`k` = 0) to `end` (`k` = 1). */
  private shuttleAt(f: SatelliteFrame, end: Vec, k: number, out: Vec): void {
    const dx = end[0] - f.position[0];
    const dy = end[1] - f.position[1];
    const dz = end[2] - f.position[2];
    const lift = ACTIVITY_LOOK.shuttleArc * Math.hypot(dx, dy, dz) * Math.sin(Math.PI * k);
    out[0] = f.position[0] + dx * k + this.up[0] * lift;
    out[1] = f.position[1] + dy * k + this.up[1] * lift;
    out[2] = f.position[2] + dz * k + this.up[2] * lift;
  }

  private building(f: SatelliteFrame, shown: Shown, s: number, ctx: ActivityContext): void {
    const dist = this.basis(f);
    if (ctx.footing(f.bodyId) === 'platform') this.platform(f, dist, s, ctx);
    else this.robots(f, shown, s, ctx);
  }

  private robots(f: SatelliteFrame, shown: Shown, s: number, ctx: ActivityContext): void {
    // The work site: under the satellite when building began; it stays there.
    if (!shown.site || shown.siteBody !== f.bodyId) {
      shown.site = [this.up[0], this.up[1], this.up[2]];
      shown.siteBody = f.bodyId;
    }
    const site = shown.site;
    tangents(site, this.t1, this.t2);
    const seed = hashId(f.agentId);
    const t = ctx.reducedMotion ? 0 : ctx.now;
    const n = ctx.quality.robots;
    const [w, h] = ACTIVITY_LOOK.robot;
    const gain = glowGain(ctx);
    for (let i = 0; i < n; i++) {
      const angle = 2 * Math.PI * (i / n + seedFraction(seed, 80));
      const wander = ctx.reducedMotion ? 0 : 0.25 * Math.sin(t * 0.5 + i * 1.7);
      const spread = ACTIVITY_LOOK.robotSpread * (0.6 + 0.4 * seedFraction(seed, 90 + i));
      offsetDir(site, this.t1, this.t2, angle + wander, spread, this.d);
      const stroke = ctx.reducedMotion
        ? 0
        : Math.abs(Math.sin(Math.PI * (t * ACTIVITY_LOOK.hammer + seedFraction(seed, 100 + i))));
      const height = h * f.size * s * (1 + 0.3 * stroke);
      const r = f.bodyRadius + height / 2;
      this.p[0] = f.target[0] + this.d[0] * r;
      this.p[1] = f.target[1] + this.d[1] * r;
      this.p[2] = f.target[2] + this.d[2] * r;
      this.solid.push(
        this.p,
        this.d,
        w * f.size * s,
        height,
        w * f.size * s,
        ACTIVITY_LOOK.robotColor,
        1,
      );
      if (!ctx.quality.sparks || ctx.reducedMotion || stroke < 0.85) continue;
      const top = f.bodyRadius + height * 1.1;
      this.b[0] = f.target[0] + this.d[0] * top;
      this.b[1] = f.target[1] + this.d[1] * top;
      this.b[2] = f.target[2] + this.d[2] * top;
      const sz = ACTIVITY_LOOK.spark * f.size * s;
      this.glow.push(this.b, this.d, sz, sz, sz, ACTIVITY_LOOK.sparkColor, gain);
    }
  }

  private platform(f: SatelliteFrame, dist: number, s: number, ctx: ActivityContext): void {
    const seed = hashId(f.agentId);
    const t = ctx.reducedMotion ? 0 : ctx.now;
    // Centre: under the satellite, between it and the body (never inside the body).
    const r = Math.max(f.bodyRadius * 1.08, dist * ACTIVITY_LOOK.platformDepth);
    const c = this.p;
    c[0] = f.target[0] + this.up[0] * r;
    c[1] = f.target[1] + this.up[1] * r;
    c[2] = f.target[2] + this.up[2] * r;
    const span = ACTIVITY_LOOK.platformSpan * f.size * s;
    const strut = ACTIVITY_LOOK.strut * f.size * s;
    // Assembly: the struts appear one by one over a cycle, then it starts over (static: complete).
    const progress = ctx.reducedMotion
      ? 1
      : fract(t / ACTIVITY_LOOK.platformCycle + seedFraction(seed, 3));
    const built = ctx.reducedMotion ? 4 : Math.min(4, Math.floor(progress * 5));
    const turn = t * 0.15 + 2 * Math.PI * seedFraction(seed, 4);
    // The mast, along `up`.
    this.solid.push(c, this.up, strut, span * 0.8, strut, ACTIVITY_LOOK.platformColor, 1);
    const gain = glowGain(ctx);
    for (let i = 0; i < 4; i++) {
      if (i >= built) break;
      // A square: strut i runs along a tangent, offset to its side.
      const angle = turn + (i * Math.PI) / 2;
      const ca = Math.cos(angle);
      const sa = Math.sin(angle);
      // Side normal (towards the strut's side) and its direction (perpendicular, in the plane).
      for (let j = 0; j < 3; j++) {
        this.a[j] = (this.t1[j] ?? 0) * ca + (this.t2[j] ?? 0) * sa;
        this.d[j] = -(this.t1[j] ?? 0) * sa + (this.t2[j] ?? 0) * ca;
      }
      this.b[0] = c[0] + this.a[0] * span * 0.5;
      this.b[1] = c[1] + this.a[1] * span * 0.5;
      this.b[2] = c[2] + this.a[2] * span * 0.5;
      this.solid.push(this.b, this.d, strut, span, strut, ACTIVITY_LOOK.platformColor, 1);
      // A welding spark at the end of the strut being built.
      if (ctx.quality.sparks && !ctx.reducedMotion && i === built - 1 && built < 4) {
        const flick = Math.sin(t * 23 + i) > 0.2 ? 1 : 0.45;
        const sz = ACTIVITY_LOOK.spark * f.size * s * flick;
        for (let j = 0; j < 3; j++) this.b[j] = (this.b[j] ?? 0) + (this.d[j] ?? 0) * span * 0.5;
        this.glow.push(this.b, this.d, sz, sz, sz, ACTIVITY_LOOK.sparkColor, gain);
      }
    }
  }
}

function glowGain(ctx: ActivityContext): number {
  return ctx.bloom ? ACTIVITY_LOOK.glowGain.bloom : ACTIVITY_LOOK.glowGain.plain;
}

const fract = (x: number): number => x - Math.floor(x);

function copy(from: Vec, to: Vec): void {
  to[0] = from[0];
  to[1] = from[1];
  to[2] = from[2];
}

/** Normalises in place; false for a zero vector. */
function normalize(v: Vec): boolean {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (len < 1e-9) return false;
  v[0] /= len;
  v[1] /= len;
  v[2] /= len;
  return true;
}

/** Two unit tangents perpendicular to the unit `n`. */
function tangents(n: Vec, t1: Vec, t2: Vec): void {
  const ref = Math.abs(n[1]) < 0.9 ? UP : RIGHT;
  // t1 = normalize(ref × n)
  t1[0] = ref[1] * n[2] - ref[2] * n[1];
  t1[1] = ref[2] * n[0] - ref[0] * n[2];
  t1[2] = ref[0] * n[1] - ref[1] * n[0];
  normalize(t1);
  // t2 = n × t1
  t2[0] = n[1] * t1[2] - n[2] * t1[1];
  t2[1] = n[2] * t1[0] - n[0] * t1[2];
  t2[2] = n[0] * t1[1] - n[1] * t1[0];
}

/** `n` tilted by `spread` radians towards the tangent direction at `angle` (unit, into `out`). */
function offsetDir(n: Vec, t1: Vec, t2: Vec, angle: number, spread: number, out: Vec): void {
  const c = Math.cos(spread);
  const s = Math.sin(spread);
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  out[0] = n[0] * c + (t1[0] * ca + t2[0] * sa) * s;
  out[1] = n[1] * c + (t1[1] * ca + t2[1] * sa) * s;
  out[2] = n[2] * c + (t1[2] * ca + t2[2] * sa) * s;
}
