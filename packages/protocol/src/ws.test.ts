import { describe, expect, it } from 'vitest';
import { ClientMessage, HealthResponse, ServerMessage, unknownEventFrame } from './ws.js';
import * as d from './fixtures/domain.js';
import { events } from './fixtures/events.js';

describe('websocket message schemas', () => {
  it('parses hello with and without lastEventId', () => {
    expect(ClientMessage.parse({ type: 'hello', token: 't' })).toEqual({
      type: 'hello',
      token: 't',
    });
    expect(ClientMessage.parse({ type: 'hello', token: 't', lastEventId: 41 }).type).toBe('hello');
    expect(
      ClientMessage.parse({ type: 'hello', token: 't', lastEventId: 41, logId: 'log-1' }).type,
    ).toBe('hello');
    expect(ClientMessage.safeParse({ type: 'hello', token: 't', logId: '' }).success).toBe(false);
    expect(ClientMessage.safeParse({ type: 'hello', token: '' }).success).toBe(false);
    expect(ClientMessage.safeParse({ type: 'hello', token: 't', lastEventId: -1 }).success).toBe(
      false,
    );
  });

  it('parses snapshot, event, caught_up and error frames', () => {
    const snapshot = {
      type: 'snapshot',
      logId: 'log-1',
      seq: 3,
      agents: [d.agent],
      bodies: [d.body, d.moon],
      projects: [d.project],
      tasks: [d.task],
      questions: [d.question],
      proposals: [d.proposal],
      statuses: [d.status],
    };
    expect(ServerMessage.parse(snapshot)).toEqual(snapshot);
    const ev = { type: 'event', seq: 4, at: d.NOW, event: events['task.created'] };
    expect(ServerMessage.parse(ev)).toEqual(ev);
    expect(ServerMessage.parse({ type: 'caught_up', seq: 4 }).type).toBe('caught_up');
    expect(
      ServerMessage.parse({ type: 'error', code: 'unauthorized', message: 'bad token' }).type,
    ).toBe('error');
    expect(ServerMessage.safeParse({ type: 'error', code: 'teapot', message: '' }).success).toBe(
      false,
    );
  });

  it('parses status diffs and replacing sets (P1-38)', () => {
    expect(ServerMessage.safeParse({ type: 'status', statuses: [] }).success).toBe(false);
    expect(ServerMessage.safeParse({ type: 'status', statuses: [d.status] }).success).toBe(true);
    // A replacing set may be empty: every record the client holds is gone.
    expect(ServerMessage.parse({ type: 'status', statuses: [], replace: true })).toEqual({
      type: 'status',
      statuses: [],
      replace: true,
    });
    expect(ServerMessage.safeParse({ type: 'status', statuses: [], replace: false }).success).toBe(
      false,
    );
  });

  it('parses the health response', () => {
    expect(
      HealthResponse.parse({
        ok: true,
        name: 'galactic-agents',
        version: '0.0.1',
        protocolVersion: 1,
        seq: 0,
      }).ok,
    ).toBe(true);
  });
});

describe('unknownEventFrame (protocol evolution)', () => {
  const at = '2026-10-05T10:00:00.000Z';
  it('names an event frame whose envelope is valid but whose type this build does not know', () => {
    expect(
      unknownEventFrame({ type: 'event', seq: 7, at, event: { type: 'body.someday', x: 1 } }),
    ).toEqual({ seq: 7, eventType: 'body.someday' });
  });
  it('is undefined for a known type (even malformed), a broken envelope or another message', () => {
    expect(unknownEventFrame({ type: 'event', seq: 7, at, event: { type: 'agent.idle' } })).toBe(
      undefined,
    );
    expect(unknownEventFrame({ type: 'event', seq: 0, at, event: { type: 'x.y' } })).toBe(
      undefined,
    );
    expect(unknownEventFrame({ type: 'event', seq: 7, event: { type: 'x.y' } })).toBe(undefined);
    expect(unknownEventFrame({ type: 'event', seq: 7, at, event: {} })).toBe(undefined);
    expect(unknownEventFrame({ type: 'caught_up', seq: 7 })).toBe(undefined);
    expect(unknownEventFrame('nope')).toBe(undefined);
  });
});
