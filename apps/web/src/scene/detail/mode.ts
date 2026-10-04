import { create } from 'zustand';
import type { Body } from '@galactic/protocol';
import { sceneWorld, useAppStore } from '../../state/store.js';
import { getAnchor } from '../anchors.js';
import { setFocusFraming, useCameraStore } from '../camera/store.js';
import { prefersReducedMotion } from '../motion.js';
import { planetLook } from '../bodies/appearance.js';

/**
 * The scene's mode (P6-01): the solar system, or the **detail view** of one body — a separate
 * sub-scene (`DetailLayer.tsx`) swapped in when the camera comes close to a body, or on an explicit
 * "Detail view" (the breadcrumb's button, a second `Enter` on the focused body). No three.js: the
 * breadcrumb and the scene area's keys read it from the panel's chunk.
 *
 * - `mode`: `system`, or `detail` of `bodyId`. It changes at once on enter and exit; the picture
 *   follows it with a cross-fade (`fade`, `detailMix`) — the system meshes of the body give way to
 *   the sub-scene's at the same place and size, and a backdrop fades in over the rest of the system.
 * - `shown`: the body the sub-scene draws — the detail body, and while leaving it the body being
 *   left, until the fade out ends (then the sub-scene unmounts and frees what it holds).
 * - `covered`: the fade in has ended: the backdrop hides the rest of the system, which is then not
 *   drawn at all (`DetailLayer`'s parts and the system components read it).
 *
 * The zoom thresholds (`zoomStep`) are in body radii (the anchor's visual radius, rings included,
 * like the camera's framing): the camera enters when it is focused on a body, not flying, and
 * closer than `ENTER_RADII`; it leaves past `EXIT_RADII` (hysteresis). The camera's system framing
 * is ≈ 8.5 radii (`framingDistance`), so the system view of a focused body never enters by itself;
 * an explicit enter flies to `DETAIL_FRAME_RADII`.
 *
 * Not in the URL: like the camera's focus, it is a way of looking, not a selection (decision 53's
 * URL holds the selection only). A reload opens the system view.
 */
export const ENTER_RADII = 3;
export const EXIT_RADII = 4.5;
/** Where an explicit enter (and any flight to the detail body while in the detail view) ends. */
export const DETAIL_FRAME_RADII = 2.4;
/** Cross-fade lengths, seconds; 0 under reduced motion (an instant switch). */
export const ENTER_FADE_S = 0.9;
export const EXIT_FADE_S = 0.7;

export type SceneMode = { kind: 'system' } | { kind: 'detail'; bodyId: string };

/** The four sub-scene components (`DetailScene.tsx`). */
export type DetailKind = 'rocky' | 'giant' | 'moon' | 'asteroid';

/** A running cross-fade of the mix (0 = system, 1 = detail), on the `performance.now()` clock in s. */
export interface Fade {
  from: number;
  to: number;
  startedAt: number;
  duration: number;
}

export interface DetailState {
  mode: SceneMode;
  shown: string | undefined;
  fade: Fade | undefined;
  covered: boolean;
  /**
   * Whether zooming in may enter. An explicit exit leaves the camera inside `ENTER_RADII` until
   * its flight out starts: zooming re-arms only once the camera has been past `EXIT_RADII`.
   */
  zoomArmed: boolean;
  /**
   * Enters the detail view of `bodyId` (a planet, moon or asteroid that is drawn). `fly`
   * (default true): the camera flies to `DETAIL_FRAME_RADII`; a zoom entry passes false (the user
   * drives). False when nothing changes.
   */
  enter: (bodyId: string, opts?: TransitionOpts) => boolean;
  /**
   * Back to the system view. `fly` (default true): the camera flies back to the body's system
   * framing; false when the camera is already going somewhere (a focus change, the overview, a
   * zoom out). False when already in the system view.
   */
  exit: (opts?: TransitionOpts) => boolean;
  /** From the canvas: the running fade reached its end. */
  settle: () => void;
  /** Zooming may enter again (the camera has been past `EXIT_RADII`). */
  arm: () => void;
  /** The canvas went away (the scene hidden, a lost context): back to the system view at once. */
  reset: () => void;
}

export interface TransitionOpts {
  fly?: boolean;
  /** Seconds on the `performance.now()` clock (tests). */
  now?: number;
  /** Overrides the system preference (tests). */
  reducedMotion?: boolean;
}

const nowSeconds = () => performance.now() / 1000;

const SYSTEM: SceneMode = { kind: 'system' };

export const useDetailStore = create<DetailState>((set, get) => ({
  mode: SYSTEM,
  shown: undefined,
  fade: undefined,
  covered: false,
  zoomArmed: true,
  enter: (bodyId, opts = {}) => {
    const s = get();
    if (s.mode.kind === 'detail' && s.mode.bodyId === bodyId) return false;
    if (!detailableBody(bodyId)) return false;
    const now = opts.now ?? nowSeconds();
    const reduced = opts.reducedMotion ?? prefersReducedMotion();
    // Entering again the body still fading out continues from where the picture is.
    const from = s.shown === bodyId ? detailMix(s, now) : 0;
    set({
      mode: { kind: 'detail', bodyId },
      shown: bodyId,
      fade: reduced ? undefined : fadeTo(from, 1, now, ENTER_FADE_S),
      covered: reduced,
      zoomArmed: true,
    });
    if (opts.fly !== false) useCameraStore.getState().flyTo(bodyId);
    return true;
  },
  exit: (opts = {}) => {
    const s = get();
    if (s.mode.kind !== 'detail') return false;
    const bodyId = s.mode.bodyId;
    const now = opts.now ?? nowSeconds();
    const reduced = opts.reducedMotion ?? prefersReducedMotion();
    const from = detailMix(s, now);
    const fly = opts.fly !== false;
    set({
      mode: SYSTEM,
      shown: reduced || from <= 0 ? undefined : bodyId,
      fade: reduced || from <= 0 ? undefined : fadeTo(from, 0, now, EXIT_FADE_S),
      covered: false,
      zoomArmed: !fly,
    });
    // The mode is the system's now: the flight ends at the body's system framing.
    if (fly) useCameraStore.getState().flyTo(bodyId);
    return true;
  },
  settle: () => {
    const { fade } = get();
    if (!fade) return;
    if (fade.to <= 0) set({ fade: undefined, shown: undefined, covered: false });
    else set({ fade: undefined, covered: true });
  },
  arm: () => {
    if (!get().zoomArmed) set({ zoomArmed: true });
  },
  reset: () =>
    set({ mode: SYSTEM, shown: undefined, fade: undefined, covered: false, zoomArmed: true }),
}));

/** A fade over `full` seconds for the whole way, shortened for the part already done. */
function fadeTo(from: number, to: number, now: number, full: number): Fade | undefined {
  const duration = full * Math.abs(to - from);
  return duration <= 0 ? undefined : { from, to, startedAt: now, duration };
}

/** Smoothstep: the fade starts and ends gently. */
function ease(t: number): number {
  return t * t * (3 - 2 * t);
}

/** How far the picture is in the detail view at `now`: 0 the system, 1 the detail sub-scene. */
export function detailMix(s: Pick<DetailState, 'mode' | 'fade'>, now: number): number {
  const f = s.fade;
  if (!f) return s.mode.kind === 'detail' ? 1 : 0;
  const t = f.duration <= 0 ? 1 : Math.min(1, Math.max(0, (now - f.startedAt) / f.duration));
  return f.from + (f.to - f.from) * ease(t);
}

/** Whether the running fade has reached its end at `now` (or there is none). */
export function fadeDone(s: Pick<DetailState, 'fade'>, now: number): boolean {
  const f = s.fade;
  return !f || now - f.startedAt >= f.duration;
}

/** The detail body, while the detail view is on (not while it fades out). */
export function detailBodyId(): string | undefined {
  const { mode } = useDetailStore.getState();
  return mode.kind === 'detail' ? mode.bodyId : undefined;
}

// The camera's flights to the detail body keep the detail framing (a click on the body, the
// panel's selection of its agent, the scale toggle's re-framing), so they never fly out of it.
setFocusFraming((bodyId) => (detailBodyId() === bodyId ? DETAIL_FRAME_RADII : undefined));

/**
 * Which sub-scene a body gets: planets by their surface (gas and ice giants → `giant`, rocky,
 * Earth-like and cloudy → `rocky`), moons, asteroids; `undefined` for the Sun (no detail view).
 */
export function detailKind(body: Pick<Body, 'kind' | 'name'> | undefined): DetailKind | undefined {
  if (!body) return undefined;
  if (body.kind === 'moon') return 'moon';
  if (body.kind === 'asteroid') return 'asteroid';
  if (body.kind !== 'planet') return undefined;
  const style = planetLook(body.name).style;
  return style === 'gas' || style === 'ice' ? 'giant' : 'rocky';
}

/** Whether `bodyId` can be shown in detail: drawn (it has an anchor) and not the Sun. */
export function detailableBody(bodyId: string): boolean {
  const anchor = getAnchor(bodyId);
  return anchor !== undefined && anchor.kind !== 'star';
}

/**
 * The bodies that belong to a detail view (P6-01): what stays pickable, labelled and marked by
 * beacons while it is on, all inside its backdrop. A planet: itself and its moons; a moon: itself,
 * its planet and that planet's other moons; an asteroid: itself.
 */
export function detailScope(
  bodies: Readonly<Record<string, Body>>,
  bodyId: string,
): ReadonlySet<string> {
  const body = bodies[bodyId];
  const scope = new Set([bodyId]);
  const system =
    body?.kind === 'moon' ? body.parentId : body?.kind === 'planet' ? bodyId : undefined;
  if (system) {
    scope.add(system);
    for (const b of Object.values(bodies))
      if (b.kind === 'moon' && b.parentId === system) scope.add(b.id);
  }
  return scope;
}

let scopeCache:
  | { bodies: Readonly<Record<string, Body>>; bodyId: string; scope: ReadonlySet<string> }
  | undefined;

/** The detail view's scope now (`detailScope` over the scene's world), `undefined` in the system view. */
export function currentDetailScope(): ReadonlySet<string> | undefined {
  const bodyId = detailBodyId();
  if (bodyId === undefined) return undefined;
  const bodies = sceneWorld(useAppStore.getState()).bodies;
  if (scopeCache?.bodies !== bodies || scopeCache.bodyId !== bodyId)
    scopeCache = { bodies, bodyId, scope: detailScope(bodies, bodyId) };
  return scopeCache.scope;
}

/** Whether a body takes part in the scene now: every body in the system view; the scope in detail. */
export function inDetailScope(bodyId: string | undefined): boolean {
  const scope = currentDetailScope();
  return scope === undefined || (bodyId !== undefined && scope.has(bodyId));
}

/** What the zoom watcher sees each frame (`DetailLayer`). */
export interface ZoomView {
  mode: SceneMode;
  zoomArmed: boolean;
  /** The camera's focus (`useCameraStore`). */
  focusedId: string | undefined;
  flying: boolean;
  /**
   * The camera's distance in body radii from the detail body (detail view) or the focused body
   * (system view); `undefined` when that body is not drawn.
   */
  distance: number | undefined;
  /** Whether the focused body can be shown in detail (system view). */
  detailable: boolean;
}

/**
 * The zoom rules (P6-01), one frame at a time:
 * - in the detail view, leave when its body is gone, when the camera's focus moved to another
 *   body, or — not during a flight — when the camera is farther than `EXIT_RADII`;
 * - in the system view, re-arm once the camera has been farther than `EXIT_RADII`, and enter when
 *   armed, focused on a detailable body, not flying, and closer than `ENTER_RADII`.
 */
export function zoomStep(v: ZoomView): 'enter' | 'exit' | 'arm' | undefined {
  if (v.mode.kind === 'detail') {
    if (v.distance === undefined) return 'exit';
    if (v.focusedId !== undefined && v.focusedId !== v.mode.bodyId) return 'exit';
    if (v.flying) return undefined;
    return v.distance > EXIT_RADII ? 'exit' : undefined;
  }
  if (v.focusedId === undefined || v.distance === undefined) return undefined;
  if (!v.zoomArmed) return v.distance > EXIT_RADII ? 'arm' : undefined;
  if (v.flying || !v.detailable) return undefined;
  return v.distance < ENTER_RADII ? 'enter' : undefined;
}

/** Applies a `zoomStep` result. */
export function applyZoomStep(step: ReturnType<typeof zoomStep>, focusedId: string | undefined) {
  const s = useDetailStore.getState();
  if (step === 'exit') s.exit({ fly: false });
  else if (step === 'arm') s.arm();
  else if (step === 'enter' && focusedId) s.enter(focusedId, { fly: false });
}

/**
 * Leaves the detail view when the camera is sent elsewhere — the overview (`Home`, "Solar
 * system"), or a flight to another body (a pick, `]` / `[`, a selection in the panel) — so the
 * fade out runs with that flight. Returns the unsubscribe; the canvas binds it while mounted.
 */
export function bindCameraToDetail(): () => void {
  return useCameraStore.subscribe((camera, prev) => {
    const request = camera.request;
    if (!request || request === prev.request) return;
    const s = useDetailStore.getState();
    if (s.mode.kind !== 'detail') return;
    if (request.kind === 'overview' || request.bodyId !== s.mode.bodyId) s.exit({ fly: false });
  });
}

/** One crumb of the scene's breadcrumb (`camera/Breadcrumb.tsx`). */
export type Crumb =
  | { kind: 'system'; label: string; current: boolean }
  | { kind: 'body'; bodyId: string; label: string; current: boolean; leavesDetail: boolean }
  | { kind: 'detail'; label: string };

/** The detail crumb's text: "Solar system › Jupiter › Detail". */
export const DETAIL_CRUMB = 'Detail';

/**
 * The breadcrumb: "Solar system › Jupiter › Europa" in the system view (P3-04), with "› Detail"
 * in the detail view, where the body's own crumb leaves the detail view (and stays on the body).
 * In the detail view the trail follows the detail body, not the camera's focus (the user may have
 * panned off it).
 */
export function breadcrumbTrail(
  bodies: Readonly<Record<string, Pick<Body, 'name' | 'parentId'>>>,
  focusedId: string | undefined,
  mode: SceneMode,
  nameOf: (bodyId: string) => string,
): Crumb[] {
  const detail = mode.kind === 'detail';
  const bodyId = detail ? mode.bodyId : focusedId;
  const trail: Crumb[] = [{ kind: 'system', label: 'Solar system', current: bodyId === undefined }];
  if (bodyId === undefined) return trail;
  const parentId = bodies[bodyId]?.parentId;
  if (parentId && bodies[parentId])
    trail.push({
      kind: 'body',
      bodyId: parentId,
      label: nameOf(parentId),
      current: false,
      leavesDetail: false,
    });
  trail.push({
    kind: 'body',
    bodyId,
    label: nameOf(bodyId),
    current: !detail,
    leavesDetail: detail,
  });
  if (detail) trail.push({ kind: 'detail', label: DETAIL_CRUMB });
  return trail;
}

/** The breadcrumb as one line of text (tests, the area's description). */
export function breadcrumbText(trail: readonly Crumb[]): string {
  return trail.map((c) => c.label).join(' › ');
}
