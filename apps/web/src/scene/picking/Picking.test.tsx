// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createRef } from 'react';
import { Mesh, MeshBasicMaterial, Object3D, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import type { OutlineEffect } from 'postprocessing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAnchor } from '../anchors.js';
import { DECOR_LAYER, showDecor } from '../layers.js';
import { labelEntries, registerLabel, setShown, writePosition } from '../labels/registry.js';
import { useCameraStore } from '../camera/store.js';
import { useAppStore } from '../../state/store.js';
import { HARMONIZER, selectionKey } from '../../state/selection.js';
import { publishSatellites } from '../satellites/registry.js';
import type { SatelliteFrame } from '../satellites/director.js';
import { pickingWorld, satelliteFrame } from './fixtures.js';
import { publishBeacons } from '../beacons/registry.js';
import { question } from '../beacons/fixtures.js';
import { hoverAt, usePickingStore } from './store.js';

/**
 * `Picking` and `OutlineSync` without WebGL: R3F's hooks are replaced by a fake canvas state and a
 * manual frame loop (`frame()`); the intrinsic three elements render as inert DOM placeholders,
 * dressed with the few Object3D fields the highlight rings touch.
 */
const r3f = vi.hoisted(() => ({
  state: undefined as unknown as Record<string, unknown>,
  frames: new Set<(state: unknown) => void>(),
}));

vi.mock('@react-three/fiber', async () => {
  const { useEffect, useRef } = await import('react');
  return {
    useThree: (select: (s: unknown) => unknown) => select(r3f.state),
    useFrame: (callback: (state: unknown) => void) => {
      const latest = useRef(callback);
      latest.current = callback;
      useEffect(() => {
        const run = (s: unknown) => latest.current(s);
        r3f.frames.add(run);
        return () => void r3f.frames.delete(run);
      }, []);
    },
  };
});

const { Picking, OutlineSync, bodySpheres, satelliteSpheres, satellitesDrawn } =
  await import('./Picking.js');

let camera: PerspectiveCamera;
let canvas: HTMLCanvasElement;
let rafs: FrameRequestCallback[] = [];
let unregister: (() => void)[] = [];

function frame(): void {
  // The rings' placeholders get what `HighlightRing` writes to.
  for (const el of document.querySelectorAll<HTMLElement & Record<string, unknown>>('mesh')) {
    el['position'] ??= new Vector3();
    el['quaternion'] ??= new Quaternion();
    el['scale'] ??= new Vector3();
  }
  camera.updateMatrixWorld();
  for (const run of [...r3f.frames]) run(r3f.state);
}

function flushRaf(): void {
  const due = rafs;
  rafs = [];
  act(() => due.forEach((cb) => cb(0)));
}

function anchorAt(bodyId: string, x: number, withMesh = false): Object3D {
  const object = new Object3D();
  object.userData = { bodyId };
  object.position.set(x, 0, 0);
  if (withMesh) object.add(new Mesh(undefined, new MeshBasicMaterial()));
  unregister.push(registerAnchor({ bodyId, kind: 'planet', object, radius: 1 }));
  return object;
}

const pointer = (
  type: 'pointerMove' | 'pointerDown' | 'pointerUp',
  x: number,
  y: number,
  buttons = 0,
) => fireEvent[type](canvas, { clientX: x, clientY: y, buttons, pointerId: 1, button: 0 });

/** A click on the canvas (press and release at the same point). */
function click(x: number, y: number): void {
  pointer('pointerDown', x, y, 1);
  pointer('pointerUp', x, y);
}

/** A body's anchor anywhere (radius in world units; the camera at z 10 sees ≈ 72 px per unit). */
function anchorAtPoint(bodyId: string, at: [number, number, number], radius: number): void {
  const object = new Object3D();
  object.position.set(...at);
  unregister.push(registerAnchor({ bodyId, kind: 'moon', object, radius }));
}

/** A shown label as the projector leaves it: bottom centre at (x, y), `w` × `h`. */
function shownLabel(bodyId: string, x: number, y: number, w = 100, h = 20, priority = 2): void {
  const el = document.createElement('div');
  unregister.push(registerLabel({ bodyId, el, priority, w, h }));
  const entry = [...labelEntries()].find((e) => e.bodyId === bodyId)!;
  writePosition(entry, x, y);
  setShown(entry, true);
}

const selected = () => selectionKey(useAppStore.getState().selection);

beforeEach(() => {
  camera = new PerspectiveCamera(45, 800 / 600, 0.1, 1000);
  camera.position.set(0, 0, 10);
  canvas = document.createElement('canvas');
  document.body.append(canvas);
  r3f.state = {
    gl: { domElement: canvas },
    camera,
    size: { width: 800, height: 600 },
    invalidate: () => {},
    get: () => r3f.state,
  };
  rafs = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => rafs.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => {});
  // React's warnings about the unknown `<mesh>` / `<ringGeometry>` DOM tags.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  useAppStore.setState({ world: pickingWorld(), route: 'panel', selection: HARMONIZER });
  usePickingStore.setState({ hover: undefined, popover: undefined });
  useCameraStore.setState({ focusedId: undefined, request: undefined, flying: false });
});

afterEach(() => {
  cleanup();
  canvas.remove();
  unregister.forEach((u) => u());
  unregister = [];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Picking (canvas side)', () => {
  it('re-picks the hover when the camera moves under a still pointer, not while pressed', () => {
    anchorAt('b-jupiter', 0);
    anchorAt('b-mars', 5);
    render(<Picking />);
    frame();
    pointer('pointerMove', 400, 300);
    flushRaf();
    expect(usePickingStore.getState().hover?.bodyId).toBe('b-jupiter');

    // A frame with the camera still asks for nothing.
    frame();
    expect(rafs).toHaveLength(0);

    // The camera slides over Mars: the label follows without a pointer move.
    camera.position.set(5, 0, 10);
    frame();
    flushRaf();
    expect(usePickingStore.getState().hover?.bodyId).toBe('b-mars');

    // During a press (a drag) the camera's moves do not re-pick.
    pointer('pointerDown', 400, 300, 1);
    camera.position.set(0, 0, 10);
    frame();
    expect(rafs).toHaveLength(0);
  });

  it('closes the popover and clears the hover when the scene goes away', () => {
    const { unmount } = render(<Picking />);
    act(() => {
      usePickingStore.getState().showHere({ x: 1, y: 2 }, ['b-jupiter', 'b-io']);
      usePickingStore.getState().setHover({ bodyId: 'b-io', name: 'Io', others: 0, x: 1, y: 2 });
    });
    unmount();
    expect(usePickingStore.getState()).toMatchObject({ popover: undefined, hover: undefined });
  });

  it("never outlines Earth for the default Harmonizer selection; outlines a Waykeeper's planet", () => {
    anchorAt('b-earth', 0, true);
    const jupiter = anchorAt('b-jupiter', 5, true);
    const set = vi.fn();
    const outline = { current: { selection: { set, clear: vi.fn() } } as unknown as OutlineEffect };
    render(<Picking outline={outline} />);
    frame();
    expect(set).toHaveBeenLastCalledWith([]);
    act(() => useAppStore.getState().select({ kind: 'waykeeper', id: 'a-wk-old' }));
    frame();
    expect(set).toHaveBeenLastCalledWith([jupiter.children[0]]);
    act(() => useAppStore.getState().select(HARMONIZER));
    frame();
    expect(set).toHaveBeenLastCalledWith([]);
  });
});

describe('labels as pick targets (P3-07)', () => {
  // Jupiter far right (x ≈ 762 px); its label drawn over the middle of the canvas.
  beforeEach(() => {
    anchorAt('b-jupiter', 5);
    shownLabel('b-jupiter', 400, 310); // covers x 350–450, y 290–310
  });

  it("a click on a label's rectangle is a click on its body", () => {
    render(<Picking />);
    frame();
    click(420, 300);
    expect(selected()).toBe('waykeeper:a-wk-old');
    expect(useCameraStore.getState().focusedId).toBe('b-jupiter');
  });

  it("a moon under a planet's label stays clickable: a body under the pointer wins", () => {
    anchorAtPoint('b-io', [0, 0, 0], 0.1); // under the label's middle, ≈ 7 px on screen
    render(<Picking />);
    frame();
    click(400, 300);
    expect(useCameraStore.getState().focusedId).toBe('b-io');
    // Beside the moon, still on the label: the label's body.
    click(445, 295);
    expect(useCameraStore.getState().focusedId).toBe('b-jupiter');
  });

  it('a drag that starts on a label selects nothing (decision 65)', () => {
    render(<Picking />);
    frame();
    pointer('pointerDown', 420, 300, 1);
    pointer('pointerMove', 470, 330, 1);
    pointer('pointerUp', 470, 330);
    expect(selected()).toBe('harmonizer');
    expect(useCameraStore.getState().focusedId).toBeUndefined();
  });

  it('hovering a label hovers its body; a hidden label is no target', () => {
    render(<Picking />);
    frame();
    pointer('pointerMove', 420, 300);
    flushRaf();
    expect(usePickingStore.getState().hover).toMatchObject({ bodyId: 'b-jupiter', others: 0 });
    expect(canvas.style.cursor).toBe('pointer');
    setShown(
      [...labelEntries()].find((e) => e.bodyId === 'b-jupiter')!,
      false,
    );
    pointer('pointerMove', 421, 300);
    flushRaf();
    expect(usePickingStore.getState().hover).toBeUndefined();
    click(420, 300);
    expect(useCameraStore.getState().focusedId).toBeUndefined();
  });
});

describe('satellites as pick targets (P4-08)', () => {
  // The camera at z 10 sees ≈ 72 px per world unit at z 0 (≈ 90 at z 2); (0, 0) is (400, 300).
  let frames: Map<string, SatelliteFrame>;
  const publish = (...list: SatelliteFrame[]) => {
    frames = new Map(list.map((f) => [f.agentId, f]));
    publishSatellites(frames);
  };
  afterEach(() => publishSatellites(new Map()));
  const hover = () => usePickingStore.getState().hover;

  it('a satellite in front of its planet is hovered, not the planet; the card sits on it', () => {
    anchorAt('b-jupiter', 0); // 72 px of radius: clearly a target
    publish(satelliteFrame('a-st-in', 'b-jupiter', [0.2, 0, 2]));
    render(<Picking />);
    frame();
    pointer('pointerMove', 420, 302);
    flushRaf();
    expect(hover()).toMatchObject({ kind: 'satellite', agentId: 'a-st-in', mode: 'orbiting' });
    expect(hoverAt().x).toBeCloseTo(418, -0.5);
    expect(hoverAt().y).toBe(300);
    expect(canvas.style.cursor).toBe('pointer');
    // Off the satellite, on the planet: the planet.
    pointer('pointerMove', 400, 350);
    flushRaf();
    expect(hover()).toMatchObject({ bodyId: 'b-jupiter' });
  });

  it('follows the satellite as it orbits under a still pointer, and its mode', () => {
    anchorAt('b-jupiter', 0);
    publish(satelliteFrame('a-st-in', 'b-jupiter', [0, 0, 2]));
    render(<Picking />);
    frame();
    pointer('pointerMove', 400, 300);
    flushRaf();
    expect(hover()).toMatchObject({ kind: 'satellite' });
    expect(hoverAt()).toEqual({ x: 400, y: 300 });
    // The director moves the frame in place; the camera stays still.
    const f = frames.get('a-st-in')!;
    f.position[0] = 0.04;
    f.mode = 'scanning';
    frame();
    flushRaf();
    expect(hover()).toMatchObject({ kind: 'satellite', mode: 'scanning' });
    expect(hoverAt().x).toBeGreaterThan(402);
    // It orbits away from the pointer, which moves on: the planet behind it is hovered again.
    f.position[0] = 0.5;
    frame();
    pointer('pointerMove', 400, 330);
    flushRaf();
    expect(hover()).toMatchObject({ bodyId: 'b-jupiter' });
  });

  it('a satellite behind its planet is hidden by it', () => {
    anchorAt('b-jupiter', 0);
    publish(satelliteFrame('a-st-in', 'b-jupiter', [0, 0, -2]));
    render(<Picking />);
    frame();
    pointer('pointerMove', 400, 300);
    flushRaf();
    expect(hover()).toMatchObject({ bodyId: 'b-jupiter' });
    click(400, 300);
    expect(selected()).toBe('waykeeper:a-wk-old');
  });

  it("a click selects the satellite's agent and flies to its body; a drag selects nothing", () => {
    anchorAt('b-jupiter', 0);
    publish(satelliteFrame('a-st-in', 'b-jupiter', [0, 0, 2]));
    render(<Picking />);
    frame();
    pointer('pointerDown', 400, 300, 1);
    pointer('pointerMove', 450, 330, 1);
    pointer('pointerUp', 450, 330);
    expect(selected()).toBe('harmonizer');
    expect(useCameraStore.getState().focusedId).toBeUndefined();
    click(400, 300);
    expect(selected()).toBe('steward:a-st-in');
    expect(useCameraStore.getState().focusedId).toBe('b-jupiter');
  });

  it('a satellite under the pointer wins over a label covering it', () => {
    anchorAt('b-jupiter', 5);
    shownLabel('b-jupiter', 400, 310); // covers x 350–450, y 290–310
    publish(satelliteFrame('a-st', 'b-ast-7', [0, 0, 0]));
    render(<Picking />);
    frame();
    pointer('pointerMove', 402, 300);
    flushRaf();
    expect(hover()).toMatchObject({ kind: 'satellite', agentId: 'a-st' });
    click(402, 300);
    expect(selected()).toBe('steward:a-st');
    // Beside the satellite, still on the label: the label's body.
    click(440, 300);
    expect(useCameraStore.getState().focusedId).toBe('b-jupiter');
  });

  it('a speck of a body and satellites under the pointer: "what\'s here" lists them all', () => {
    anchorAtPoint('b-mars', [0, 0, 0], 0.02); // ≈ 1.5 px: a speck
    publish(
      satelliteFrame('a-st', 'b-mars', [0.04, 0, 0]),
      satelliteFrame('a-wk-old', 'b-mars', [-0.03, 0, 0], { role: 'waykeeper' }),
    );
    render(<Picking />);
    frame();
    pointer('pointerMove', 400, 300);
    flushRaf();
    // The hover names the planet, which stands still, "+2" — not a satellite (review item 1).
    expect(hover()).toMatchObject({ bodyId: 'b-mars', others: 2 });
    const named = hover();
    // The satellites orbit and swap places around the pointer: the hover does not flicker.
    const [st, wk] = [frames.get('a-st')!, frames.get('a-wk-old')!];
    st.position[0] = -0.03;
    wk.position[0] = 0.04;
    frame();
    expect(hover()).toBe(named);
    click(400, 300);
    const popover = usePickingStore.getState().popover;
    expect(popover).toMatchObject({
      kind: 'here',
      bodies: [{ bodyId: 'b-mars', name: 'Mars' }],
      satellites: [
        { agentId: 'a-wk-old', name: 'Waykeeper · Big project' },
        { agentId: 'a-st', name: 'Steward · Fix the date test' },
      ],
    });
    expect(selected()).toBe('harmonizer');
  });

  it('a click on a satellite that orbited out from under the pointer still selects it', () => {
    anchorAt('b-jupiter', 0);
    publish(satelliteFrame('a-st-in', 'b-jupiter', [0, 0, 2]));
    render(<Picking />);
    frame();
    pointer('pointerMove', 400, 300);
    flushRaf();
    expect(hover()).toMatchObject({ kind: 'satellite', agentId: 'a-st-in' });
    pointer('pointerDown', 400, 300, 1);
    // Between press and release it moves ≈ 45 px away: a re-pick would find the planet.
    frames.get('a-st-in')!.position[0] = 0.5;
    frame();
    pointer('pointerUp', 400, 300);
    expect(selected()).toBe('steward:a-st-in');
    expect(useCameraStore.getState().focusedId).toBe('b-jupiter');
  });

  it('…but not once it went behind its planet or away: then the click picks again', () => {
    anchorAt('b-jupiter', 0);
    publish(satelliteFrame('a-st-in', 'b-jupiter', [0, 0, 2]));
    render(<Picking />);
    frame();
    pointer('pointerMove', 400, 300);
    flushRaf();
    pointer('pointerDown', 400, 300, 1);
    frames.get('a-st-in')!.position[2] = -2; // behind Jupiter
    frame();
    pointer('pointerUp', 400, 300);
    expect(selected()).toBe('waykeeper:a-wk-old');
    // Gone (shrunk out) between press and release: the same.
    act(() => useAppStore.getState().select(HARMONIZER));
    frames.get('a-st-in')!.position[2] = 2;
    frame();
    pointer('pointerMove', 400, 301);
    flushRaf();
    expect(hover()).toMatchObject({ kind: 'satellite' });
    pointer('pointerDown', 400, 301, 1);
    frames.get('a-st-in')!.presence = 0;
    pointer('pointerUp', 400, 301);
    expect(selected()).toBe('waykeeper:a-wk-old');
  });

  describe('hover grace (review item 3)', () => {
    let now = 1000;
    beforeEach(() => {
      now = 1000;
      vi.spyOn(performance, 'now').mockImplementation(() => now);
      anchorAt('b-jupiter', 0);
      publish(satelliteFrame('a-st-in', 'b-jupiter', [0, 0, 2]));
      render(<Picking />);
      frame();
      pointer('pointerMove', 400, 300);
      flushRaf();
      expect(hover()).toMatchObject({ kind: 'satellite', agentId: 'a-st-in' });
    });
    const orbitTo = (x: number, z = 2) => {
      const f = frames.get('a-st-in')!;
      f.position[0] = x;
      f.position[2] = z;
      frame();
    };

    it('keeps an orbiting satellite under a still pointer; the card and ring follow it', () => {
      orbitTo(0.5); // ≈ 45 px away
      expect(hover()).toMatchObject({ kind: 'satellite', agentId: 'a-st-in' });
      expect(hoverAt().x).toBeGreaterThan(440);
      // A small move (within 6 px of where it was picked) keeps it too.
      pointer('pointerMove', 404, 302);
      flushRaf();
      expect(hover()).toMatchObject({ kind: 'satellite' });
    });

    it('once the pointer moves on, keeps it only while the pointer follows it closely', () => {
      orbitTo(0.2); // ≈ 18 px right: (418, 300)
      pointer('pointerMove', 410, 300); // left the pick point, 8 px from the satellite
      flushRaf();
      expect(hover()).toMatchObject({ kind: 'satellite' });
      orbitTo(0.4); // ≈ 36 px right: 26 px from the pointer
      expect(hover()).toMatchObject({ bodyId: 'b-jupiter' });
    });

    it('releases after 3 s without a pointer move', () => {
      orbitTo(0.5);
      now += 2900;
      orbitTo(0.5);
      expect(hover()).toMatchObject({ kind: 'satellite' });
      now += 200;
      orbitTo(0.5);
      expect(hover()).toMatchObject({ bodyId: 'b-jupiter' });
    });

    it('releases when the satellite goes behind a body, or is gone', () => {
      orbitTo(0.5, -2);
      expect(hover()).toMatchObject({ bodyId: 'b-jupiter' });
      orbitTo(0, 2);
      expect(hover()).toMatchObject({ kind: 'satellite' });
      frames.get('a-st-in')!.visible = false;
      orbitTo(0.3);
      expect(hover()).toMatchObject({ bodyId: 'b-jupiter' });
    });

    it('releases when the popover opens or the pointer leaves the canvas', () => {
      act(() => usePickingStore.getState().showHere({ x: 1, y: 1 }, ['b-jupiter', 'b-io']));
      orbitTo(0.5);
      expect(hover()).toMatchObject({ bodyId: 'b-jupiter' });
      act(() => usePickingStore.getState().closePopover());
      orbitTo(0);
      expect(hover()).toMatchObject({ kind: 'satellite' });
      fireEvent.pointerLeave(canvas);
      expect(hover()).toBeUndefined();
      orbitTo(0.5);
      expect(hover()).toBeUndefined();
    });

    it('a click while it is kept selects it', () => {
      orbitTo(0.5);
      click(400, 300);
      expect(selected()).toBe('steward:a-st-in');
    });
  });

  it('no grace under reduced motion: the ordinary rule only', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('reduce'),
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    anchorAt('b-jupiter', 0);
    publish(satelliteFrame('a-st-in', 'b-jupiter', [0, 0, 2]));
    render(<Picking />);
    frame();
    pointer('pointerMove', 400, 300);
    flushRaf();
    expect(hover()).toMatchObject({ kind: 'satellite' });
    frames.get('a-st-in')!.position[0] = 0.5;
    frame();
    expect(hover()).toMatchObject({ bodyId: 'b-jupiter' });
  });

  it('a hidden or shrunk-out satellite is no target', () => {
    anchorAt('b-jupiter', 0);
    const gone = satelliteFrame('a-st-in', 'b-jupiter', [0, 0, 2]);
    gone.visible = false;
    const leaving = satelliteFrame('a-st', 'b-jupiter', [0, 0, 2]);
    leaving.presence = 0;
    publish(gone, leaving);
    render(<Picking />);
    frame();
    pointer('pointerMove', 400, 300);
    flushRaf();
    expect(hover()).toMatchObject({ bodyId: 'b-jupiter' });
  });
});

describe('per-frame cost (review item 4)', () => {
  afterEach(() => publishSatellites(new Map()));

  it('reuses the pick spheres: same array and objects from frame to frame', () => {
    anchorAt('b-jupiter', 0);
    anchorAt('b-mars', 5);
    publishSatellites(
      new Map([
        ['a-st', satelliteFrame('a-st', 'b-mars', [5, 0, 2])],
        ['a-wk-old', satelliteFrame('a-wk-old', 'b-jupiter', [0, 0, 2], { role: 'waykeeper' })],
      ]),
    );
    const bodies: Parameters<typeof bodySpheres>[0] = [];
    const first = bodySpheres(bodies);
    const objects = [...first];
    const again = bodySpheres(bodies);
    expect(again).toBe(first);
    expect([...again]).toEqual(objects);
    expect(again.map((b) => b.bodyId)).toEqual(['b-jupiter', 'b-mars']);
    expect(again[1]!.center).toEqual([5, 0, 0]);

    const sats: Parameters<typeof satelliteSpheres>[0] = [];
    const s1 = satelliteSpheres(sats);
    const s1Objects = [...s1];
    const s2 = satelliteSpheres(sats);
    expect(s2).toBe(s1);
    expect([...s2]).toEqual(s1Objects);
    expect(s2.map((s) => [s.agentId, s.role])).toEqual([
      ['a-st', 'steward'],
      ['a-wk-old', 'waykeeper'],
    ]);
    expect(satellitesDrawn()).toBe(true);
  });

  it("reads the canvas's position once, again after a resize or a scroll", () => {
    anchorAt('b-jupiter', 0);
    const rect = vi.spyOn(canvas, 'getBoundingClientRect');
    render(<Picking />);
    frame();
    for (const x of [400, 401, 402]) {
      pointer('pointerMove', x, 300);
      flushRaf();
    }
    expect(rect).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('resize'));
    pointer('pointerMove', 403, 300);
    flushRaf();
    expect(rect).toHaveBeenCalledTimes(2);
    document.dispatchEvent(new Event('scroll'));
    pointer('pointerMove', 404, 300);
    flushRaf();
    expect(rect).toHaveBeenCalledTimes(3);
  });
});

describe('OutlineSync', () => {
  it('re-applies the selection to a recreated effect, even with the same meshes', () => {
    const mars = anchorAt('b-mars', 0, true);
    const first = { selection: { set: vi.fn(), clear: vi.fn() } };
    const effect = createRef<OutlineEffect>() as { current: OutlineEffect | null };
    effect.current = first as unknown as OutlineEffect;
    render(<OutlineSync effect={effect} bodyId="b-mars" />);
    frame();
    frame();
    expect(first.selection.set).toHaveBeenCalledTimes(1);
    const second = { selection: { set: vi.fn(), clear: vi.fn() } };
    effect.current = second as unknown as OutlineEffect;
    frame();
    expect(second.selection.set).toHaveBeenCalledWith([mars.children[0]]);
  });

  it('empties the selection while the body is off screen, and restores it when back (P3-08)', () => {
    const mars = anchorAt('b-mars', 0, true);
    const set = vi.fn();
    const effect = { current: { selection: { set, clear: vi.fn() } } as unknown as OutlineEffect };
    render(<OutlineSync effect={effect} bodyId="b-mars" />);
    frame();
    expect(set).toHaveBeenLastCalledWith([mars.children[0]]);
    // The camera turns away: Mars is behind it.
    camera.lookAt(0, 0, 20);
    frame();
    expect(set).toHaveBeenLastCalledWith([]);
    camera.lookAt(0, 0, 0);
    frame();
    expect(set).toHaveBeenLastCalledWith([mars.children[0]]);
    expect(set).toHaveBeenCalledTimes(3);
  });

  it("leaves the decorations' layer out of the effect's depth pass (P3-08)", () => {
    anchorAt('b-mars', 0, true);
    const seen: boolean[] = [];
    const depthPass = { render: () => seen.push(camera.layers.isEnabled(DECOR_LAYER)) };
    const effect = {
      current: {
        selection: { set: vi.fn(), clear: vi.fn() },
        camera,
        depthPass,
      } as unknown as OutlineEffect,
    };
    showDecor(camera);
    render(<OutlineSync effect={effect} bodyId="b-mars" />);
    frame();
    frame();
    depthPass.render();
    expect(seen).toEqual([false]);
    expect(camera.layers.isEnabled(DECOR_LAYER)).toBe(true);
  });
});

describe('question beacons as pick targets (P4-05, P4-13)', () => {
  // Jupiter at the centre; two beacons in a row 72 px above it (y ≈ 228 px), over Jupiter's moon
  // Io: the permission 20 px left of the centre line, the clarification 20 px right of it.
  const perPx = 10 / (300 / Math.tan((22.5 * Math.PI) / 180));
  const dx = 20 * perPx;
  beforeEach(() => {
    anchorAt('b-jupiter', 0);
    anchorAtPoint('b-io', [0, 1, 0], 0.3);
    anchorAtPoint('b-earth', [-3, -2, 0], 0.3);
    const world = pickingWorld();
    world.questions = {
      'q-p': question('q-p', 'a-st-in', { kind: 'permission', text: 'Run the migration?' }),
      'q-w': question('q-w', 'a-wk-new', { text: 'Which branch?' }),
      'q-h': question('q-h', 'a-h', { text: 'Which repo?' }),
    };
    useAppStore.setState({ world });
    publishBeacons([
      { questionId: 'q-p', bodyId: 'b-jupiter', visible: true, center: [-dx, 1, 0], perPx },
      { questionId: 'q-w', bodyId: 'b-jupiter', visible: true, center: [dx, 1, 0], perPx },
      // The Harmonizer's beacon on Earth, 72 px above it (Earth at x 184, y 444 px).
      { questionId: 'q-h', bodyId: 'b-earth', visible: true, center: [-3, -1, 0], perPx },
    ]);
    const inbox = document.createElement('section');
    inbox.id = 'pnl-inbox';
    for (const id of ['q-p', 'q-w', 'q-h']) {
      const card = document.createElement('article');
      card.dataset['questionId'] = id;
      inbox.append(card);
    }
    document.body.append(inbox);
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    publishBeacons([]);
    document.getElementById('pnl-inbox')?.remove();
  });

  it('each beacon of a row is its own target and wins over the body under it', () => {
    render(<Picking />);
    frame();
    pointer('pointerMove', 380, 228);
    flushRaf();
    expect(usePickingStore.getState().hover).toEqual({
      kind: 'beacon',
      questionId: 'q-p',
      bodyId: 'b-jupiter',
    });
    pointer('pointerMove', 420, 228);
    flushRaf();
    expect(usePickingStore.getState().hover).toMatchObject({ kind: 'beacon', questionId: 'q-w' });
    // Off the glyphs: the moon under the pointer again.
    pointer('pointerMove', 400, 200);
    flushRaf();
    expect(usePickingStore.getState().hover?.kind).not.toBe('beacon');
  });

  it('a click selects the asker, flies to its body and opens that question', () => {
    render(<Picking />);
    frame();
    click(421, 229);
    expect(document.activeElement).toBe(document.querySelector('[data-question-id="q-w"]'));
    expect(selected()).toBe('waykeeper:a-wk-new');
    expect(useCameraStore.getState().request).toMatchObject({ kind: 'focus', bodyId: 'b-jupiter' });
    expect(usePickingStore.getState().popover).toBeUndefined();
    click(379, 229);
    expect(document.activeElement).toBe(document.querySelector('[data-question-id="q-p"]'));
    expect(selected()).toBe('steward:a-st-in');
  });

  it("the Harmonizer's own question: back to the Harmonizer, the camera to Earth", () => {
    useAppStore.setState({ selection: { kind: 'steward', id: 'a-st' } });
    render(<Picking />);
    frame();
    camera.updateMatrixWorld();
    const earth = new Vector3(-3, -1, 0).project(camera);
    click(((earth.x + 1) / 2) * 800, ((1 - earth.y) / 2) * 600);
    expect(selected()).toBe('harmonizer');
    expect(useCameraStore.getState().request).toMatchObject({ kind: 'focus', bodyId: 'b-earth' });
    expect(document.activeElement).toBe(document.querySelector('[data-question-id="q-h"]'));
  });
});
