import { Object3D } from 'three';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Body } from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import { allAnchors, getAnchor, registerAnchor, type BodyAnchor } from '../anchors.js';
import { useCameraStore } from '../camera/store.js';
import { pickingWorld } from '../picking/fixtures.js';
import {
  bindCameraToDetail,
  breadcrumbText,
  breadcrumbTrail,
  currentDetailScope,
  DETAIL_FRAME_RADII,
  detailKind,
  detailMix,
  detailScope,
  ENTER_FADE_S,
  ENTER_RADII,
  EXIT_FADE_S,
  EXIT_RADII,
  fadeDone,
  inDetailScope,
  radiiFrom,
  settleDue,
  useDetailStore,
  zoomStep,
  type SceneMode,
  type ZoomView,
} from './mode.js';

const SYSTEM: SceneMode = { kind: 'system' };
const detailOf = (bodyId: string): SceneMode => ({ kind: 'detail', bodyId });

function anchor(bodyId: string, kind: BodyAnchor['kind'], x: number, radius = 1) {
  const object = new Object3D();
  object.position.set(x, 0, 0);
  return registerAnchor({ bodyId, kind, object, radius });
}

let unregister: (() => void)[] = [];

beforeEach(() => {
  useAppStore.setState({ world: pickingWorld(), replayWorld: undefined });
  unregister = [
    anchor('b-sun', 'star', 0, 6),
    anchor('b-earth', 'planet', 40, 1.7),
    anchor('b-moon', 'moon', 44, 0.5),
    anchor('b-jupiter', 'planet', 100, 4.5),
    anchor('b-io', 'moon', 106, 0.4),
    anchor('b-ast-7', 'asteroid', 60, 1.1),
  ];
  useDetailStore.getState().reset();
  useCameraStore.setState({ focusedId: undefined, flying: false, request: undefined });
});
afterEach(() => {
  unregister.forEach((u) => u());
  useDetailStore.getState().reset();
});

describe('zoom thresholds (zoomStep)', () => {
  const view = (v: Partial<ZoomView>): ZoomView => ({
    mode: SYSTEM,
    zoomArmed: true,
    focusedId: 'b-jupiter',
    flying: false,
    distance: 8.5,
    detailable: true,
    ...v,
  });

  it('enters only when focused on a detailable body, armed, not flying, closer than ENTER_RADII', () => {
    expect(zoomStep(view({ distance: ENTER_RADII - 0.01 }))).toBe('enter');
    expect(zoomStep(view({ distance: ENTER_RADII + 0.01 }))).toBeUndefined();
    expect(zoomStep(view({ distance: 2, flying: true }))).toBeUndefined();
    expect(zoomStep(view({ distance: 2, detailable: false }))).toBeUndefined(); // the Sun
    expect(zoomStep(view({ distance: 2, focusedId: undefined }))).toBeUndefined();
    expect(zoomStep(view({ distance: 2, zoomArmed: false }))).toBeUndefined();
  });

  it('has hysteresis: in detail the camera may go back out to EXIT_RADII without leaving', () => {
    expect(EXIT_RADII).toBeGreaterThan(ENTER_RADII);
    expect(DETAIL_FRAME_RADII).toBeLessThan(ENTER_RADII);
    const inside = view({ mode: detailOf('b-jupiter') });
    for (const d of [1.5, DETAIL_FRAME_RADII, ENTER_RADII, ENTER_RADII + 1, EXIT_RADII])
      expect(zoomStep({ ...inside, distance: d })).toBeUndefined();
    expect(zoomStep({ ...inside, distance: EXIT_RADII + 0.01 })).toBe('exit');
    // A flight in (explicit enter) or out never trips the threshold.
    expect(zoomStep({ ...inside, distance: 8, flying: true })).toBeUndefined();
  });

  it('leaves the detail view when its body is gone or the focus moved to another body', () => {
    const inside = view({ mode: detailOf('b-jupiter'), distance: 2 });
    expect(zoomStep({ ...inside, distance: undefined })).toBe('exit');
    expect(zoomStep({ ...inside, focusedId: 'b-io', flying: true })).toBe('exit');
    // Panned off the body (no focus): stays while close enough.
    expect(zoomStep({ ...inside, focusedId: undefined })).toBeUndefined();
  });

  it('re-arms only once the camera has been past EXIT_RADII', () => {
    const disarmed = view({ zoomArmed: false });
    expect(zoomStep({ ...disarmed, distance: 2 })).toBeUndefined();
    expect(zoomStep({ ...disarmed, distance: EXIT_RADII - 0.1 })).toBeUndefined();
    expect(zoomStep({ ...disarmed, distance: EXIT_RADII + 0.1 })).toBe('arm');
    expect(zoomStep({ ...disarmed, distance: EXIT_RADII + 0.1, flying: true })).toBe('arm');
  });
});

describe('the mode store', () => {
  it('enters with a cross-fade and a flight to the detail framing; settles covered', () => {
    const s = useDetailStore.getState();
    expect(s.enter('b-jupiter', { now: 10, reducedMotion: false })).toBe(true);
    const after = useDetailStore.getState();
    expect(after.mode).toEqual(detailOf('b-jupiter'));
    expect(after.shown).toBe('b-jupiter');
    expect(after.covered).toBe(false);
    expect(after.fade).toEqual({ from: 0, to: 1, startedAt: 10, duration: ENTER_FADE_S });
    expect(detailMix(after, 10)).toBe(0);
    expect(detailMix(after, 10 + ENTER_FADE_S / 2)).toBeCloseTo(0.5);
    expect(detailMix(after, 20)).toBe(1);
    expect(fadeDone(after, 10 + ENTER_FADE_S - 0.01)).toBe(false);
    expect(fadeDone(after, 10 + ENTER_FADE_S)).toBe(true);
    const camera = useCameraStore.getState();
    expect(camera.focusedId).toBe('b-jupiter');
    expect(camera.request).toMatchObject({
      kind: 'focus',
      bodyId: 'b-jupiter',
      radii: DETAIL_FRAME_RADII,
    });
    after.settle();
    expect(useDetailStore.getState()).toMatchObject({ fade: undefined, covered: true });
  });

  it('a zoom entry does not fly (the user drives)', () => {
    useDetailStore.getState().enter('b-jupiter', { fly: false, now: 0, reducedMotion: false });
    expect(useCameraStore.getState().request).toBeUndefined();
  });

  it('refuses the Sun, an undrawn body, and the body already shown', () => {
    const s = useDetailStore.getState();
    expect(s.enter('b-sun')).toBe(false);
    expect(s.enter('b-nowhere')).toBe(false);
    expect(s.enter('b-earth', { now: 0, reducedMotion: false })).toBe(true);
    expect(useDetailStore.getState().enter('b-earth')).toBe(false);
  });

  it('exits with the reverse fade and a flight back to the system framing', () => {
    const s = useDetailStore.getState();
    s.enter('b-jupiter', { now: 0, reducedMotion: false });
    useDetailStore.getState().settle();
    expect(useDetailStore.getState().exit({ now: 5, reducedMotion: false })).toBe(true);
    const after = useDetailStore.getState();
    expect(after.mode).toEqual(SYSTEM);
    expect(after.shown).toBe('b-jupiter'); // still drawn while it fades out
    expect(after.covered).toBe(false);
    expect(after.fade).toEqual({ from: 1, to: 0, startedAt: 5, duration: EXIT_FADE_S });
    expect(after.zoomArmed).toBe(false);
    // The mode is the system's when the flight is asked for: no detail framing.
    const request = useCameraStore.getState().request;
    expect(request).toMatchObject({ kind: 'focus', bodyId: 'b-jupiter' });
    expect(request).not.toHaveProperty('radii');
    after.settle();
    expect(useDetailStore.getState()).toMatchObject({ shown: undefined, fade: undefined });
    expect(useDetailStore.getState().exit()).toBe(false);
  });

  it('a zoom exit stays armed and does not fly', () => {
    useDetailStore.getState().enter('b-jupiter', { now: 0, reducedMotion: false, fly: false });
    useDetailStore.getState().exit({ fly: false, now: 1, reducedMotion: false });
    expect(useDetailStore.getState().zoomArmed).toBe(true);
    expect(useCameraStore.getState().request).toBeUndefined();
  });

  it('reverses a running fade from where the picture is', () => {
    useDetailStore.getState().enter('b-jupiter', { now: 0, reducedMotion: false });
    const half = ENTER_FADE_S / 2;
    useDetailStore.getState().exit({ now: half, reducedMotion: false, fly: false });
    const out = useDetailStore.getState().fade!;
    expect(out.from).toBeCloseTo(0.5);
    expect(out.duration).toBeCloseTo(EXIT_FADE_S * 0.5);
    // …and back in again, from the same point.
    useDetailStore.getState().enter('b-jupiter', { now: half, reducedMotion: false });
    expect(useDetailStore.getState().fade!.from).toBeCloseTo(0.5);
  });

  it('switches at once under reduced motion (covered once the camera is in place)', () => {
    useDetailStore.getState().enter('b-jupiter', { now: 0, reducedMotion: true });
    expect(useDetailStore.getState()).toMatchObject({ fade: undefined, covered: false });
    expect(detailMix(useDetailStore.getState(), 0)).toBe(1);
    // The camera's (instant) flight has not run yet: not settled.
    expect(settleDue(useDetailStore.getState(), 0, { flying: true, distance: 8.5 })).toBe(false);
    expect(settleDue(useDetailStore.getState(), 0, { flying: false, distance: 2.4 })).toBe(true);
    useDetailStore.getState().settle();
    expect(useDetailStore.getState()).toMatchObject({ fade: undefined, covered: true });
    expect(settleDue(useDetailStore.getState(), 0, { flying: false, distance: 2.4 })).toBe(false);
    useDetailStore.getState().exit({ now: 0, reducedMotion: true });
    expect(useDetailStore.getState()).toMatchObject({
      mode: SYSTEM,
      shown: undefined,
      fade: undefined,
      covered: false,
    });
  });

  it('keeps the detail framing for any flight to the detail body (a click on it, a re-frame)', () => {
    useDetailStore.getState().enter('b-jupiter', { now: 0, reducedMotion: false, fly: false });
    useCameraStore.getState().flyTo('b-jupiter');
    expect(useCameraStore.getState().request).toMatchObject({ radii: DETAIL_FRAME_RADII });
    useCameraStore.getState().flyTo('b-io');
    expect(useCameraStore.getState().request).not.toHaveProperty('radii');
  });

  it('never changes the selection', () => {
    const selection = { kind: 'waykeeper', id: 'a-way-1' } as const;
    useAppStore.setState({ selection });
    useDetailStore.getState().enter('b-jupiter', { now: 0, reducedMotion: false });
    useDetailStore.getState().exit({ now: 1, reducedMotion: false });
    expect(useAppStore.getState().selection).toBe(selection);
  });
});

describe('leaving when the camera is sent elsewhere (bindCameraToDetail)', () => {
  it('the overview or a flight to another body leaves; a flight to the body itself does not', () => {
    const stop = bindCameraToDetail();
    try {
      useDetailStore.getState().enter('b-jupiter', { now: 0, reducedMotion: false });
      expect(useDetailStore.getState().mode.kind).toBe('detail');
      useCameraStore.getState().flyTo('b-jupiter');
      expect(useDetailStore.getState().mode.kind).toBe('detail');
      useCameraStore.getState().flyTo('b-io');
      expect(useDetailStore.getState().mode).toEqual(SYSTEM);
      // No flight of its own: the camera is already going to Io.
      expect(useCameraStore.getState().request).toMatchObject({ bodyId: 'b-io' });

      useDetailStore.getState().enter('b-earth', { now: 0, reducedMotion: true });
      useCameraStore.getState().back();
      expect(useDetailStore.getState().mode).toEqual(SYSTEM);
      expect(useCameraStore.getState().request).toMatchObject({ kind: 'overview' });
    } finally {
      stop();
    }
  });
});

describe('detail kinds and scope', () => {
  const body = (b: Partial<Body> & Pick<Body, 'kind' | 'name'>): Body => ({ id: 'x', ...b });

  it('gives each body kind its sub-scene; the Sun has none', () => {
    expect(detailKind(body({ kind: 'planet', name: 'Mars' }))).toBe('rocky');
    expect(detailKind(body({ kind: 'planet', name: 'Earth' }))).toBe('rocky');
    expect(detailKind(body({ kind: 'planet', name: 'Venus' }))).toBe('rocky');
    expect(detailKind(body({ kind: 'planet', name: 'Jupiter' }))).toBe('giant');
    expect(detailKind(body({ kind: 'planet', name: 'Neptune' }))).toBe('giant');
    expect(detailKind(body({ kind: 'planet', name: 'Demo planet 1' }))).toBe('rocky');
    expect(detailKind(body({ kind: 'moon', name: 'Europa' }))).toBe('moon');
    expect(detailKind(body({ kind: 'asteroid', name: '7 Iris' }))).toBe('asteroid');
    expect(detailKind(body({ kind: 'star', name: 'Sun' }))).toBeUndefined();
    expect(detailKind(undefined)).toBeUndefined();
  });

  it('a planet with its moons; a moon with its planet and siblings; an asteroid alone', () => {
    const bodies = pickingWorld().bodies;
    expect([...detailScope(bodies, 'b-jupiter')].sort()).toEqual(['b-io', 'b-jupiter']);
    expect([...detailScope(bodies, 'b-io')].sort()).toEqual(['b-io', 'b-jupiter']);
    expect([...detailScope(bodies, 'b-moon')].sort()).toEqual(['b-earth', 'b-moon']);
    expect([...detailScope(bodies, 'b-ast-7')]).toEqual(['b-ast-7']);
  });

  it('every body is in scope in the system view, only the scope in detail', () => {
    expect(currentDetailScope()).toBeUndefined();
    expect(inDetailScope('b-mars')).toBe(true);
    useDetailStore.getState().enter('b-jupiter', { now: 0, reducedMotion: true, fly: false });
    expect(inDetailScope('b-io')).toBe(true);
    expect(inDetailScope('b-mars')).toBe(false);
    expect(inDetailScope(undefined)).toBe(false);
    // While the view fades out the scope is the whole system again.
    useDetailStore.getState().exit({ now: 0, reducedMotion: false, fly: false });
    expect(inDetailScope('b-mars')).toBe(true);
  });

  it('reads the scene world: the replayed one during a replay', () => {
    const replay = pickingWorld();
    replay.bodies = {
      ...replay.bodies,
      'b-io': { ...replay.bodies['b-io']!, parentId: 'b-earth' },
    };
    useAppStore.setState({ replayWorld: replay });
    useDetailStore.getState().enter('b-earth', { now: 0, reducedMotion: true, fly: false });
    expect(inDetailScope('b-io')).toBe(true);
    useAppStore.setState({ replayWorld: undefined });
    expect(inDetailScope('b-io')).toBe(false);
  });
});

describe('settling (P6-01 review, S1)', () => {
  const inPlace = { flying: false, distance: DETAIL_FRAME_RADII };

  it('an explicit enter mid-flight covers only once the camera has arrived', () => {
    // "Detail view" on a body the camera is still flying to: the flight (0.8–1.5 s) outlasts the
    // fade (0.9 s).
    useDetailStore.getState().enter('b-jupiter', { now: 0, reducedMotion: false });
    const s = useDetailStore.getState();
    expect(settleDue(s, ENTER_FADE_S / 2, inPlace)).toBe(false); // still fading
    expect(settleDue(s, ENTER_FADE_S, { flying: true, distance: 30 })).toBe(false);
    expect(settleDue(s, 1.2, { flying: true, distance: 3 })).toBe(false);
    // Landed but still outside the view (the watcher exits then anyway): not covered either.
    expect(settleDue(s, 1.5, { flying: false, distance: EXIT_RADII + 0.1 })).toBe(false);
    expect(settleDue(s, 1.5, { flying: false, distance: undefined })).toBe(false);
    expect(settleDue(s, 1.5, inPlace)).toBe(true);
    s.settle();
    expect(useDetailStore.getState()).toMatchObject({ fade: undefined, covered: true });
  });

  it('a fade out ends whatever the camera does', () => {
    useDetailStore.getState().enter('b-jupiter', { now: 0, reducedMotion: false });
    useDetailStore.getState().exit({ now: 0.5, reducedMotion: false });
    const s = useDetailStore.getState();
    expect(settleDue(s, 0.5, { flying: true, distance: 30 })).toBe(false);
    expect(settleDue(s, 0.5 + EXIT_FADE_S, { flying: true, distance: 30 })).toBe(true);
    s.settle();
    expect(useDetailStore.getState()).toMatchObject({ shown: undefined, fade: undefined });
    // Nothing to settle in the system view.
    expect(settleDue(useDetailStore.getState(), 10, inPlace)).toBe(false);
  });

  it('measures the camera in framed radii (the unit the flights land by)', () => {
    expect(radiiFrom([0, 0, 12], [0, 0, 0], 5)).toBeCloseTo(2.4);
    // True scale's moons are smaller than MIN_FRAMED_RADIUS: the camera's unit, not the raw radius.
    expect(radiiFrom([0, 0, 0.12], [0, 0, 0], 0.02)).toBeCloseTo(2.4);
  });
});

describe('anchor registry across modes', () => {
  it('the detail view leaves every system anchor registered', () => {
    const before = allAnchors()
      .map((a) => a.bodyId)
      .sort();
    useDetailStore.getState().enter('b-jupiter', { now: 0, reducedMotion: true });
    expect(
      allAnchors()
        .map((a) => a.bodyId)
        .sort(),
    ).toEqual(before);
    useDetailStore.getState().exit({ now: 0, reducedMotion: true });
    expect(
      allAnchors()
        .map((a) => a.bodyId)
        .sort(),
    ).toEqual(before);
  });

  it('a second registration of an id stands in for the first; removing it restores the first', () => {
    const system = getAnchor('b-io')!;
    const standIn = new Object3D();
    const stop = registerAnchor({ ...system, object: standIn });
    expect(getAnchor('b-io')!.object).toBe(standIn);
    expect(allAnchors().filter((a) => a.bodyId === 'b-io')).toHaveLength(1);
    stop();
    expect(getAnchor('b-io')).toBe(system);
    stop(); // twice: nothing more
    expect(getAnchor('b-io')).toBe(system);
  });

  it('removing the first while a stand-in is on keeps the stand-in', () => {
    const extra = registerAnchor({
      bodyId: 'b-x',
      kind: 'moon',
      object: new Object3D(),
      radius: 1,
    });
    const second = new Object3D();
    const stopSecond = registerAnchor({ bodyId: 'b-x', kind: 'moon', object: second, radius: 1 });
    extra();
    expect(getAnchor('b-x')!.object).toBe(second);
    stopSecond();
    expect(getAnchor('b-x')).toBeUndefined();
  });
});

describe('breadcrumb trail', () => {
  const bodies = pickingWorld().bodies;
  const nameOf = (id: string) => bodies[id]?.name ?? id;
  const text = (focusedId: string | undefined, mode: SceneMode) =>
    breadcrumbText(breadcrumbTrail(bodies, focusedId, mode, nameOf));

  it('system view: where the camera is', () => {
    expect(text(undefined, SYSTEM)).toBe('Solar system');
    expect(text('b-jupiter', SYSTEM)).toBe('Solar system › Jupiter');
    expect(text('b-io', SYSTEM)).toBe('Solar system › Jupiter › Io');
  });

  it('detail view: "› Detail" after the body, whatever the camera focus', () => {
    expect(text('b-jupiter', detailOf('b-jupiter'))).toBe('Solar system › Jupiter › Detail');
    expect(text(undefined, detailOf('b-jupiter'))).toBe('Solar system › Jupiter › Detail');
    expect(text('b-io', detailOf('b-io'))).toBe('Solar system › Jupiter › Io › Detail');
    expect(text(undefined, detailOf('b-ast-7'))).toBe('Solar system › 7 Iris › Detail');
  });

  it("in detail the body's crumb leaves the view; its planet's flies there", () => {
    const trail = breadcrumbTrail(bodies, 'b-io', detailOf('b-io'), nameOf);
    expect(trail[1]).toMatchObject({ kind: 'body', bodyId: 'b-jupiter', leavesDetail: false });
    expect(trail[2]).toMatchObject({
      kind: 'body',
      bodyId: 'b-io',
      leavesDetail: true,
      current: false,
    });
    expect(trail[3]).toEqual({ kind: 'detail', label: 'Detail' });
  });
});
