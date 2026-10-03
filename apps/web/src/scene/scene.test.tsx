// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PERMISSION_POLICY,
  type QualityTier,
  type ServerMessage,
  type SettingsPatch,
  type SettingsResponse,
} from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { App } from '../App.js';
import { FakeWebSocket } from '../client/fake-socket.js';
import type { Api } from '../console/api.js';
import { SettingsProvider, useSettingsData } from '../panel/settings/SettingsData.js';
import { useAppStore } from '../state/store.js';
import { SceneArea } from './SceneArea.js';
import type { SolarSceneProps } from './SolarScene.js';
import { SCENE_VISIBLE_KEY } from './visibility.js';

/**
 * The scene's three.js module never loads in jsdom: a stub stands in for it and records what the
 * panel hands it (the tier's config) and whether it is mounted.
 */
const scene = vi.hoisted(() => ({ mounted: 0, throwOnMount: false, webgl: true }));

vi.mock('./SolarScene.js', () => ({
  default: function StubScene({ quality }: SolarSceneProps) {
    if (scene.throwOnMount) throw new Error('Error creating WebGL context.');
    useEffect(() => {
      scene.mounted++;
      return () => {
        scene.mounted--;
      };
    }, []);
    return (
      <div
        data-testid="solar-scene"
        data-tier={quality.tier}
        data-stars={quality.stars}
        data-bloom={quality.bloom ? 'on' : 'off'}
      />
    );
  },
}));
vi.mock('./webgl.js', () => ({ webglAvailable: () => scene.webgl }));

const snapshot: ServerMessage = {
  type: 'snapshot',
  logId: 'log-a',
  seq: 1,
  agents: [fx.harmonizer],
  bodies: [fx.body],
  projects: [],
  tasks: [],
  questions: [],
  proposals: [],
  statuses: [{ ...fx.status, agentId: fx.harmonizer.id }],
};

const settingsWith = (qualityTier: QualityTier): SettingsResponse => ({
  settings: {
    projectsRoot: '/Users/me/GalacticProjects',
    defaultPermissionPolicy: structuredClone(DEFAULT_PERMISSION_POLICY),
    retentionDays: 7,
    caps: {
      maxConcurrentAgents: 4,
      maxStewardsPerWaykeeper: 3,
      maxSpawnsPerHour: 30,
      maxSpawnsPerHourPerBrain: 20,
      maxWallClockMs: 7_200_000,
      maxToolCalls: 500,
    },
    qualityTier,
    stewardsLoadUserSettings: true,
  },
  envOverrides: [],
  restartRequired: [],
  setupCompletedAt: '2026-10-01T10:00:00.000Z',
});

beforeEach(() => {
  Object.assign(scene, { mounted: 0, throwOnMount: false, webgl: true });
  FakeWebSocket.instances = [];
  localStorage.clear();
  localStorage.setItem('galactic.token', 'tok');
  useAppStore.getState().reset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.endsWith('/api/settings'))
        return new Response(JSON.stringify(settingsWith('balanced')));
      if (url.endsWith('/messages')) return new Response(JSON.stringify({ messages: [] }));
      if (url.includes('/api/preflight'))
        return new Response(
          JSON.stringify({ ok: true, checkedAt: '2026-10-03T10:00:00.000Z', runtimes: [] }),
        );
      return new Response('{}');
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

async function open(path = '/') {
  window.history.replaceState(null, '', path);
  render(<App />);
  await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
  const socket = FakeWebSocket.instances.at(-1)!;
  await act(async () => {
    socket.serverOpens();
    socket.serverSends(snapshot);
  });
}

const main = () => screen.getByRole('main', { name: 'main area' });
const sceneRegion = () => screen.queryByRole('region', { name: 'solar system' });

describe('the scene beside the panel (P3-01)', () => {
  it('is shown by default, in the centre, at the tier the settings hold', async () => {
    await open();
    await vi.waitFor(() =>
      expect(screen.getByTestId('solar-scene').dataset['tier']).toBe('balanced'),
    );
    expect(sceneRegion()).toBeTruthy();
    expect(scene.mounted).toBe(1);
    expect(screen.getByRole('button', { name: 'Hide scene' })).toBeTruthy();
    expect(within(main()).getByRole('region', { name: 'chat with Harmonizer' })).toBeTruthy();
  });

  it('"Hide scene" unmounts it, is remembered in this browser, and the panel keeps working', async () => {
    await open();
    await screen.findByTestId('solar-scene');

    fireEvent.click(screen.getByRole('button', { name: 'Hide scene' }));
    expect(sceneRegion()).toBeNull();
    expect(scene.mounted).toBe(0); // no canvas, no context, no frame loop
    expect(localStorage.getItem(SCENE_VISIBLE_KEY)).toBe('0');
    expect(screen.getByRole('button', { name: 'Show scene' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    // List mode: the chat, the navigation and the side column are all there.
    expect(within(main()).getByRole('region', { name: 'chat with Harmonizer' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'navigation' })).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'managed agents and inbox' })).toBeTruthy();

    // A reload keeps list mode.
    cleanup();
    useAppStore.getState().reset();
    await open();
    expect(screen.getByRole('button', { name: 'Show scene' })).toBeTruthy();
    expect(sceneRegion()).toBeNull();
    expect(scene.mounted).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: 'Show scene' }));
    expect(await screen.findByTestId('solar-scene')).toBeTruthy();
    expect(localStorage.getItem(SCENE_VISIBLE_KEY)).toBe('1');
  });

  it('is not mounted on the settings page', async () => {
    await open('/settings');
    expect(sceneRegion()).toBeNull();
    expect(screen.getByRole('button', { name: 'Hide scene' })).toBeTruthy();
  });

  it('without WebGL, says so and keeps list mode', async () => {
    scene.webgl = false;
    await open();
    expect(screen.getByRole('note').textContent).toMatch(/3D scene unavailable — list mode/);
    expect(screen.queryByRole('button', { name: /scene/ })).toBeNull();
    expect(sceneRegion()).toBeNull();
    expect(within(main()).getByRole('region', { name: 'chat with Harmonizer' })).toBeTruthy();
  });

  it('a scene that fails to start falls back to list mode', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    scene.throwOnMount = true;
    await open();
    await vi.waitFor(() =>
      expect(screen.getByRole('note').textContent).toMatch(/3D scene unavailable/),
    );
    expect(screen.getByRole('note').getAttribute('title')).toMatch(/WebGL context/);
    expect(sceneRegion()).toBeNull();
    expect(within(main()).getByRole('region', { name: 'chat with Harmonizer' })).toBeTruthy();
    // The choice itself is untouched: another browser session with WebGL shows the scene.
    expect(localStorage.getItem(SCENE_VISIBLE_KEY)).toBeNull();
  });
});

describe('the quality tier reaches the scene (decision 51)', () => {
  function SetTier({ tier }: { tier: QualityTier }) {
    const { patch } = useSettingsData();
    return (
      <button type="button" onClick={() => void patch({ qualityTier: tier })}>
        {tier}
      </button>
    );
  }

  it('applies a changed tier to the mounted scene without a reload', async () => {
    let current = settingsWith('high');
    const api = {
      settings: async () => current,
      patchSettings: async (p: SettingsPatch) => {
        if (p.qualityTier) current = settingsWith(p.qualityTier);
        return current;
      },
    } as unknown as Api;
    render(
      <SettingsProvider api={api}>
        <SceneArea onFailure={() => {}} />
        <SetTier tier="mobile" />
      </SettingsProvider>,
    );
    const stub = await screen.findByTestId('solar-scene');
    await vi.waitFor(() => expect(stub.dataset['tier']).toBe('high'));
    expect(stub.dataset['bloom']).toBe('on');

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'mobile' })));
    const after = screen.getByTestId('solar-scene');
    expect(after.dataset['tier']).toBe('mobile');
    expect(after.dataset['bloom']).toBe('off');
    expect(after.dataset['stars']).toBe('2000');
    expect(scene.mounted).toBe(1); // the same scene, reconfigured
  });

  it('shows the fps meter with ?fps=1', async () => {
    window.history.replaceState(null, '', '/?fps=1');
    const api = { settings: async () => settingsWith('high') } as unknown as Api;
    render(
      <SettingsProvider api={api}>
        <SceneArea onFailure={() => {}} />
      </SettingsProvider>,
    );
    expect(await screen.findByTestId('solar-scene')).toBeTruthy();
    expect(screen.getByLabelText('frame rate').textContent).toMatch(/fps/);
  });
});
