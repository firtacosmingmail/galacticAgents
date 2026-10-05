// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axeFindings, blocking, type AxeFinding } from '../a11y/a11y-fixtures.js';
import { PwaNotices } from './PwaNotices.js';
import { INSTALL_DISMISSED_KEY, usePwa, type InstallPromptEvent } from './register.js';

/**
 * The installable app's notices (P7-01): the "new version" notice and the install offers, in a
 * polite live region, without serious or critical axe findings (P5-04's bar).
 */

beforeEach(() => {
  localStorage.clear();
  usePwa.setState({ update: undefined, install: undefined, iosHint: false });
});
afterEach(cleanup);

async function noBlockingFindings(name: string) {
  expect(blocking(await axeFindings()), name).toEqual<AxeFinding[]>([]);
}

describe('PWA notices (P7-01)', () => {
  it('shows nothing until there is something to say, in a polite live region', async () => {
    render(<PwaNotices />);
    const region = screen.getByRole('complementary', { name: 'App notices' });
    expect(screen.getByRole('status').textContent).toBe('');
    expect(region.querySelectorAll('button')).toHaveLength(0);
    await noBlockingFindings('empty');
  });

  it('offers a reload after a deploy; Later hides it', async () => {
    const update = vi.fn();
    usePwa.setState({ update });
    render(<PwaNotices />);
    expect(screen.getByRole('status').textContent).toContain(
      'A new version of GalacticAgents is available.',
    );
    await noBlockingFindings('update');
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(update).toHaveBeenCalledTimes(1);
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Later' })));
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
  });

  it('offers the install; Not now is remembered', async () => {
    const prompt = vi.fn(async () => undefined);
    const offer = Object.assign(new Event('beforeinstallprompt'), {
      prompt,
      userChoice: Promise.resolve({ outcome: 'accepted' as const }),
    }) as InstallPromptEvent;
    usePwa.setState({ install: offer });
    render(<PwaNotices />);
    await noBlockingFindings('install');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    });
    expect(prompt).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();

    act(() => usePwa.setState({ install: offer }));
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Not now' })));
    expect(localStorage.getItem(INSTALL_DISMISSED_KEY)).toBe('1');
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
  });

  it('explains Add to Home Screen on iOS', async () => {
    usePwa.setState({ iosHint: true });
    render(<PwaNotices />);
    expect(screen.getByRole('status').textContent).toContain('Add to Home Screen');
    await noBlockingFindings('ios');
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Got it' })));
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('puts the update first: one notice at a time', () => {
    usePwa.setState({ update: vi.fn(), iosHint: true });
    render(<PwaNotices />);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Reload', 'Later']);
  });
});
