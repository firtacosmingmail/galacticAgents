import type {
  Body,
  BodyChoice,
  BodyOccupancy,
  BodyRequest,
  Id,
  Project,
  Task,
} from '@galactic/protocol';
import { DomainError, must } from './errors.js';
import type { CommandContext } from './event-log.js';
import { FINISHED_WORK } from './states.js';

/**
 * The body catalogue (P2-02; SPEC §3.1–3.2, decisions 1, 10, 15, 16). Migration 0005 seeds the
 * Sun, the eight planets and their major moons; asteroids are generated here on demand. Which
 * body a new project gets is decided by these functions, never by a model: `freePlanets()` and
 * `freeMoons()` are deterministic (catalogue order), and `chooseBody` applies decision 10.
 */

/** The catalogue's queries only read: a command context or the event log itself will do. */
export type Reader = Pick<CommandContext, 'tables'>;

/** Seeded ids (migration 0005). Earth is the headquarters, the Harmonizer's home (P2-20). */
export const SUN_ID = 'b-sun';
export const EARTH_ID = 'b-earth';
export const MOON_ID = 'b-moon';

/** Reserved bodies (the Sun, Earth, Earth's Moon) are never assigned (SPEC §3.1). */
export const isReserved = (body: Body): boolean => body.meta?.['reserved'] === true;

/** Free: unreserved, hosting nothing and not showing a "moved to …" marker. */
export const isFree = (body: Body): boolean => !body.host && !body.movedTo && !isReserved(body);

const num = (v: unknown, fallback: number): number => (typeof v === 'number' ? v : fallback);

/**
 * The catalogue order: the Sun, planets from the Sun outwards, then moons by their planet's
 * orbit and their own, then asteroids by number. Bodies without an orbit (a hand-made demo
 * planet) come after the seeded ones of their kind, by name, then id — always the same order.
 */
export function catalogueOrder(bodies: readonly Body[], all: readonly Body[] = bodies): Body[] {
  const byId = new Map(all.map((b) => [b.id, b]));
  const KIND = { star: 0, planet: 1, moon: 2, asteroid: 3 } as const;
  const key = (b: Body): number[] => {
    const own = num(b.meta?.['orbit'] ?? b.meta?.['number'], Number.MAX_SAFE_INTEGER);
    const parent = b.parentId ? byId.get(b.parentId) : undefined;
    const planet = parent ? num(parent.meta?.['orbit'], Number.MAX_SAFE_INTEGER) : 0;
    return [KIND[b.kind], planet, own];
  };
  return [...bodies].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i]! - kb[i]!;
    return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });
}

/** The bodies matching `pred`, in catalogue order. */
export function bodiesWhere(ctx: Reader, pred: (b: Body) => boolean): Body[] {
  const all = ctx.tables.bodies.all();
  return catalogueOrder(all.filter(pred), all);
}

/** The free planets in catalogue order (Earth never among them). */
export function freePlanets(ctx: Reader): Body[] {
  return bodiesWhere(ctx, (b) => b.kind === 'planet' && isFree(b));
}

/** The free moons, of `planetId` or of every planet, in catalogue order (Earth's Moon never). */
export function freeMoons(ctx: Reader, planetId?: Id): Body[] {
  return bodiesWhere(
    ctx,
    (b) => b.kind === 'moon' && isFree(b) && (!planetId || b.parentId === planetId),
  );
}

/** Who holds a body: its host's name and state, or the marker it shows. */
export function occupancyOf(ctx: Reader, body: Body): BodyOccupancy {
  const out: BodyOccupancy = { bodyId: body.id, bodyName: body.name };
  if (body.movedTo) out.movedTo = body.movedTo;
  if (!body.host) return out;
  out.host = body.host;
  const row: Project | Task | undefined =
    body.host.kind === 'project'
      ? ctx.tables.projects.get(body.host.id)
      : ctx.tables.tasks.get(body.host.id);
  if (row) {
    out.occupant = 'name' in row ? row.name : row.description;
    out.state = row.state;
  }
  return out;
}

/** Every unreserved planet that is not free, with its occupant (decision 16's refusal). */
export function occupiedPlanets(ctx: Reader): BodyOccupancy[] {
  return bodiesWhere(ctx, (b) => b.kind === 'planet' && !isReserved(b) && !isFree(b)).map((b) =>
    occupancyOf(ctx, b),
  );
}

export interface ChooseOptions {
  /**
   * Whether an agent is still running (the runtime's status store knows; the domain does not).
   * Default: every Waykeeper of an unfinished project counts as present.
   */
  isRunning?: (agentId: Id) => boolean;
}

/**
 * Whether a planet has a Waykeeper (decision 10): it hosts an unfinished project that a
 * Waykeeper agent works for. A free planet, or one whose project is finished (its Waykeeper is
 * stopped on closure, decision 11), has none.
 */
function hasWaykeeper(ctx: Reader, planet: Body, opts: ChooseOptions): boolean {
  if (planet.host?.kind !== 'project') return false;
  const project = ctx.tables.projects.get(planet.host.id);
  if (!project || FINISHED_WORK.has(project.state)) return false;
  return ctx.tables.agents
    .all()
    .some(
      (a) =>
        a.role === 'waykeeper' &&
        a.projectId === project.id &&
        (opts.isRunning ? opts.isRunning(a.id) : true),
    );
}

/**
 * Picks the body for a new project by decision 10, changing nothing:
 * - a planet: the first free planet, or "no free planet" listing the occupied ones;
 * - a sub-project's moon: a free moon of its parent project's planet, or "no free moon" (it then
 *   stays a task on the planet, SPEC §3.2);
 * - an independent project's moon: a free moon of a planet without a Waykeeper, else any free
 *   moon, else "no free moon".
 */
export function chooseBody(
  ctx: Reader,
  request: BodyRequest,
  opts: ChooseOptions = {},
): BodyChoice {
  if (request.kind === 'planet') {
    // Room to grow: a planet with a free moon can later take a sub-project (SPEC §3.2).
    const planets = freePlanets(ctx);
    const body = planets.find((p) => freeMoons(ctx, p.id).length > 0) ?? planets[0];
    return body
      ? { ok: true, body }
      : { ok: false, reason: 'no_free_planet', occupied: occupiedPlanets(ctx) };
  }
  if (request.parentProjectId) {
    const parent = must(
      ctx.tables.projects.get(request.parentProjectId),
      'project',
      request.parentProjectId,
    );
    const planet = must(ctx.tables.bodies.get(parent.bodyId), 'body', parent.bodyId);
    if (planet.kind !== 'planet') {
      throw new DomainError(
        'invalid',
        `a sub-project lives on a moon of its parent's planet; ${parent.name} is on ${planet.name}`,
      );
    }
    const body = freeMoons(ctx, planet.id)[0];
    if (body) return { ok: true, body };
    const occupied = bodiesWhere(ctx, (b) => b.kind === 'moon' && b.parentId === planet.id).map(
      (b) => occupancyOf(ctx, b),
    );
    return { ok: false, reason: 'no_free_moon', planetId: planet.id, occupied };
  }
  const moons = freeMoons(ctx);
  const planets = new Map(ctx.tables.bodies.all().map((b) => [b.id, b]));
  const quiet = moons.find((m) => {
    const planet = m.parentId ? planets.get(m.parentId) : undefined;
    return planet !== undefined && !hasWaykeeper(ctx, planet, opts);
  });
  const body = quiet ?? moons[0];
  if (body) return { ok: true, body };
  const occupied = bodiesWhere(ctx, (b) => b.kind === 'moon' && !isReserved(b)).map((b) =>
    occupancyOf(ctx, b),
  );
  return { ok: false, reason: 'no_free_moon', occupied };
}

/** The one-line refusal for a `BodyChoice` that found nothing (a `DomainError` message). */
export function describeRefusal(choice: Exclude<BodyChoice, { ok: true }>): string {
  const list = choice.occupied
    .map((o) =>
      o.host
        ? `${o.bodyName}: ${o.occupant ?? o.host.id}${o.state ? ` (${o.state})` : ''}`
        : `${o.bodyName}: moved to ${o.movedTo?.bodyId ?? '?'}`,
    )
    .join('; ');
  const what = choice.reason === 'no_free_planet' ? 'no free planet' : 'no free moon';
  return list ? `${what} — occupied: ${list}` : what;
}

// ---------------------------------------------------------------------------
// Procedural asteroids (decision 1: unlimited, generated as needed)
// ---------------------------------------------------------------------------

/** A small deterministic PRNG (mulberry32): the same seed always gives the same asteroid. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ONSETS = [
  '',
  'b',
  'c',
  'd',
  'f',
  'g',
  'k',
  'l',
  'm',
  'n',
  'p',
  'r',
  's',
  't',
  'v',
  'z',
  'th',
  'kr',
  'st',
];
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'ae', 'io'];
const CODAS = ['', '', 'n', 'r', 's', 'l', 'x'];

/** The fixed seed of the belt: asteroid `n` is derived from it and `n` alone. */
export const BELT_SEED = 0x5eed_2026;

export interface AsteroidSpec {
  id: Id;
  name: string;
  meta: {
    number: number;
    seed: number;
    /** Decorative orbit in the belt (TECHNOLOGY §2 scene; corner case 26): AU, radians, radians. */
    orbit: { radius: number; phase: number; inclination: number };
  };
}

/**
 * Asteroid number `n` of the belt: id, name ("(n) Name", after minor-planet designations) and
 * orbit, all a pure function of `n` — a replayed log or a second server builds the same belt.
 */
export function asteroidSpec(n: number): AsteroidSpec {
  const seed = (BELT_SEED ^ Math.imul(n, 0x9e3779b1)) >>> 0;
  const rand = prng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const syllables = 2 + Math.floor(rand() * 2);
  let word = '';
  for (let i = 0; i < syllables; i++) word += pick(ONSETS) + pick(VOWELS);
  word += pick(CODAS);
  const name = `(${n}) ${word[0]!.toUpperCase()}${word.slice(1)}`;
  const round = (x: number) => Math.round(x * 1000) / 1000;
  return {
    id: `b-asteroid-${n}`,
    name,
    meta: {
      number: n,
      seed,
      orbit: {
        radius: round(2.2 + rand() * 1.1),
        phase: round(rand() * 2 * Math.PI),
        inclination: round((rand() - 0.5) * 0.3),
      },
    },
  };
}

/** The next asteroid number: one past the highest generated so far. */
export function nextAsteroidNumber(ctx: Reader): number {
  let max = 0;
  for (const b of ctx.tables.bodies.all()) {
    if (b.kind === 'asteroid') max = Math.max(max, num(b.meta?.['number'], 0));
  }
  return max + 1;
}

/**
 * A fresh asteroid for a standalone task (decision 1), announced with `body.created`. Freed
 * asteroids are not reused: each standalone task gets a body of its own, which the history keeps.
 */
export function createAsteroid(ctx: CommandContext, name?: string): Body {
  let n = nextAsteroidNumber(ctx);
  while (ctx.tables.bodies.get(asteroidSpec(n).id)) n++;
  const spec = asteroidSpec(n);
  const body: Body = { id: spec.id, kind: 'asteroid', name: name ?? spec.name, meta: spec.meta };
  ctx.tables.bodies.insert(body);
  ctx.emit({ type: 'body.created', body });
  return body;
}
