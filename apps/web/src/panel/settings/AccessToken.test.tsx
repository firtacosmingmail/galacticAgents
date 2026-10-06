import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { IDENTITY_TOKEN } from '../../client/session.js';
import { AccessToken } from './AccessToken.js';

afterEach(cleanup);

describe('AccessToken on a device signed in by its Tailscale identity (P7-02)', () => {
  it('shows no token, no reveal and no QR code', () => {
    render(
      <AccessToken
        token={IDENTITY_TOKEN}
        remote={{ host: 'mymac.tail1234.ts.net', tailscaleIdentity: true }}
      />,
    );
    const access = screen.getByRole('region', { name: 'Access' });
    expect(access.textContent).toMatch(/signed in by its Tailscale identity/);
    expect(access.textContent).not.toContain(IDENTITY_TOKEN);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });
});
