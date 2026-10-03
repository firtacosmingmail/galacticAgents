// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { Object3D, PerspectiveCamera } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAnchor, type BodyAnchor } from '../anchors.js';
import { useCameraStore } from '../camera/store.js';
import { useAppStore } from '../../state/store.js';
import { HARMONIZER, selectionKey } from '../../state/selection.js';
import { pickingWorld } from '../picking/fixtures.js';
import { usePickingStore } from '../picking/store.js';
import { LabelLayer } from './LabelLayer.js';
import { labelEntries, labelStats, resetLabelStats, updateLabel } from './registry.js';

/**
 * The label layer (DOM) and the projector without WebGL: R3F's hooks are replaced by a fake
 * canvas state and a manual frame loop (`frame()`), with `performance.now` driven by the test.
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

const { LabelProjector } = await import('./LabelProjector.js');

let camera: PerspectiveCamera;
let now = 0;
let unregister: (() => void)[] = [];
const SIZE = { width: 800, height: 600 };

function anchor(
  bodyId: string,
  at: [number, number, number],
  kind: BodyAnchor['kind'],
  radius = 1,
) {
  const object = new Object3D();
  object.position.set(...at);
  unregister.push(registerAnchor({ bodyId, kind, object, radius }));
  return object;
}

function frame(advanceMs = 1000 / 60): void {
  now += advanceMs;
  for (const run of [...r3f.frames]) run(r3f.state);
}

const label = (bodyId: string) =>
  document.querySelector<HTMLElement>(`.scene-label[data-body="${bodyId}"]`)!;
const shown = (bodyId: string) => label(bodyId).style.visibility === 'visible';
const selected = () => selectionKey(useAppStore.getState().selection);

beforeEach(() => {
  now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  window.history.replaceState(null, '', '/');
  useAppStore.setState({ world: pickingWorld(), route: 'panel', selection: HARMONIZER });
  usePickingStore.setState({ hover: undefined, popover: undefined });
  useCameraStore.setState({ focusedId: undefined, request: undefined, flying: false });
  camera = new PerspectiveCamera(45, SIZE.width / SIZE.height, 0.1, 1000);
  camera.position.set(0, 0, 100);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  r3f.state = { camera, size: SIZE, invalidate: vi.fn(), frameloop: 'always' };
  anchor('b-sun', [0, 0, 0], 'star', 6);
  anchor('b-earth', [-30, 0, 0], 'planet');
  anchor('b-jupiter', [30, 0, 0], 'planet', 3);
  anchor('b-io', [36, -10, 0], 'moon');
  anchor('b-venus', [-20, 15, 0], 'planet');
  anchor('b-ast-7', [0, 0, -40], 'asteroid'); // straight behind the Sun
  anchor('b-ast-9', [10, 25, 0], 'asteroid');
  resetLabelStats();
});

afterEach(() => {
  cleanup();
  unregister.forEach((u) => u());
  unregister = [];
  vi.restoreAllMocks();
});

describe('LabelLayer (content from the store)', () => {
  it('one label per assigned body with its work and state; reserved and free bodies none', () => {
    render(<LabelLayer />);
    const bodies = [...document.querySelectorAll<HTMLElement>('.scene-label')].map(
      (el) => el.dataset['body'],
    );
    expect(bodies).toEqual(['b-ast-7', 'b-ast-9', 'b-io', 'b-jupiter', 'b-venus']);
    expect(label('b-jupiter').textContent).toContain('Big project');
    expect(label('b-jupiter').textContent).toContain('in progress');
    expect(label('b-ast-7').className).toContain('tone-beacon');
    expect(label('b-ast-7').textContent).toContain('blocked on you');
    expect(label('b-io').textContent).toContain('own project');
    expect(label('b-io').className).toContain('moon-independent');
    expect(label('b-venus').textContent).toContain('moved to Jupiter');
    expect(label('b-venus').className).toContain('is-moved');
    // Labels start hidden until the projector places them.
    expect(label('b-jupiter').style.visibility).toBe('');
  });

  it('a state change in the store updates the label at once', () => {
    render(<LabelLayer />);
    act(() => {
      const world = useAppStore.getState().world;
      useAppStore.setState({
        world: {
          ...world,
          projects: {
            ...world.projects,
            'p-big': { ...world.projects['p-big']!, state: 'blocked_on_user' },
          },
        },
      });
    });
    expect(label('b-jupiter').textContent).toContain('blocked on you');
    expect(label('b-jupiter').className).toContain('tone-beacon');
    act(() => {
      const world = useAppStore.getState().world;
      useAppStore.setState({
        world: {
          ...world,
          projects: {
            ...world.projects,
            'p-big': { ...world.projects['p-big']!, state: 'completed' },
          },
        },
      });
    });
    expect(label('b-jupiter').textContent).toContain('✓ completed');
    expect(label('b-jupiter').className).toContain('tone-done');
  });

  it("the selected agent's body is marked and gets the top priority", () => {
    render(<LabelLayer />);
    act(() => useAppStore.getState().select({ kind: 'steward', id: 'a-st' }));
    expect(label('b-ast-7').className).toContain('is-selected');
    const entry = [...labelEntries()].find((e) => e.bodyId === 'b-ast-7');
    expect(entry?.priority).toBe(5);
  });

  it('clicking a label is clicking its body (select + fly; info card for no agent)', () => {
    render(<LabelLayer />);
    fireEvent.click(label('b-jupiter'), { clientX: 40, clientY: 30 });
    expect(selected()).toBe('waykeeper:a-wk-old');
    expect(useCameraStore.getState().focusedId).toBe('b-jupiter');
    fireEvent.click(label('b-ast-9'));
    expect(usePickingStore.getState().popover).toMatchObject({ kind: 'info' });
    expect(selected()).toBe('waykeeper:a-wk-old');
  });

  it('an unassigned body loses its label', () => {
    render(<LabelLayer />);
    act(() => {
      const world = useAppStore.getState().world;
      const { host: _host, ...free } = world.bodies['b-ast-9']!;
      useAppStore.setState({ world: { ...world, bodies: { ...world.bodies, 'b-ast-9': free } } });
    });
    expect(label('b-ast-9')).toBeNull();
    expect([...labelEntries()].map((e) => e.bodyId)).not.toContain('b-ast-9');
  });
});

describe('LabelProjector (one pass for every label)', () => {
  it('places visible labels, hides the one behind the Sun', () => {
    render(
      <>
        <LabelLayer />
        <LabelProjector hz={30} />
      </>,
    );
    frame();
    expect(shown('b-jupiter')).toBe(true);
    expect(shown('b-io')).toBe(true);
    expect(shown('b-ast-9')).toBe(true);
    expect(shown('b-venus')).toBe(true);
    expect(shown('b-ast-7')).toBe(false); // behind the Sun
    expect(label('b-jupiter').style.transform).toMatch(/^translate3d\(/);
    // Right of centre, above the body's top.
    const [, x, y] = /translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(
      label('b-jupiter').style.transform,
    )!;
    expect(Number(x)).toBeGreaterThan(400);
    expect(Number(y)).toBeLessThan(300);
  });

  it('writes only what changed: nothing for a still camera, transforms after it moves', () => {
    render(
      <>
        <LabelLayer />
        <LabelProjector hz={30} />
      </>,
    );
    frame();
    frame(40);
    resetLabelStats();
    frame(40);
    frame(40);
    expect(labelStats.updates).toBe(2);
    expect(labelStats.writes).toBe(0);
    camera.position.x += 5;
    camera.updateMatrixWorld();
    frame(40);
    expect(labelStats.writes).toBe(4); // the four visible labels moved
    camera.position.x += 0.001; // well under half a pixel
    camera.updateMatrixWorld();
    frame(40);
    expect(labelStats.writes).toBe(4);
  });

  it('throttles to the tier rate: 30 Hz at 60 fps, 15 Hz at the capped 30 fps', () => {
    render(
      <>
        <LabelLayer />
        <LabelProjector hz={30} />
      </>,
    );
    frame();
    resetLabelStats();
    for (let i = 0; i < 60; i++) frame(1000 / 60);
    expect(labelStats.updates).toBe(30);
    cleanup();
    render(
      <>
        <LabelLayer />
        <LabelProjector hz={15} />
      </>,
    );
    frame();
    resetLabelStats();
    for (let i = 0; i < 30; i++) frame(1000 / 30);
    expect(labelStats.updates).toBe(15);
  });

  it('a new label forces the next update; on demand a skipped frame asks for one later', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      r3f.state = { ...r3f.state, frameloop: 'demand' };
      render(
        <>
          <LabelLayer />
          <LabelProjector hz={30} />
        </>,
      );
      frame();
      resetLabelStats();
      frame(5); // too soon: skipped, a render is scheduled
      expect(labelStats.updates).toBe(0);
      const invalidate = r3f.state['invalidate'] as ReturnType<typeof vi.fn>;
      invalidate.mockClear();
      vi.runAllTimers();
      expect(invalidate).toHaveBeenCalled();
      // A label appears: forced through on the very next frame.
      act(() => {
        const world = useAppStore.getState().world;
        const mars = world.bodies['b-mars']!;
        useAppStore.setState({
          world: {
            ...world,
            bodies: {
              ...world.bodies,
              'b-mars': { ...mars, host: { kind: 'project', id: 'p-new' } },
            },
          },
        });
      });
      anchor('b-mars', [-10, -20, 0], 'planet');
      frame(1);
      expect(labelStats.updates).toBe(1);
      expect(shown('b-mars')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('de-clutters overlapping labels by priority (selected first)', () => {
    anchor('b-ast-9', [30, 4, 0], 'asteroid'); // just above Jupiter: the labels overlap
    render(
      <>
        <LabelLayer />
        <LabelProjector hz={30} />
      </>,
    );
    // jsdom measures nothing: give the labels a size.
    for (const e of labelEntries()) updateLabel(e.bodyId, { priority: e.priority, w: 90, h: 16 });
    frame(40);
    expect(shown('b-jupiter')).toBe(true); // in progress beats approved
    expect(shown('b-ast-9')).toBe(false);
    // Selecting the asteroid's Steward (one is added for it) raises its label above Jupiter's.
    act(() => {
      const world = useAppStore.getState().world;
      useAppStore.setState({
        world: {
          ...world,
          agents: {
            ...world.agents,
            'a-st-9': {
              ...world.agents['a-st']!,
              id: 'a-st-9',
              taskId: 't-idle',
              bodyId: 'b-ast-9',
            },
          },
        },
      });
      useAppStore.getState().select({ kind: 'steward', id: 'a-st-9' });
    });
    for (const e of labelEntries()) updateLabel(e.bodyId, { priority: e.priority, w: 90, h: 16 });
    frame(40);
    expect(shown('b-ast-9')).toBe(true);
    expect(shown('b-jupiter')).toBe(false);
  });

  it('hides labels behind the camera, off screen, without an anchor, and all on unmount', () => {
    const { rerender } = render(
      <>
        <LabelLayer />
        <LabelProjector hz={30} />
      </>,
    );
    frame();
    expect(shown('b-jupiter')).toBe(true);
    camera.position.set(0, 0, -100); // the bodies are now behind the camera
    camera.lookAt(0, 0, -200);
    camera.updateMatrixWorld();
    frame(40);
    expect(shown('b-jupiter')).toBe(false);
    camera.position.set(0, 0, 100);
    camera.lookAt(-400, 0, 0); // everything off to the right, out of the frustum
    camera.updateMatrixWorld();
    frame(40);
    expect(shown('b-jupiter')).toBe(false);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    frame(40);
    expect(shown('b-jupiter')).toBe(true);
    rerender(<LabelLayer />);
    expect(shown('b-jupiter')).toBe(false);
  });
});
