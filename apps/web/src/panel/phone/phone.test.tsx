// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteStatus } from '@galactic/protocol';
import { ApiContext } from '../../console/hierarchy/shared.js';
import { ApiError, type Api } from '../../console/api.js';
import { useAppStore } from '../../state/store.js';
import { PhoneIndicator } from './PhoneIndicator.js';
import { PhoneAccessSection } from './PhoneAccessSection.js';
import { phoneIndicator } from './use-phone-status.js';

/** Phone access in the panel (P9-16): the top bar's indicator and Settings → Access, on the Mac. */

const NAME = 'mymac.tail1234.ts.net';
export function remoteStatus(over: Partial<RemoteStatus> = {}): RemoteStatus {
  return {
    tailscale: 'running',
    name: NAME,
    url: `https://${NAME}`,
    remoteHost: { state: 'matches', value: NAME },
    serve: 'forwarding_to_us',
    serveOwned: true,
    ready: true,
    restartNeeded: false,
    remoteClients: { connected: 1, lastSeenAt: '2026-10-09T10:00:00.000Z' },
    checkedAt: '2026-10-09T10:00:00.000Z',
    ...over,
  };
}

function fakeApi(initial: RemoteStatus) {
  let current = initial;
  const api = {
    remoteStatus: vi.fn(async () => current),
    remoteStart: vi.fn(async () => {
      current = remoteStatus();
      return { ok: true, status: current };
    }),
    remoteStop: vi.fn(async () => {
      current = remoteStatus({ serve: 'absent', serveOwned: false, ready: false, reason: 'serve_off' });
      return { ok: true, status: current };
    }),
  };
  return {
    api: api as unknown as Api,
    raw: api,
    set: (s: RemoteStatus) => (current = s),
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('phoneIndicator', () => {
  it('online, restart needed, off with the reason', () => {
    expect(phoneIndicator(remoteStatus())).toEqual({
      kind: 'online',
      label: 'Phone: online',
      tooltip: `https://${NAME} — 1 phone connected`,
    });
    expect(
      phoneIndicator(remoteStatus({ ready: false, reason: 'restart_needed', message: 'restart' })),
    ).toMatchObject({ kind: 'restart', label: 'Phone: restart needed' });
    expect(
      phoneIndicator(
        remoteStatus({ ready: false, tailscale: 'stopped', reason: 'not_running', message: 'Open it.' }),
      ),
    ).toEqual({ kind: 'off', label: 'Phone: off', tooltip: 'Tailscale not running — Open it.' });
  });
});

describe('the top bar indicator (P9-16)', () => {
  it('shows the state, names it for a screen reader, and opens Settings → Access', async () => {
    const f = fakeApi(remoteStatus());
    render(
      <ApiContext.Provider value={f.api}>
        <PhoneIndicator />
      </ApiContext.Provider>,
    );
    const button = await screen.findByRole('button', { name: /Phone: online/ });
    expect(button.getAttribute('aria-label')).toContain('1 phone connected');
    expect(button.getAttribute('title')).toBe(`https://${NAME} — 1 phone connected`);
    fireEvent.click(button);
    expect(useAppStore.getState().route).toBe('settings');
  });

  it('polls every 10 s while visible', async () => {
    vi.useFakeTimers();
    const f = fakeApi(remoteStatus({ ready: false, reason: 'not_running', tailscale: 'stopped' }));
    render(
      <ApiContext.Provider value={f.api}>
        <PhoneIndicator />
      </ApiContext.Provider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole('button').textContent).toContain('Phone: off');
    f.set(remoteStatus());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.getByRole('button').textContent).toContain('Phone: online');
    expect(f.raw.remoteStatus).toHaveBeenCalledTimes(2);
  });

  it('shows nothing when the server has no phone routes', async () => {
    const api = {
      remoteStatus: vi.fn(async () => {
        throw new ApiError(404, 'not_found');
      }),
    } as unknown as Api;
    const { container } = render(
      <ApiContext.Provider value={api}>
        <PhoneIndicator />
      </ApiContext.Provider>,
    );
    await waitFor(() => expect(api.remoteStatus).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});

describe('Settings → Access, Phone access, on the Mac (P9-16)', () => {
  const renderSection = (api: Api) =>
    render(
      <ApiContext.Provider value={api}>
        <PhoneAccessSection />
      </ApiContext.Provider>,
    );

  it('off: says why and what to do, and turns it on', async () => {
    const f = fakeApi(
      remoteStatus({
        serve: 'absent',
        serveOwned: false,
        ready: false,
        reason: 'serve_off',
        message: 'Phone access is off.',
      }),
    );
    renderSection(f.api);
    expect(await screen.findByText(/Off — turned off/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Turn on phone access' }));
    await screen.findByText(/On: the phone can reach Mission Control/);
    expect(f.raw.remoteStart).toHaveBeenCalledTimes(1);
    expect(screen.getByText(`https://${NAME}`)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Turn off phone access' })).toBeTruthy();
  });

  it('Tailscale not signed in: no button, the next step', async () => {
    const f = fakeApi(
      remoteStatus({ tailscale: 'needs_login', serve: 'unknown', ready: false, reason: 'needs_login' }),
    );
    renderSection(f.api);
    expect(await screen.findByText(/Off — Tailscale not signed in/)).toBeTruthy();
    expect(screen.getByText(/Open the Tailscale app on the Mac and sign in/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('turning off', async () => {
    const f = fakeApi(remoteStatus());
    renderSection(f.api);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off phone access' }));
    await screen.findByText(/Off — turned off/);
    expect(f.raw.remoteStop).toHaveBeenCalledTimes(1);
  });

  it('a refusal is said with the server’s message', async () => {
    const f = fakeApi(remoteStatus({ serve: 'absent', serveOwned: false, ready: false, reason: 'serve_off' }));
    f.raw.remoteStart.mockImplementationOnce(async () => {
      throw new ApiError(409, 'Tailscale Funnel is on', 'remote_refused', {
        ok: false,
        error: 'remote_refused',
        reason: 'funnel_on',
        message: 'Tailscale Funnel is on: turn it off.',
        status: remoteStatus({ serve: 'funnel_on', ready: false, reason: 'funnel_on' }),
      });
    });
    renderSection(f.api);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on phone access' }));
    expect(await screen.findByText('Tailscale Funnel is on: turn it off.')).toBeTruthy();
  });
});
