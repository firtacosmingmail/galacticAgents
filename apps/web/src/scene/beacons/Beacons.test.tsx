// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { Profiler, StrictMode } from 'react';
import { Object3D, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../state/store.js';
import { registerAnchor } from '../anchors.js';
import { BEACON, STEADY_PULSE } from './beacon-look.js';
import { beaconFrames, beaconsDrawn } from './registry.js';
import { question, worldWith } from './fixtures.js';

/**
 * `Beacons` without WebGL: R3F's hooks are replaced by a fake canvas state and a manual frame
 * loop; the intrinsic three elements render as inert DOM placeholders, dressed with the Object3D
 * fields the component writes.
 */
const r3f = vi.hoisted(() => ({
  state: undefined as unknown as Record<string, unknown>,
  frames: new Set<(state: unknown) => void>(),
  invalidations: 0,
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

const { Beacons, BeaconShapes } = await import('./Beacons.js');

type Dressed = HTMLElement & {
  position: Vector3;
  quaternion: Quaternion;
  scale: Vector3;
  material: { opacity: number };
};

let camera: PerspectiveCamera;
let unregister: (() => void)[] = [];

function frame(): void {
  for (const el of document.querySelectorAll<Dressed>('group, mesh')) {
    el.position ??= new Vector3();
    el.quaternion ??= new Quaternion();
    el.scale ??= new Vector3();
    el.material ??= { opacity: -1 };
  }
  camera.updateMatrixWorld();
  for (const run of [...r3f.frames]) run(r3f.state);
}

const halo = () =>
  document.querySelector<Dressed>('[name="beacon:b-jupiter"] mesh[name="beacon-halo"]')!;

function anchor(bodyId: string, at: [number, number, number], radius = 0.5): void {
  const object = new Object3D();
  object.position.set(...at);
  unregister.push(registerAnchor({ bodyId, kind: 'planet', object, radius }));
}

function reducedMotion(on: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: on && query.includes('reduce'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

beforeEach(() => {
  camera = new PerspectiveCamera(45, 800 / 600, 0.1, 1000);
  camera.position.set(0, 0, 10);
  r3f.invalidations = 0;
  r3f.state = {
    camera,
    size: { width: 800, height: 600 },
    invalidate: () => void r3f.invalidations++,
  };
  r3f.frames.clear();
  // React's warnings about the unknown `<mesh>` / `<planeGeometry>` DOM tags.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // jsdom has no 2D canvas: the textures stay blank.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  useAppStore.setState({
    world: worldWith(
      question('q-1', 'a-st-in', { kind: 'permission' }),
      question('q-2', 'a-st'),
      question('q-3', 'a-st', { holder: { type: 'agent', id: 'a-wk-old' } }),
    ),
  });
});

afterEach(() => {
  cleanup();
  unregister.forEach((u) => u());
  unregister = [];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Beacons', () => {
  it('draws one beacon per body with an open user-held question, by kind', () => {
    const { container } = render(
      <StrictMode>
        <Beacons />
      </StrictMode>,
    );
    const groups = [...container.querySelectorAll('group')].map((g) => g.getAttribute('name'));
    expect(groups).toEqual(['beacon:b-ast-7', 'beacon:b-jupiter']);
    expect(
      container.querySelector('[name="beacon:b-ast-7"] [name="beacon-glyph-clarification"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[name="beacon:b-jupiter"] [name="beacon-glyph-permission"]'),
    ).not.toBeNull();
    expect(beaconFrames().map((f) => f.bodyId)).toEqual(['b-ast-7', 'b-jupiter']);
  });

  it("places the glyph above its body's anchor, screen-sized; hidden without an anchor", () => {
    reducedMotion(true);
    render(<Beacons />);
    anchor('b-jupiter', [0, 0, 0], 0.5);
    frame();
    const [ast, jup] = beaconFrames();
    expect(ast?.visible).toBe(false);
    expect(jup?.visible).toBe(true);
    const perPx = 10 / (300 / Math.tan((45 / 2) * (Math.PI / 180)));
    expect(jup!.perPx).toBeCloseTo(perPx, 6);
    // Screen up from the body by its radius on screen plus the lift.
    expect(jup!.center[1]).toBeCloseTo(0.5 + BEACON.liftPx * perPx, 4);
    expect(beaconsDrawn()).toBe(true);
    const group = document.querySelector<Dressed>('group[name="beacon:b-jupiter"]')!;
    expect(group.scale.x).toBeCloseTo(perPx, 6);
  });

  it('hides a beacon whose body is behind the camera', () => {
    render(<Beacons />);
    anchor('b-jupiter', [0, 0, 20]);
    frame();
    expect(beaconFrames().find((f) => f.bodyId === 'b-jupiter')?.visible).toBe(false);
  });

  it('pulses with motion, and is steady under reduced motion', () => {
    const now = vi.spyOn(performance, 'now');
    reducedMotion(true);
    const view = render(<Beacons />);
    anchor('b-jupiter', [0, 0, 0]);
    now.mockReturnValue(1000);
    frame();
    const steady = halo().material.opacity;
    now.mockReturnValue(1700);
    frame();
    expect(halo().material.opacity).toBe(steady);
    expect(steady).toBe(STEADY_PULSE.haloOpacity);
    view.unmount();

    reducedMotion(false);
    render(<Beacons />);
    now.mockReturnValue(2000);
    frame();
    const a = halo().material.opacity;
    now.mockReturnValue(2700);
    frame();
    expect(halo().material.opacity).not.toBe(a);
  });

  it('follows the question lifecycle: an answer puts the beacon out, and asks for a frame', () => {
    const { container } = render(<Beacons />);
    const before = r3f.invalidations;
    act(() => {
      const world = useAppStore.getState().world;
      useAppStore.setState({
        world: {
          ...world,
          questions: {
            ...world.questions,
            'q-1': { ...world.questions['q-1']!, status: 'answered' },
            'q-3': { ...world.questions['q-3']!, holder: { type: 'user' } },
          },
        },
      });
    });
    expect([...container.querySelectorAll('group')].map((g) => g.getAttribute('name'))).toEqual([
      'beacon:b-ast-7',
    ]);
    expect(container.querySelector('[name="beacon-glyph-clarification"]')).not.toBeNull();
    expect(beaconFrames().map((f) => f.bodyId)).toEqual(['b-ast-7']);
    expect(r3f.invalidations).toBeGreaterThan(before);
  });

  it('a status flush neither republishes nor re-renders the beacons', () => {
    let commits = 0;
    render(
      <Profiler id="beacons" onRender={() => void commits++}>
        <Beacons />
      </Profiler>,
    );
    const published = beaconFrames();
    const [before, invalidations] = [commits, r3f.invalidations];
    for (let i = 0; i < 5; i++) {
      act(() => {
        const world = useAppStore.getState().world;
        const id = Object.keys(world.statuses)[0] ?? 'a-st';
        useAppStore.setState({
          world: {
            ...world,
            statuses: { ...world.statuses, [id]: { ...world.statuses[id]!, lastEventAt: `t${i}` } },
          },
        });
      });
    }
    expect(commits).toBe(before);
    expect(beaconFrames()).toBe(published);
    expect(r3f.invalidations).toBe(invalidations);
    // A world change that draws the same beacons (an unrelated question answered) neither.
    act(() => {
      const world = useAppStore.getState().world;
      useAppStore.setState({
        world: {
          ...world,
          questions: {
            ...world.questions,
            'q-3': { ...world.questions['q-3']!, status: 'answered' },
          },
        },
      });
    });
    expect(beaconFrames()).toBe(published);
  });

  it('a beacon keeps its placement when the list is rebuilt (the hover stays)', () => {
    render(<Beacons />);
    anchor('b-jupiter', [0, 0, 0]);
    frame();
    const jupiter = () => beaconFrames().find((f) => f.bodyId === 'b-jupiter')!;
    const { center, perPx } = jupiter();
    expect(jupiter().visible).toBe(true);
    // Another body's beacon goes out: the frames are rebuilt, Jupiter's is still placed.
    act(() => {
      const world = useAppStore.getState().world;
      useAppStore.setState({
        world: {
          ...world,
          questions: {
            ...world.questions,
            'q-2': { ...world.questions['q-2']!, status: 'answered' },
          },
        },
      });
    });
    expect(beaconFrames().map((f) => f.bodyId)).toEqual(['b-jupiter']);
    expect(jupiter()).toMatchObject({ visible: true, center, perPx });
  });

  it('hides a beacon whose glyph is off screen', () => {
    render(<Beacons />);
    anchor('b-jupiter', [40, 0, 0]); // far right of a camera at z = 10 looking down −z
    frame();
    const jupiter = beaconFrames().find((f) => f.bodyId === 'b-jupiter');
    expect(jupiter?.visible).toBe(false);
    const group = document.querySelector<Dressed & { visible: boolean }>(
      'group[name="beacon:b-jupiter"]',
    );
    expect(group?.visible).toBe(false);
  });

  it('every beacon shares one plane and one ring geometry', () => {
    const made = BeaconShapes.count;
    const { container } = render(<Beacons />);
    expect(container.querySelectorAll('group')).toHaveLength(2);
    expect(BeaconShapes.count - made).toBe(1);
    // No per-beacon geometry element.
    expect(container.querySelectorAll('planeGeometry, ringGeometry, planegeometry')).toHaveLength(
      0,
    );
  });

  it('publishes none once unmounted', () => {
    const view = render(<Beacons />);
    view.unmount();
    expect(beaconFrames()).toEqual([]);
  });
});
