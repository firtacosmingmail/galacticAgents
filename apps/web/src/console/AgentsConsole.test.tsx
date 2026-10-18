// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { domain as fx } from '@galactic/protocol/fixtures';
import { AgentsConsole } from './AgentsConsole.js';
import { useAppStore } from '../state/store.js';

/** The console against a mocked `/api` and a hand-fed store (P1-11). */

const calls: { url: string; init?: RequestInit }[] = [];
const subscribed: string[] = [];
const unsubscribed: string[] = [];
/** Whether `/send` is refused (409) or accepted. */
let sendRefused = true;

beforeEach(() => {
  calls.length = subscribed.length = unsubscribed.length = 0;
  sendRefused = true;
  useAppStore.getState().reset();
  useAppStore.setState({
    status: 'live',
    subscribeTranscript: (id) => subscribed.push(id),
    unsubscribeTranscript: (id) => unsubscribed.push(id),
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init ? { init } : {}) });
      if (url === '/api/runtimes') {
        return new Response(
          JSON.stringify({
            runtimes: [
              { name: 'fake', resumable: true, scenarios: ['happy', 'asks'] },
              { name: 'claude-sdk', resumable: true },
            ],
            policies: ['default', 'trusting', 'cautious'],
            caps: { maxWallClockMs: 1, maxToolCalls: 1 },
            maxConcurrentAgents: 4,
          }),
        );
      }
      if (url === '/api/agents') return new Response(JSON.stringify({ agentId: 'a-new' }));
      if (url.endsWith('/send') && !sendRefused) {
        return new Response(JSON.stringify({ messageId: 'm-1' }));
      }
      if (url.endsWith('/send')) {
        return new Response(JSON.stringify({ error: 'rejected', message: 'agent is busy' }), {
          status: 409,
        });
      }
      return new Response(JSON.stringify({ ok: true }));
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const bodyOf = (call: { init?: RequestInit }) => JSON.parse(call.init?.body as string);
const authOf = (call: { init?: RequestInit }) =>
  (call.init?.headers as Record<string, string>)['authorization'];

describe('ops console', () => {
  it('fills the spawn form from /api/runtimes and spawns with the token', async () => {
    render(<AgentsConsole token="tok" />);
    await screen.findByText('No agents yet — spawn one above.');
    await vi.waitFor(() =>
      expect(screen.getAllByRole('option').map((o) => o.textContent)).toContain('asks'),
    );
    expect(authOf(calls[0]!)).toBe('Bearer tok');

    fireEvent.change(screen.getByDisplayValue('happy'), { target: { value: 'scenario:asks' } });
    fireEvent.change(screen.getByPlaceholderText('/path/to/workspace'), {
      target: { value: '/work' },
    });
    fireEvent.change(screen.getByDisplayValue('default'), { target: { value: 'cautious' } });
    await act(async () => {
      fireEvent.click(screen.getByText('Spawn'));
    });
    const spawn = calls.find((c) => c.url === '/api/agents')!;
    expect(bodyOf(spawn)).toEqual({
      runtime: 'fake',
      prompt: 'scenario:asks',
      cwd: '/work',
      policy: 'cautious',
    });
  });

  it('shows the agents, subscribes to the selected transcript and sends controls', async () => {
    useAppStore.setState((s) => ({
      world: {
        ...s.world,
        agents: {
          [fx.agent.id]: fx.agent,
          [fx.harmonizer.id]: { ...fx.harmonizer, createdAt: '2026-09-30T11:00:00.000Z' },
        },
        statuses: { [fx.status.agentId]: fx.status },
      },
      transcripts: {
        [fx.agent.id]: [
          { seq: 1, agentId: fx.agent.id, kind: 'text', text: 'hello world', at: fx.NOW },
        ],
      },
    }));
    render(<AgentsConsole token="tok" />);
    // the newest agent is selected by default; both are listed
    expect(screen.getAllByText('steward · claude-sdk').length).toBeGreaterThan(0);
    expect(screen.getAllByText('harmonizer · claude-sdk').length).toBe(2); // row + panel
    expect(subscribed).toEqual([fx.harmonizer.id]);

    fireEvent.click(screen.getAllByText('steward · claude-sdk')[0]!);
    expect(unsubscribed).toEqual([fx.harmonizer.id]);
    expect(subscribed).toEqual([fx.harmonizer.id, fx.agent.id]);
    expect(screen.getAllByText('Editing src/session.ts').length).toBe(2); // row + facts
    expect(screen.getByText('$0.4200')).toBeTruthy();
    expect(screen.getByText('17 / 500')).toBeTruthy();
    expect(screen.getByText(/hello world/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText('Pause'));
    });
    expect(calls.at(-1)!.url).toBe(`/api/agents/${fx.agent.id}/pause`);

    // a refused call shows the server's reason
    fireEvent.change(screen.getByPlaceholderText('message to the agent'), {
      target: { value: 'carry on' },
    });
    fireEvent.click(screen.getByLabelText('interrupt'));
    await act(async () => {
      fireEvent.click(screen.getByText('Send'));
    });
    expect(bodyOf(calls.at(-1)!)).toEqual({ text: 'carry on', interrupt: true });
    await screen.findByText('agent is busy');
    // … and keeps the text and the checkbox for another try (P1-38).
    const input = screen.getByPlaceholderText('message to the agent') as HTMLInputElement;
    expect(input.value).toBe('carry on');
    expect((screen.getByLabelText('interrupt') as HTMLInputElement).checked).toBe(true);

    sendRefused = false;
    await act(async () => {
      fireEvent.click(screen.getByText('Send'));
    });
    expect(input.value).toBe('');
    expect((screen.getByLabelText('interrupt') as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByText('agent is busy')).toBeNull();
  });

  it('answers clarification and permission questions', async () => {
    const waiting = { ...fx.status, state: 'waiting_for_input' as const, pendingQuestionId: 'q-1' };
    useAppStore.setState((s) => ({
      world: {
        ...s.world,
        agents: { [fx.agent.id]: fx.agent },
        statuses: { [fx.agent.id]: waiting },
        questions: { 'q-1': fx.question, 'q-2': { ...fx.permissionQuestion, status: 'open' } },
      },
    }));
    render(<AgentsConsole token="tok" />);
    expect(screen.getByText('Keep the legacy cookie name?')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText('yes'));
    });
    expect(calls.at(-1)!.url).toBe('/api/questions/q-1/answer');
    expect(bodyOf(calls.at(-1)!)).toEqual({ answer: 'yes' });

    act(() => {
      useAppStore.setState((s) => ({
        world: {
          ...s.world,
          statuses: { [fx.agent.id]: { ...waiting, pendingQuestionId: 'q-2' } },
        },
      }));
    });
    expect(screen.getByText('Permission request')).toBeTruthy();
    expect(screen.getByText('Bash', { exact: false }).textContent).toContain('git push origin');
    await act(async () => {
      fireEvent.click(screen.getByText('Allow'));
    });
    expect(calls.at(-1)!.url).toBe('/api/questions/q-2/answer');
    expect(bodyOf(calls.at(-1)!)).toEqual({ answer: 'allow' });
  });

  it('shows a question-set row read-only: it is answered in the inbox (P8-21)', () => {
    const row = {
      ...fx.question,
      context: {
        ...fx.question.context,
        set: { id: 'qs-1', index: 0, total: 2, title: 'Plan questions' },
      },
    };
    useAppStore.setState((s) => ({
      world: {
        ...s.world,
        agents: { [fx.agent.id]: fx.agent },
        statuses: {
          [fx.agent.id]: {
            ...fx.status,
            state: 'waiting_for_input' as const,
            pendingQuestionId: 'q-1',
          },
        },
        questions: { 'q-1': row },
      },
    }));
    render(<AgentsConsole token="tok" />);
    expect(screen.getByText('Keep the legacy cookie name?')).toBeTruthy();
    expect(
      screen.getByText(/Part of the question set “Plan questions”: answer it in the inbox/),
    ).toBeTruthy();
    expect(screen.queryByText('yes')).toBeNull();
  });

  it('offers to resume an interrupted session and nothing else', () => {
    useAppStore.setState((s) => ({
      world: {
        ...s.world,
        agents: { [fx.agent.id]: fx.agent },
        statuses: { [fx.agent.id]: { ...fx.status, state: 'interrupted' } },
      },
    }));
    render(<AgentsConsole token="tok" />);
    expect(screen.getByText('Resume session')).toBeTruthy();
    expect((screen.getByText('Pause') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('Stop') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByPlaceholderText('agent has ended') as HTMLInputElement).disabled).toBe(
      true,
    );
  });
});
