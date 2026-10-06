import { describe, expect, it } from 'vitest';
import {
  EVENT_TYPES,
  AgentEvent,
  Event,
  EventEnvelope,
  applyChanges,
  assertNever,
  isTranscriptEvent,
} from './events.js';
import { events } from './fixtures/events.js';

/** Compile-time exhaustiveness: every member of the union must be handled here. */
function classify(
  e: Event,
):
  | 'agent'
  | 'message'
  | 'question'
  | 'permission'
  | 'proposal'
  | 'promotion'
  | 'recovery'
  | 'body'
  | 'project'
  | 'task'
  | 'control' {
  switch (e.type) {
    case 'agent.created':
    case 'agent.updated':
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
    case 'agent.processes_stopped':
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
    case 'permission.decided':
      return 'permission';
    case 'proposal.created':
    case 'proposal.approved':
    case 'proposal.edited':
    case 'proposal.rejected':
    case 'proposal.parked':
    case 'proposal.unparked':
      return 'proposal';
    case 'promotion.carried_out':
      return 'promotion';
    case 'body.created':
    case 'body.assigned':
    case 'body.moved':
    case 'body.freed':
    case 'body.retired':
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
    case 'recovery.needs_attention':
      return 'recovery';
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

  it('agent.* events about a running agent are AgentEvents; the row events and the rest are not', () => {
    // The server's own agent.* events (rows, process cleanup, P4-14) never come from an adapter.
    const rowEvents = new Set(['agent.created', 'agent.updated', 'agent.processes_stopped']);
    for (const type of EVENT_TYPES) {
      const ok = AgentEvent.safeParse(events[type]).success;
      expect(ok, type).toBe(type.startsWith('agent.') && !rowEvents.has(type));
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

  it("records a user message's origin on message.sent, and only a known one (P2-21)", () => {
    const sent = { ...events['message.sent'], sender: { type: 'user' as const } };
    expect(Event.parse({ ...sent, origin: 'remote' })).toEqual({ ...sent, origin: 'remote' });
    expect(Event.parse(sent)).toEqual(sent);
    expect(Event.safeParse({ ...sent, origin: 'lan' }).success).toBe(false);
  });

  it('refuses an agent.updated that changes nothing', () => {
    expect(Event.safeParse({ type: 'agent.updated', agentId: 'a', changes: {} }).success).toBe(
      false,
    );
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

describe('clearing optional fields (P2-20)', () => {
  it('accepts null only on the clearable fields of project.updated and task.updated', () => {
    const project = (changes: unknown) =>
      Event.safeParse({ type: 'project.updated', projectId: 'p-1', changes }).success;
    const task = (changes: unknown) =>
      Event.safeParse({ type: 'task.updated', taskId: 't-1', changes }).success;
    expect(project({ parentProjectId: null, permissionPolicy: null, repoPath: null })).toBe(true);
    expect(project({ workspace: null })).toBe(false);
    expect(project({ name: null })).toBe(false);
    expect(task({ worktreePath: null, branch: null })).toBe(true);
    expect(task({ description: null })).toBe(false);
    expect(task({ projectId: null })).toBe(false);
  });

  it('folds changes: undefined is unchanged, null removes the field, a value replaces it', () => {
    const row = { id: 't-1', description: 'x', worktreePath: '/w/t', branch: 'g/t' };
    const next = applyChanges(row, { worktreePath: null, branch: undefined, description: 'y' });
    expect(next).toEqual({ id: 't-1', description: 'y', branch: 'g/t' });
    expect(next).not.toHaveProperty('worktreePath');
    expect(row.worktreePath).toBe('/w/t');
  });
});
