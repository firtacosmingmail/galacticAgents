import type { Body } from '@galactic/protocol';

/**
 * The internal layers of the catalogue bodies with a known interior (P6-03), as plain data (no
 * three.js: the panel's toggle reads it too). Keyed by the body's name, as the appearance table is
 * (`bodies/appearance.ts`, migration 0005), and by kind, so a made-up moon named "Mars" gets none.
 *
 * Each table lists the layers from the surface inward; `outer` is the layer's outer radius as a
 * fraction of the body's mean radius (the first is 1, the innermost layer reaches the centre).
 * The values are approximate, rounded from public sources (NASA fact sheets and the papers cited in
 * `docs/tasks/notes/P6-03-cutaway.md`); interiors of the giants are model-dependent, and the
 * picture is a schematic, not a measurement. Thin layers (a rocky crust is under 2 % of the radius)
 * are drawn thicker than they are (`displayRadii`), so every band is readable.
 *
 * Colours are sRGB, chosen to read apart on the dark backdrop with a white label beside them:
 * rocky bodies go from a brown crust through an orange mantle to a yellow-white core; giants from
 * their envelope's own colour to a blue-grey metallic or ice layer and a brown rocky core.
 */
export interface Layer {
  /** What the label says ("Outer core"). */
  name: string;
  /** Outer radius, fraction of the body's mean radius (0 < outer ≤ 1). */
  outer: number;
  /** sRGB colour of its band in the cut. */
  color: string;
  /** One short phrase for the screen-reader description ("liquid iron and nickel"). */
  note: string;
}

export interface BodyInterior {
  /** The body kind the name must have. */
  kind: 'planet' | 'moon';
  layers: readonly Layer[];
}

const CRUST = '#8a6a4c';
const MANTLE = '#c8562c';
const OUTER_CORE = '#f0a43a';
const INNER_CORE = '#fff1b8';
const ROCKY_CORE = '#8a5d3e';
const METALLIC_H = '#7d8fbf';

export const INTERIORS: Readonly<Record<string, BodyInterior>> = {
  // Mean radius 2440 km; crust ~35 km; core ~2020 km (MESSENGER, Hauck et al. 2013); a solid inner
  // core ~1000 km (Genova et al. 2019).
  Mercury: {
    kind: 'planet',
    layers: [
      { name: 'Crust', outer: 1, color: CRUST, note: 'silicate rock' },
      { name: 'Mantle', outer: 0.986, color: MANTLE, note: 'silicate rock' },
      { name: 'Outer core', outer: 0.83, color: OUTER_CORE, note: 'liquid iron' },
      { name: 'Inner core', outer: 0.41, color: INNER_CORE, note: 'solid iron' },
    ],
  },
  // Mean radius 6052 km; crust ~30 km; core radius ~3000 km (model estimates, no seismic data).
  Venus: {
    kind: 'planet',
    layers: [
      { name: 'Crust', outer: 1, color: CRUST, note: 'basaltic rock' },
      { name: 'Mantle', outer: 0.995, color: MANTLE, note: 'silicate rock' },
      { name: 'Core', outer: 0.5, color: OUTER_CORE, note: 'iron and nickel' },
    ],
  },
  // Mean radius 6371 km; crust ~35 km (continental average); core–mantle boundary at 3480 km;
  // inner core 1221 km (PREM, Dziewonski & Anderson 1981).
  Earth: {
    kind: 'planet',
    layers: [
      { name: 'Crust', outer: 1, color: CRUST, note: 'granite and basalt' },
      { name: 'Mantle', outer: 0.995, color: MANTLE, note: 'hot silicate rock' },
      { name: 'Outer core', outer: 0.546, color: OUTER_CORE, note: 'liquid iron and nickel' },
      { name: 'Inner core', outer: 0.192, color: INNER_CORE, note: 'solid iron and nickel' },
    ],
  },
  // Mean radius 1737 km; crust ~40 km (GRAIL, Wieczorek et al. 2013); partial-melt layer 480 km,
  // fluid outer core 330 km, solid inner core 240 km (Apollo seismic data, Weber et al. 2011).
  Moon: {
    kind: 'moon',
    layers: [
      { name: 'Crust', outer: 1, color: CRUST, note: 'anorthosite rock' },
      { name: 'Mantle', outer: 0.977, color: MANTLE, note: 'silicate rock' },
      { name: 'Partial melt', outer: 0.276, color: '#e2763a', note: 'partly molten rock' },
      { name: 'Outer core', outer: 0.19, color: OUTER_CORE, note: 'liquid iron' },
      { name: 'Inner core', outer: 0.138, color: INNER_CORE, note: 'solid iron' },
    ],
  },
  // Mean radius 3390 km; crust ~24–72 km (InSight, Knapmeyer-Endrun et al. 2021); liquid core
  // ~1830 km (InSight, Stähler et al. 2021).
  Mars: {
    kind: 'planet',
    layers: [
      { name: 'Crust', outer: 1, color: CRUST, note: 'basaltic rock' },
      { name: 'Mantle', outer: 0.985, color: MANTLE, note: 'silicate rock' },
      { name: 'Core', outer: 0.54, color: OUTER_CORE, note: 'liquid iron with sulphur' },
    ],
  },
  // Molecular hydrogen gives way to metallic hydrogen at ~0.8 of the radius; Juno's gravity data
  // point to a dilute heavy-element core (Wahl et al. 2017; Militzer et al. 2022).
  Jupiter: {
    kind: 'planet',
    layers: [
      {
        name: 'Molecular hydrogen',
        outer: 1,
        color: '#dcc7a0',
        note: 'hydrogen and helium gas and liquid',
      },
      {
        name: 'Metallic hydrogen',
        outer: 0.8,
        color: METALLIC_H,
        note: 'liquid metallic hydrogen',
      },
      { name: 'Core', outer: 0.25, color: ROCKY_CORE, note: 'rock, ice and metal, dilute' },
    ],
  },
  // Lower pressure: metallic hydrogen only below ~0.55 of the radius; a diffuse core (ring
  // seismology, Mankovich & Fuller 2021).
  Saturn: {
    kind: 'planet',
    layers: [
      {
        name: 'Molecular hydrogen',
        outer: 1,
        color: '#e3d2a2',
        note: 'hydrogen and helium gas and liquid',
      },
      {
        name: 'Metallic hydrogen',
        outer: 0.55,
        color: METALLIC_H,
        note: 'liquid metallic hydrogen',
      },
      { name: 'Core', outer: 0.22, color: ROCKY_CORE, note: 'rock, ice and metal' },
    ],
  },
  // Ice giants: a hydrogen–helium envelope over a hot fluid "ice" mantle (water, ammonia, methane)
  // and a small rocky core (NASA Uranus and Neptune overviews; Helled et al. 2020).
  Uranus: {
    kind: 'planet',
    layers: [
      {
        name: 'Hydrogen–helium envelope',
        outer: 1,
        color: '#a6dde4',
        note: 'hydrogen, helium, methane',
      },
      { name: 'Ice mantle', outer: 0.8, color: '#3d7fb6', note: 'water, ammonia and methane ices' },
      { name: 'Rocky core', outer: 0.2, color: ROCKY_CORE, note: 'rock and iron' },
    ],
  },
  Neptune: {
    kind: 'planet',
    layers: [
      {
        name: 'Hydrogen–helium envelope',
        outer: 1,
        color: '#7fa6ee',
        note: 'hydrogen, helium, methane',
      },
      {
        name: 'Ice mantle',
        outer: 0.85,
        color: '#2f5fa8',
        note: 'water, ammonia and methane ices',
      },
      { name: 'Rocky core', outer: 0.25, color: ROCKY_CORE, note: 'rock and iron' },
    ],
  },
};

/** The bodies with layer data, by name (for the notes and tests). */
export const CUTAWAY_BODIES = Object.keys(INTERIORS);

/** A body's layers, surface first, or undefined when its interior is not in the table. */
export function cutawayLayers(
  body: Pick<Body, 'kind' | 'name'> | undefined,
): readonly Layer[] | undefined {
  if (!body) return undefined;
  const interior = Object.hasOwn(INTERIORS, body.name) ? INTERIORS[body.name] : undefined;
  return interior && interior.kind === body.kind ? interior.layers : undefined;
}

/** Whether a body has a cutaway (layer data). */
export function hasCutaway(body: Pick<Body, 'kind' | 'name'> | undefined): boolean {
  return cutawayLayers(body) !== undefined;
}

/** The thinnest band drawn, as a fraction of the radius (a rocky crust is thinner than this). */
export const MIN_BAND = 0.045;

/**
 * The outer radii the cut draws: the real ones, except that every band is at least `MIN_BAND`
 * thick (a thin crust pushes the boundaries below it inward just enough). Monotonic like the input.
 */
export function displayRadii(layers: readonly Layer[], minBand: number = MIN_BAND): number[] {
  const out: number[] = [];
  for (const [i, layer] of layers.entries()) {
    out.push(i === 0 ? layer.outer : Math.min(layer.outer, out[i - 1]! - minBand));
  }
  return out;
}

/** One sentence for assistive technology: "Earth's layers, from the surface inward: …". */
export function layersDescription(name: string, layers: readonly Layer[]): string {
  const list = layers.map((l) => `${l.name.toLowerCase()} (${l.note})`).join(', ');
  return `${name}'s layers, from the surface inward: ${list}.`;
}
