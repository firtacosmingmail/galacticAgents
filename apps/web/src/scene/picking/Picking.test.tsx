// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createRef } from 'react';
import { Mesh, MeshBasicMaterial, Object3D, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import type { OutlineEffect } from 'postprocessing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAnchor } from '../anchors.js';
import { labelEntries, registerLabel, setShown, writePosition } from '../labels/registry.js';
import { useCameraStore } from '../camera/store.js';
import { useAppStore } from '../../state/store.js';
import { HARMONIZER, selectionKey } from '../../state/selection.js';
import { pickingWorld } from './fixtures.js';
import { usePickingStore } from './store.js';

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

const { Picking, OutlineSync } = await import('./Picking.js');

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
});
