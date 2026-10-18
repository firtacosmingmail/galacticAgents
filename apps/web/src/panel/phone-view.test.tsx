// @vitest-environment jsdom
import { useEffect } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  openPhoneView,
  phoneViewActive,
  usePhoneView,
  type PhoneViewControl,
} from './phone-view.js';

/**
 * P8-18: on a phone the panel shows one screen at a time — the chat, the inbox or the managed
 * agents. The open view is a module store (non-React callers open the inbox) with a history entry
 * of its own, so Back closes it like the navigation sheet.
 */

let control: PhoneViewControl;
function Probe({ active }: { active: boolean }) {
  const current = usePhoneView(active);
  useEffect(() => {
    control = current;
  });
  return <p data-testid="view">{current.view}</p>;
}

/** jsdom runs a history traversal (`back()`) as a task, then fires `popstate`. */
const settleHistory = () => act(async () => new Promise((r) => setTimeout(r, 20)));
const back = async () => {
  await act(async () => {
    window.history.back();
  });
  await settleHistory();
};
const onViewEntry = () =>
  (window.history.state as { phoneView?: boolean } | null)?.phoneView === true;

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});
afterEach(async () => {
  cleanup();
  await settleHistory();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('usePhoneView', () => {
  it('starts on the chat and opens the inbox with an entry of its own', () => {
    render(<Probe active />);
    expect(control.view).toBe('chat');
    act(() => control.open('inbox'));
    expect(control.view).toBe('inbox');
    expect(onViewEntry()).toBe(true);
  });

  it('Back closes the view and leaves the page where it was', async () => {
    render(<Probe active />);
    const push = vi.spyOn(window.history, 'pushState');
    act(() => control.open('inbox'));
    expect(push).toHaveBeenCalledTimes(1);
    await back();
    expect(control.view).toBe('chat');
    expect(onViewEntry()).toBe(false);
    expect(window.location.pathname).toBe('/');
  });

  it('close() takes its entry back once', async () => {
    render(<Probe active />);
    act(() => control.open('inbox'));
    const spy = vi.spyOn(window.history, 'back');
    act(() => control.close());
    act(() => control.close());
    expect(spy).toHaveBeenCalledTimes(1);
    expect(control.view).toBe('chat');
    await settleHistory();
    expect(onViewEntry()).toBe(false);
  });

  it('switching from the inbox to the agents keeps one entry', () => {
    render(<Probe active />);
    const push = vi.spyOn(window.history, 'pushState');
    act(() => control.open('inbox'));
    act(() => control.open('agents'));
    expect(control.view).toBe('agents');
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('leaving the phone layout goes back to the chat and drops its entry', async () => {
    const { rerender } = render(<Probe active />);
    act(() => control.open('agents'));
    rerender(<Probe active={false} />);
    expect(control.view).toBe('chat');
    await settleHistory();
    expect(onViewEntry()).toBe(false);
    expect(phoneViewActive()).toBe(false);
    expect(openPhoneView('inbox')).toBe(false);
    expect(control.view).toBe('chat');
  });

  it('opens from outside React while a phone panel is mounted', () => {
    render(<Probe active />);
    expect(phoneViewActive()).toBe(true);
    let opened = false;
    act(() => {
      opened = openPhoneView('inbox');
    });
    expect(opened).toBe(true);
    expect(control.view).toBe('inbox');
  });

  it('a view entry left over from before a reload is not a view any more', () => {
    window.history.replaceState({ phoneView: true }, '', '/');
    render(<Probe active />);
    expect(control.view).toBe('chat');
    expect(window.history.state).toBeNull();
  });
});
