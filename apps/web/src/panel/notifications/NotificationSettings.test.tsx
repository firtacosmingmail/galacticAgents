// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, Question, ServerMessage, StatusRecord } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { App } from '../../App.js';
import { FakeWebSocket } from '../../client/fake-socket.js';
import { useAppStore } from '../../state/store.js';
import { FakeNotification } from './fake-notification.js';
import { clearLedgerMemory } from './ledger.js';
import { NotificationSettings } from './NotificationSettings.js';
import { PREFS_KEY, useNotificationPrefs } from './prefs.js';

/** P25-07: the settings component, the permission prompt, and the top bar's control in the panel. */

const storedPrefs = () =>
  JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Record<string, unknown>;

beforeEach(() => {
  localStorage.clear();
  clearLedgerMemory();
  FakeNotification.reset('default');
  vi.stubGlobal('Notification', FakeNotification);
  useNotificationPrefs.getState().reload();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

const click = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
    await Promise.resolve();
  });
};

describe('NotificationSettings', () => {
  it('asks the browser for permission only when the user clicks Enable', async () => {
    render(<NotificationSettings />);
    expect(FakeNotification.requests).toBe(0);
    await click(screen.getByRole('button', { name: 'Enable desktop notifications' }));
    expect(FakeNotification.requests).toBe(1);
    expect(await screen.findByText(/On in this browser/)).toBeTruthy();
    expect(storedPrefs()).toMatchObject({ enabled: true });

    await click(screen.getByRole('button', { name: 'Send a test' }));
    expect(FakeNotification.instances.map((n) => n.title)).toEqual(['GalacticAgents']);

    await click(screen.getByRole('button', { name: 'Turn off' }));
    expect(storedPrefs()).toMatchObject({ enabled: false });
    // Granted already: enabling again does not prompt.
    await click(screen.getByRole('button', { name: 'Enable desktop notifications' }));
    expect(FakeNotification.requests).toBe(1);
  });

  it('explains a refusal and stays off', async () => {
    FakeNotification.nextAnswer = 'denied';
    render(<NotificationSettings />);
    await click(screen.getByRole('button', { name: 'Enable desktop notifications' }));
    expect(await screen.findByText(/blocked for this site/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Enable desktop notifications' })).toBeNull();
    expect(useNotificationPrefs.getState().enabled).toBe(false);
  });

  it('says so when the browser has no Notification API', () => {
    vi.stubGlobal('Notification', undefined);
    useNotificationPrefs.getState().reload();
    render(<NotificationSettings />);
    expect(screen.getByText(/cannot show desktop notifications/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Enable desktop notifications' })).toBeNull();
  });

  it('keeps one switch per kind in this browser', async () => {
    render(<NotificationSettings />);
    const box = screen.getByRole('checkbox', { name: 'A task finished' }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    await click(box);
    expect(box.checked).toBe(false);
    expect(storedPrefs()).toMatchObject({ kinds: { task_completed: false, task_failed: true } });
    expect(screen.getAllByRole('checkbox')).toHaveLength(8);
  });
});

describe('notifications in the panel', () => {
  const waykeeper: Agent = {
    ...fx.harmonizer,
    id: 'a-waykeeper-1',
    role: 'waykeeper',
    projectId: 'p-1',
    supervisorId: 'a-harmonizer',
    bodyId: 'b-luna',
  };
  const live = (agentId: string): StatusRecord => ({ ...fx.status, agentId });

  beforeEach(() => {
    FakeWebSocket.instances = [];
    localStorage.setItem('galactic.token', 'tok');
    useAppStore.getState().reset();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ entries: [], hasMore: false, lastSeq: 0 }))),
    );
  });

  it('enables from the top bar and a stream event notifies; the click opens its thread', async () => {
    render(<App />);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    await act(async () => {
      socket.serverOpens();
      socket.serverSends({
        type: 'snapshot',
        logId: 'log-a',
        seq: 10,
        agents: [fx.harmonizer, waykeeper, fx.agent],
        bodies: [fx.body, fx.moon],
        projects: [fx.project],
        tasks: [fx.task],
        questions: [],
        proposals: [],
        statuses: [live('a-harmonizer'), live('a-waykeeper-1'), live('a-steward-1')],
      } satisfies ServerMessage);
    });

    const toggle = screen.getByRole('button', { name: 'Notifications: off' });
    expect(FakeNotification.requests).toBe(0);
    await click(toggle);
    const popover = screen.getByRole('dialog', { name: 'notification settings' });
    await click(within(popover).getByRole('button', { name: 'Enable desktop notifications' }));
    expect(FakeNotification.requests).toBe(1);
    expect(await screen.findByRole('button', { name: 'Notifications: on' })).toBeTruthy();

    const question: Question = { ...fx.question, holder: { type: 'user' } };
    await act(async () => {
      socket.serverSends({
        type: 'event',
        seq: 11,
        at: fx.NOW,
        event: { type: 'question.opened', question },
      });
    });
    expect(FakeNotification.instances.map((n) => n.tag)).toEqual(['question:q-1']);

    vi.spyOn(window, 'focus').mockImplementation(() => {});
    await act(async () => FakeNotification.instances[0]!.onclick!());
    // The Steward's question shows in its project's Waykeeper's thread (decision 55).
    expect(useAppStore.getState().selection).toEqual({ kind: 'waykeeper', id: 'a-waykeeper-1' });
    expect(window.location.pathname).toBe('/waykeeper/a-waykeeper-1');
  });
});
