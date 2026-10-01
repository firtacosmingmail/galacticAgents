import { describe, expect, it } from 'vitest';
import {
  EVENT_TYPES,
  AgentEvent,
  Event,
  EventEnvelope,
  assertNever,
  isTranscriptEvent,
} from './events.js';
import { events } from './fixtures/events.js';

/** Compile-time exhaustiveness: every member of the union must be handled here. */
function classify(
  e: Event,
): 'agent' | 'message' | 'question' | 'proposal' | 'body' | 'project' | 'task' | 'control' {
  switch (e.type) {
    case 'agent.created':
    case 'agent.spawned':
    case 'agent.output':
    case 'agent.tool_call':
    case 'agent.needs_input':
    case 'agent.progress':
    case 'agent.idle':
    case 'agent.stalled':
    case 'agent.paused':
    case 'agent.resumed':
    case 'agent.finished':
    case 'agent.failed':
    case 'agent.stopped':
    case 'agent.interrupted':
      return 'agent';
    case 'message.sent':
    case 'message.delivered':
      return 'message';
    case 'question.opened':
    case 'question.escalated':
    case 'question.answered':
    case 'question.reassigned':
    case 'question.cancelled':
      return 'question';
    case 'proposal.created':
    case 'proposal.approved':
    case 'proposal.edited':
    case 'proposal.rejected':
    case 'proposal.parked':
      return 'proposal';
    case 'body.created':
    case 'body.assigned':
    case 'body.moved':
    case 'body.freed':
      return 'body';
    case 'project.created':
    case 'project.updated':
    case 'project.state_changed':
      return 'project';
    case 'task.created':
    case 'task.updated':
    case 'task.state_changed':
      return 'task';
    case 'control.stop':
    case 'control.cancel':
    case 'control.pause':
    case 'control.resume':
    case 'control.edit':
    case 'control.close':
    case 'control.archive':
    case 'control.pin':
    case 'control.reopen':
      return 'control';
    default:
      return assertNever(e);
  }
}

describe('event schemas', () => {
  it('has a fixture for every event type and parses each one', () => {
    expect(Object.keys(events).sort()).toEqual([...EVENT_TYPES].sort());
    for (const type of EVENT_TYPES) {
      const fixture = events[type];
      expect(Event.parse(fixture), type).toEqual(fixture);
      expect(classify(fixture)).toBe(type.split('.')[0]);
    }
  });

  it('agent.* events about a running agent are AgentEvents; agent.created and the rest are not', () => {
    for (const type of EVENT_TYPES) {
      const ok = AgentEvent.safeParse(events[type]).success;
      expect(ok, type).toBe(type.startsWith('agent.') && type !== 'agent.created');
    }
  });

  it('rejects unknown types and malformed payloads', () => {
    expect(Event.safeParse({ type: 'agent.teleported', agentId: 'a' }).success).toBe(false);
    expect(
      Event.safeParse({ type: 'agent.failed', agentId: 'a', error: 'x', reason: 'bored' }).success,
    ).toBe(false);
    expect(
      Event.safeParse({
        type: 'control.pin',
        target: { kind: 'moon', id: 'b' },
        by: { type: 'user' },
      }).success,
    ).toBe(false);
  });

  it('wraps events in a seq/at envelope', () => {
    const env = { seq: 12, at: '2026-09-30T10:00:00.000Z', event: events['agent.idle'] };
    expect(EventEnvelope.parse(env)).toEqual(env);
    expect(EventEnvelope.safeParse({ ...env, seq: 0 }).success).toBe(false);
    expect(EventEnvelope.safeParse({ ...env, at: 'now' }).success).toBe(false);
  });

  it('flags transcript traffic', () => {
    expect(isTranscriptEvent(events['agent.output'])).toBe(true);
    expect(isTranscriptEvent(events['agent.idle'])).toBe(false);
  });
});
