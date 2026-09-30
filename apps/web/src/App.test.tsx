// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { domain as fx } from '@galactic/protocol/fixtures';
import { App } from './App.js';
import { FakeWebSocket } from './client/fake-socket.js';
import { useAppStore } from './state/store.js';

beforeEach(() => {
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
afterEach(() => vi.unstubAllGlobals());

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
    expect(screen.getByText('Auth refactor')).toBeTruthy();
    expect(screen.getByText('Replace the session middleware')).toBeTruthy();

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
    expect(localStorage.getItem('galactic.lastEventId')).toBe('4');
  });

  it('asks for the token when none can be discovered, and resumes from the saved seq', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: true }))),
    );
    localStorage.setItem('galactic.lastEventId', '9');
    render(<App />);
    const input = (await screen.findByLabelText(/Paste the token/)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'pasted-token' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Connect'));
    });
    const socket = FakeWebSocket.instances[0]!;
    await act(async () => socket.serverOpens());
    expect(socket.hello).toEqual({ type: 'hello', token: 'pasted-token', lastEventId: 9 });
  });
});
