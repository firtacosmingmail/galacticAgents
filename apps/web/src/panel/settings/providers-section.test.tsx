// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PERMISSION_POLICY,
  type PreflightResponse,
  type ServerMessage,
  type SettingsPatch,
  type SettingsResponse,
} from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { App } from '../../App.js';
import { FakeWebSocket } from '../../client/fake-socket.js';
import { useAppStore } from '../../state/store.js';
import { resetsIn, usageWindowText } from './settings-model.js';

const TOKEN = 'tok-0123456789abcdefWXYZ';

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

const settings = (): SettingsResponse => ({
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
    qualityTier: 'high',
    stewardsLoadUserSettings: true,
  },
  envOverrides: [],
  restartRequired: [],
  setupCompletedAt: '2026-10-03T10:05:00.000Z',
});

const resetsAt = new Date(Date.now() + 125 * 60_000).toISOString();
const preflight: PreflightResponse = {
  ok: false,
  checkedAt: '2026-10-03T10:01:00.000Z',
  runtimes: [
    {
      runtime: 'claude-sdk',
      provider: 'claude',
      ok: true,
      installed: true,
      version: '2.1.0',
      loggedIn: true,
      models: [
        { id: 'opus', label: 'Opus', isDefault: false, capabilities: ['text'], family: 'claude' },
      ],
      problems: [],
    },
    {
      runtime: 'codex',
      provider: 'chatgpt',
      ok: true,
      installed: true,
      version: '0.9.0',
      loggedIn: true,
      usage: { plan: 'plus', windows: [{ label: '5 hours', remainingFraction: 0.42, resetsAt }] },
      models: [
        {
          id: 'gpt-5.6-terra',
          label: 'GPT-5.6 Terra',
          isDefault: true,
          capabilities: ['text'],
          family: 'gpt',
        },
      ],
      problems: [],
    },
    {
      runtime: 'agy',
      provider: 'gemini',
      ok: false,
      installed: true,
      loggedIn: false,
      problems: [
        { code: 'not_logged_in', severity: 'error', message: 'Antigravity is not logged in.' },
      ],
    },
  ],
};

const patches: SettingsPatch[] = [];
let current: SettingsResponse;

beforeEach(() => {
  FakeWebSocket.instances = [];
  patches.length = 0;
  localStorage.clear();
  localStorage.setItem('galactic.token', TOKEN);
  useAppStore.getState().reset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

async function open(initial = settings()) {
  current = initial;
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/settings' && init?.method === 'PATCH') {
        const patch = JSON.parse(String(init.body)) as SettingsPatch;
        patches.push(patch);
        const next = structuredClone(current);
        if (patch.defaultProvider !== undefined) {
          if (patch.defaultProvider === null) delete next.settings.defaultProvider;
          else next.settings.defaultProvider = patch.defaultProvider;
        }
        for (const [p, v] of Object.entries(patch.providers ?? {})) {
          const providers = (next.settings.providers ??= {});
          const model = v.model ?? undefined;
          providers[p as 'claude'] = model === undefined ? {} : { model };
        }
        current = next;
        return json(next);
      }
      if (url === '/api/settings') return json(current);
      if (url.startsWith('/api/preflight')) return json(preflight);
      if (url.endsWith('/messages')) return json({ messages: [] });
      return json({});
    }),
  );
  window.history.replaceState(null, '', '/settings');
  render(<App />);
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  const socket = FakeWebSocket.instances[0]!;
  await act(async () => {
    socket.serverOpens();
    socket.serverSends(snapshot);
  });
  return screen.findByRole('region', { name: 'AI providers' });
}

const click = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
  });
};

describe('the AI providers on the settings page (P11-09)', () => {
  it('lists each provider with its login state and limits', async () => {
    await open();
    const check = await screen.findByRole('region', { name: 'Runtime check' });
    const codex = await within(check).findByRole('group', { name: 'runtime codex' });
    expect(within(codex).getByText(/Codex \(ChatGPT\) — ready/)).toBeTruthy();
    expect(within(codex).getByText('plus')).toBeTruthy();
    expect(within(codex).getByText(/5 hours: 42% left · resets in 2 h 5 min/)).toBeTruthy();
    const agy = within(check).getByRole('group', { name: 'runtime agy' });
    expect(within(agy).getByText(/Antigravity \(Gemini\) — not ready/)).toBeTruthy();
    expect(within(agy).getByText(/Antigravity is not logged in/)).toBeTruthy();
    expect(within(check).getByRole('group', { name: 'runtime claude-sdk' })).toBeTruthy();
  });

  it('default model select saves providers.chatgpt.model', async () => {
    const providers = await open();
    const select = (await within(providers).findByLabelText(
      'ChatGPT default model',
    )) as HTMLSelectElement;
    expect(select.value).toBe('');
    fireEvent.change(select, { target: { value: 'gpt-5.6-terra' } });
    await click(within(providers).getByRole('button', { name: /^Save/ }));
    expect(patches).toEqual([{ providers: { chatgpt: { model: 'gpt-5.6-terra' } } }]);
  });

  it('CLI default clears it', async () => {
    const initial = settings();
    initial.settings.providers = { chatgpt: { model: 'gpt-5.6-terra' } };
    const providers = await open(initial);
    const select = (await within(providers).findByLabelText(
      'ChatGPT default model',
    )) as HTMLSelectElement;
    expect(select.value).toBe('gpt-5.6-terra');
    fireEvent.change(select, { target: { value: '' } });
    await click(within(providers).getByRole('button', { name: /^Save/ }));
    expect(patches).toEqual([{ providers: { chatgpt: { model: null } } }]);
  });

  it('default provider offers only providers that are set up', async () => {
    const providers = await open();
    await within(providers).findByLabelText('ChatGPT default model');
    const labels = within(providers)
      .getAllByRole('radio')
      .map((r) => (r as HTMLInputElement).value);
    expect(labels).toEqual(['claude', 'chatgpt']);
    expect(
      (within(providers).getByRole('radio', { name: /Claude/ }) as HTMLInputElement).checked,
    ).toBe(true);
    await click(within(providers).getByRole('radio', { name: /ChatGPT/ }));
    await click(within(providers).getByRole('button', { name: /^Save/ }));
    expect(patches).toEqual([{ defaultProvider: 'chatgpt' }]);
  });

  it('keeps a saved default provider that is no longer set up on offer', async () => {
    const initial = settings();
    initial.settings.defaultProvider = 'gemini';
    const providers = await open(initial);
    await within(providers).findByLabelText('ChatGPT default model');
    const gemini = within(providers).getByRole('radio', { name: /Gemini/ }) as HTMLInputElement;
    expect(gemini.checked).toBe(true);
    expect(within(providers).getByText(/not set up/)).toBeTruthy();
  });

  it('no Steward runtime section any more', async () => {
    await open();
    expect(screen.queryByRole('region', { name: 'Steward runtime' })).toBeNull();
  });

  it('renders at phone width without a fixed width that could overflow', async () => {
    window.innerWidth = 320;
    const providers = await open();
    await within(providers).findByLabelText('ChatGPT default model');
    // jsdom does no layout: what keeps the rows inside 320 px is wrapping and a capped select.
    expect(
      within(providers).getByLabelText('ChatGPT default model').closest('.set-inline'),
    ).toBeTruthy();
    for (const el of providers.querySelectorAll<HTMLElement>('[style]')) {
      expect(el.style.width).toBe('');
    }
  });
});

describe('usage text', () => {
  it('words a window and its reset', () => {
    const now = Date.parse('2026-10-03T10:00:00Z');
    expect(resetsIn('2026-10-03T10:30:00Z', now)).toBe('in 30 min');
    expect(resetsIn('2026-10-03T12:00:00Z', now)).toBe('in 2 h');
    expect(resetsIn('2026-10-06T10:00:00Z', now)).toBe('in 3 days');
    expect(resetsIn('2026-10-03T09:00:00Z', now)).toBe('now');
    expect(usageWindowText({ label: 'weekly', remainingFraction: 0.9 }, now)).toBe(
      'weekly: 90% left',
    );
  });
});
