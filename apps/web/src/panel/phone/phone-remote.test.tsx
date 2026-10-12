// @vitest-environment jsdom
// The page as the phone loads it, through Tailscale Serve.
// @vitest-environment-options {"url": "https://mymac.tail1234.ts.net/"}
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteStatus } from '@galactic/protocol';
import { ApiContext } from '../../console/hierarchy/shared.js';
import type { Api } from '../../console/api.js';
import { PhoneAccessSection } from './PhoneAccessSection.js';

afterEach(cleanup);

const status: RemoteStatus = {
  tailscale: 'running',
  name: 'mymac.tail1234.ts.net',
  url: 'https://mymac.tail1234.ts.net',
  remoteHost: { state: 'matches', value: 'mymac.tail1234.ts.net' },
  serve: 'forwarding_to_us',
  funnel: false,
  serveOwned: true,
  ready: true,
  restartNeeded: false,
  remoteClients: { connected: 1 },
  checkedAt: '2026-10-09T10:00:00.000Z',
};

describe('Settings → Access, Phone access, on the phone (P9-16)', () => {
  it('shows the status only: no turn on / turn off', async () => {
    const api = { remoteStatus: vi.fn(async () => status) } as unknown as Api;
    render(
      <ApiContext.Provider value={api}>
        <PhoneAccessSection />
      </ApiContext.Provider>,
    );
    expect(await screen.findByText(/On: the phone can reach Mission Control/)).toBeTruthy();
    expect(screen.getByText(/turned on and off on the Mac/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
