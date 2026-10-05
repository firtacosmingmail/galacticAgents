// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { BufferGeometry, PerspectiveCamera } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, ServerMessage } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { App } from '../../../App.js';
import { FakeWebSocket } from '../../../client/fake-socket.js';
import { useConversationStore } from '../../../state/conversation.js';
import { useAppStore } from '../../../state/store.js';
import { selectionKey } from '../../../state/selection.js';
import { DOCK_KEY, readDockPrefs } from '../../../panel/dock-state.js';
import { DOCK_VIEW_KEY, useDockView } from '../../../panel/status/dock-view.js';
import { SCENE_VISIBLE_KEY } from '../../visibility.js';
import { QUALITY_TIERS } from '../../quality.js';
import { applyHqPose, hqClaimed } from '../../satellites/hq/hq-model.js';
import { satelliteFrame } from '../../picking/fixtures.js';
import { hqSlot } from './hq-slot.js';
import { activateSatellite } from '../../picking/store.js';
import type { DetailBody } from '../detail-body.js';

/*
 * P6-05 in the DOM: the station's part claims the HQ while mounted (no double HQ) and frees its
 * GPU objects on unmount; a click on the HQ selects the Harmonizer and opens its chat — the dock
 * restored if minimised (decision 71), on Chat if it was on Status (decision 80).
 */

vi.mock('@react-three/fiber', () => ({
  useFrame: () => {},
  useThree: (select: (s: unknown) => unknown) => select({ invalidate: () => {} }),
}));
// The three.js scene never loads in jsdom: a stub stands in, and WebGL is "available".
vi.mock('../../SolarScene.js', () => ({
  default: function StubScene() {
    return <div data-testid="solar-scene" />;
  },
}));
vi.mock('../../webgl.js', () => ({ webglAvailable: () => true }));

const { EarthHq, slotCamera } = await import('./EarthHq.js');

const earth = { kind: 'rocky', bodyId: 'b-earth', name: 'Earth', radius: 1 } as DetailBody;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('the EarthHq part (mount, claim, disposal)', () => {
  it('claims the HQ while mounted (StrictMode too) and disposes its geometry on unmount', () => {
    const dispose = vi.spyOn(BufferGeometry.prototype, 'dispose');
    expect(hqClaimed()).toBe(false);
    const view = render(
      <StrictMode>
        <EarthHq body={earth} quality={QUALITY_TIERS.high} mix={() => 1} />
      </StrictMode>,
    );
    expect(hqClaimed()).toBe(true);
    expect(view.container.querySelector('[name="earth-hq-glow"]')).not.toBeNull();
    dispose.mockClear();
    view.unmount();
    expect(hqClaimed()).toBe(false);
    expect(dispose.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it("moves the Harmonizer's frame into its viewing slot while mounted, not after (P6-06)", () => {
    // Reduced motion: the slot is taken at once (no follow lag), for a one-frame check.
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('reduce'),
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const camera = new PerspectiveCamera(45, 1, 0.1, 1000);
    camera.position.set(33, 0, 2.85 * 1.7);
    camera.lookAt(33, 0, 0);
    camera.updateMatrixWorld();
    const orbit = () => {
      const f = satelliteFrame('a-harmonizer', 'b-earth', [33 + 3, 0.5, -1], {
        role: 'harmonizer',
        size: 0.714,
      });
      f.target = [33, 0, 0];
      f.bodyRadius = 1.7;
      return f;
    };
    const expected: [number, number, number] = [0, 0, 0];
    const scale = hqSlot(
      slotCamera(camera, {
        position: [0, 0, 0],
        right: [0, 0, 0],
        up: [0, 0, 0],
        forward: [0, 0, 0],
        tanHalfFov: 1,
        aspect: 1,
      }),
      [33, 0, 0],
      1.7,
      expected,
    )!;
    const view = render(<EarthHq body={earth} quality={QUALITY_TIERS.high} mix={() => 1} />);
    const frame = orbit();
    applyHqPose([frame], camera);
    frame.position.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!));
    expect(frame.size).toBeCloseTo(0.714 * scale);
    view.unmount();
    const after = orbit();
    applyHqPose([after], camera);
    expect(after.position).toEqual([36, 0.5, -1]);
  });

  it('the mobile tier mounts the simpler station, without the glow', () => {
    const view = render(<EarthHq body={earth} quality={QUALITY_TIERS.mobile} mix={() => 1} />);
    expect(view.container.querySelector('[name="earth-hq-core"]')).not.toBeNull();
    expect(view.container.querySelector('[name="earth-hq-glow"]')).toBeNull();
  });
});

const waykeeper: Agent = {
  ...fx.harmonizer,
  id: 'a-waykeeper-1',
  role: 'waykeeper',
  projectId: 'p-1',
  supervisorId: 'a-harmonizer',
  bodyId: 'b-kepler',
};
const snapshot: ServerMessage = {
  type: 'snapshot',
  logId: 'log-a',
  seq: 10,
  agents: [fx.harmonizer, waykeeper, fx.agent],
  bodies: [fx.body, fx.moon],
  projects: [fx.project],
  tasks: [fx.task],
  questions: [],
  proposals: [],
  statuses: [
    { ...fx.status, agentId: 'a-harmonizer' },
    { ...fx.status, agentId: 'a-waykeeper-1' },
    { ...fx.status, agentId: 'a-steward-1' },
  ],
};

describe('clicking the HQ station opens the Harmonizer’s chat', () => {
  beforeEach(() => {
    useConversationStore.getState().reset();
    localStorage.clear();
    localStorage.setItem('galactic.token', 'tok');
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/conversation')
          ? new Response(JSON.stringify({ entries: [], hasMore: false, lastSeq: 0 }))
          : new Response('{}'),
      ),
    );
  });

  async function open(path: string): Promise<void> {
    FakeWebSocket.instances = [];
    useAppStore.getState().reset();
    window.history.replaceState(null, '', path);
    render(<App />);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    await act(async () => {
      socket.serverOpens();
      socket.serverSends(snapshot);
    });
  }

  it('selects the Harmonizer, restores the minimised dock and switches Status to Chat', async () => {
    localStorage.setItem(SCENE_VISIBLE_KEY, '1');
    localStorage.setItem(DOCK_KEY, JSON.stringify({ open: false, size: 40 }));
    localStorage.setItem(DOCK_VIEW_KEY, 'status');
    useDockView.getState().reload();
    await open('/waykeeper/a-waykeeper-1');
    const main = () => screen.getByRole('main');
    expect(main().classList.contains('is-minimised')).toBe(true);
    expect(useDockView.getState().view).toBe('status');

    act(() => void activateSatellite('a-harmonizer'));

    expect(selectionKey(useAppStore.getState().selection)).toBe('harmonizer');
    expect(main().classList.contains('is-open')).toBe(true);
    expect(readDockPrefs()).toEqual({ open: true, size: 40 });
    expect(useDockView.getState().view).toBe('chat');
    expect(within(main()).getByRole('region', { name: 'chat with Harmonizer' })).toBeTruthy();
    // Chat for this reveal only: the stored device-wide choice is untouched…
    expect(localStorage.getItem(DOCK_VIEW_KEY)).toBe('status');
    expect(useDockView.getState().stored).toBe('status');

    // …and shows again once the selection changes (here: a Waykeeper).
    act(() => void activateSatellite('a-waykeeper-1'));
    expect(selectionKey(useAppStore.getState().selection)).toBe('waykeeper:a-waykeeper-1');
    expect(useDockView.getState().view).toBe('status');
    expect(localStorage.getItem(DOCK_VIEW_KEY)).toBe('status');
  });

  it("the user's own pick during the reveal is stored and ends the override", async () => {
    localStorage.setItem(SCENE_VISIBLE_KEY, '1');
    localStorage.setItem(DOCK_VIEW_KEY, 'status');
    useDockView.getState().reload();
    await open('/');
    act(() => void activateSatellite('a-harmonizer'));
    expect(useDockView.getState().view).toBe('chat');
    act(() => useDockView.getState().setView('chat'));
    expect(localStorage.getItem(DOCK_VIEW_KEY)).toBe('chat');
    expect(useDockView.getState().transient).toBeUndefined();
    act(() => void activateSatellite('a-waykeeper-1'));
    expect(useDockView.getState().view).toBe('chat');
  });

  it('another satellite selects its agent and leaves the dock and its view alone', async () => {
    localStorage.setItem(SCENE_VISIBLE_KEY, '1');
    localStorage.setItem(DOCK_KEY, JSON.stringify({ open: false, size: 40 }));
    localStorage.setItem(DOCK_VIEW_KEY, 'status');
    useDockView.getState().reload();
    await open('/');
    act(() => void activateSatellite('a-waykeeper-1'));
    expect(selectionKey(useAppStore.getState().selection)).toBe('waykeeper:a-waykeeper-1');
    expect(screen.getByRole('main').classList.contains('is-minimised')).toBe(true);
    expect(useDockView.getState().view).toBe('status');
  });
});
