// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { domain as fx } from '@galactic/protocol/fixtures';
import { App } from './App.js';
import { FakeWebSocket } from './client/fake-socket.js';
import { useAppStore } from './state/store.js';

beforeEach(() => {
  // The event page is the ops console's (`/debug`, P25-02); `/` is the panel.
  window.history.replaceState(null, '', '/debug');
  FakeWebSocket.instances = [];
  localStorage.clear();
  useAppStore.getState().reset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/health')
        return new Response(JSON.stringify({ ok: true, token: 'tok-from-health' }));
      return new Response('{}');
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('event page', () => {
  it('discovers the token, connects, shows the snapshot and prints a live event', async () => {
    render(<App />);
    await screen.findByText('connecting');
    expect(localStorage.getItem('galactic.token')).toBe('tok-from-health');
    const socket = FakeWebSocket.instances[0]!;
    expect(socket.url).toMatch(/\/ws$/);

    await act(async () => {
      socket.serverOpens();
      socket.serverSends({
        type: 'snapshot',
        logId: 'log-a',
        seq: 3,
        agents: [],
        bodies: [fx.body],
        projects: [fx.project],
        tasks: [fx.task],
        questions: [fx.question],
        proposals: [],
        statuses: [],
      });
    });
    expect(socket.hello).toEqual({ type: 'hello', token: 'tok-from-health' });
    expect(screen.getByText('live')).toBeTruthy();
    expect(screen.getByText('seq 3')).toBeTruthy();
    expect(screen.getAllByText('Auth refactor').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Replace the session middleware').length).toBeGreaterThan(0);

    await act(async () => {
      socket.serverSends({
        type: 'event',
        seq: 4,
        at: fx.NOW,
        event: { type: 'agent.progress', agentId: 'a-demo', summary: 'Fake progress' },
      });
    });
    expect(screen.getByText('seq 4')).toBeTruthy();
    expect(screen.getByText('agent.progress')).toBeTruthy();
    expect(screen.getByText(/Fake progress/)).toBeTruthy();
    expect(localStorage.getItem('galactic.lastEventId')).toBeNull(); // P0-12: never persisted
  });

  it('asks for the token when none can be discovered, and always starts with a snapshot', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: true }))),
    );
    localStorage.setItem('galactic.lastEventId', '9'); // left behind by an earlier build
    render(<App />);
    const input = (await screen.findByLabelText(/Paste the token/)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'pasted-token' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Connect'));
    });
    const socket = FakeWebSocket.instances[0]!;
    await act(async () => socket.serverOpens());
    expect(socket.hello).toEqual({ type: 'hello', token: 'pasted-token' });
    expect(localStorage.getItem('galactic.lastEventId')).toBeNull();
  });

  it('forgets a refused token, re-discovers once, then asks for a paste (P0-17)', async () => {
    localStorage.setItem('galactic.token', 'stale-token');
    render(<App />);
    await screen.findByText('connecting');
    const s1 = FakeWebSocket.instances[0]!;
    await act(async () => s1.serverOpens());
    expect(s1.hello.token).toBe('stale-token');
    await act(async () => s1.serverCloses(4401, 'unauthorized'));
    // dropped and re-discovered from /health
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const s2 = FakeWebSocket.instances[1]!;
    await act(async () => s2.serverOpens());
    expect(s2.hello.token).toBe('tok-from-health');
    expect(localStorage.getItem('galactic.token')).toBe('tok-from-health');
    // refused again: no loop, the paste form appears
    await act(async () => s2.serverCloses(4401, 'unauthorized'));
    await screen.findByLabelText(/Paste the token/);
    expect(localStorage.getItem('galactic.token')).toBeNull();
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('shows the whole world again after a page reload, and resumes within a page life (P0-12)', async () => {
    const snapshot = {
      type: 'snapshot' as const,
      logId: 'log-a',
      seq: 3,
      agents: [],
      bodies: [fx.body],
      projects: [fx.project],
      tasks: [],
      questions: [],
      proposals: [],
      statuses: [],
    };
    const first = render(<App />);
    await screen.findByText('connecting');
    const s1 = FakeWebSocket.instances[0]!;
    await act(async () => {
      s1.serverOpens();
      s1.serverSends(snapshot);
      s1.serverSends({
        type: 'event',
        seq: 4,
        at: fx.NOW,
        event: { type: 'agent.idle', agentId: 'a-demo' },
      });
    });
    expect(screen.getAllByText('Auth refactor').length).toBeGreaterThan(0);

    // The server drops the connection: the same page resumes from seq 4 of log-a.
    await act(async () => s1.serverCloses(1006));
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const s2 = FakeWebSocket.instances[1]!;
    await act(async () => s2.serverOpens());
    expect(s2.hello).toEqual({
      type: 'hello',
      token: 'tok-from-health',
      lastEventId: 4,
      logId: 'log-a',
    });

    // The tab is killed and reopened: the new page has no world, so it must not resume.
    first.unmount();
    useAppStore.getState().reset();
    render(<App />);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(3));
    const s3 = FakeWebSocket.instances[2]!;
    await act(async () => {
      s3.serverOpens();
      s3.serverSends({ ...snapshot, seq: 4 });
    });
    expect(s3.hello).toEqual({ type: 'hello', token: 'tok-from-health' });
    expect(screen.getAllByText('Auth refactor').length).toBeGreaterThan(0);
    expect(screen.getByText('seq 4')).toBeTruthy();
  });
});

describe('a token handed over by the QR code (P7-02 review)', () => {
  it('keeps the saved token until the handed one connects, and falls back to it if refused', async () => {
    localStorage.setItem('galactic.token', 'saved-token');
    window.history.replaceState(null, '', '/debug#token=handed-token');
    render(<App />);
    await screen.findByText('connecting');
    const s1 = FakeWebSocket.instances[0]!;
    await act(async () => s1.serverOpens());
    expect(s1.hello.token).toBe('handed-token');
    expect(localStorage.getItem('galactic.token')).toBe('saved-token');
    await act(async () => s1.serverCloses(4401, 'unauthorized'));
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const s2 = FakeWebSocket.instances[1]!;
    await act(async () => s2.serverOpens());
    expect(s2.hello.token).toBe('saved-token');
    expect(localStorage.getItem('galactic.token')).toBe('saved-token');
  });

  it('saves the handed token once its session is live', async () => {
    localStorage.setItem('galactic.token', 'saved-token');
    window.history.replaceState(null, '', '/debug#token=handed-token');
    render(<App />);
    await screen.findByText('connecting');
    const socket = FakeWebSocket.instances[0]!;
    await act(async () => {
      socket.serverOpens();
      socket.serverSends({
        type: 'snapshot',
        logId: 'log-a',
        seq: 0,
        agents: [],
        bodies: [],
        projects: [],
        tasks: [],
        questions: [],
        proposals: [],
        statuses: [],
      });
    });
    expect(screen.getByText('live')).toBeTruthy();
    expect(localStorage.getItem('galactic.token')).toBe('handed-token');
    expect(window.location.hash).toBe('');
  });
});
