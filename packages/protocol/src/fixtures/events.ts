import type { Event, EventType } from '../events.js';
import * as d from './domain.js';

const steward = { agentId: 'a-steward-1' };
const user = { type: 'user' } as const;
const waykeeper = { type: 'agent', id: 'a-waykeeper-1' } as const;

/** One valid fixture per event type. The type of this map keeps it exhaustive. */
export const events: { [T in EventType]: Extract<Event, { type: T }> } = {
  'agent.spawned': {
    type: 'agent.spawned',
    ...steward,
    role: 'steward',
    runtime: 'claude-sdk',
    sessionRef: 'sess_123',
    bodyId: 'b-luna',
    supervisorId: 'a-waykeeper-1',
    taskId: 't-1',
  },
  'agent.output': {
    type: 'agent.output',
    ...steward,
    kind: 'text',
    text: 'Reading src/session.ts',
  },
  'agent.tool_call': {
    type: 'agent.tool_call',
    ...steward,
    toolName: 'Edit',
    toolUseId: 'tu_1',
    input: { file: 'src/session.ts' },
  },
  'agent.needs_input': {
    type: 'agent.needs_input',
    ...steward,
    questionId: 'q-1',
    kind: 'clarification',
    question: {
      text: 'Keep the legacy cookie name?',
      options: ['yes', 'no'],
    },
  },
  'agent.progress': {
    type: 'agent.progress',
    ...steward,
    summary: 'Refactoring auth module, 3 files edited, running tests',
    progress: { done: 2, total: 5 },
  },
  'agent.idle': { type: 'agent.idle', ...steward },
  'agent.stalled': { type: 'agent.stalled', ...steward, silentForMs: 120_000 },
  'agent.paused': { type: 'agent.paused', ...steward, by: user },
  'agent.resumed': { type: 'agent.resumed', ...steward, by: user },
  'agent.finished': {
    type: 'agent.finished',
    ...steward,
    result: 'Session middleware replaced; tests green.',
    cost: { usd: 1.2, inputTokens: 50_000, outputTokens: 9_000 },
  },
  'agent.failed': {
    type: 'agent.failed',
    ...steward,
    error: 'tool-call cap reached',
    reason: 'cap',
  },
  'agent.stopped': { type: 'agent.stopped', ...steward, by: waykeeper },

  'question.opened': { type: 'question.opened', question: d.question },
  'question.escalated': {
    type: 'question.escalated',
    questionId: 'q-1',
    from: waykeeper,
    to: user,
    version: 1,
  },
  'question.answered': {
    type: 'question.answered',
    questionId: 'q-1',
    answer: 'yes',
    answeredBy: waykeeper,
    version: 1,
  },
  'question.reassigned': {
    type: 'question.reassigned',
    questionId: 'q-1',
    from: waykeeper,
    to: { type: 'agent', id: 'a-harmonizer' },
    reason: 'holder a-waykeeper-1 stopped',
    version: 2,
  },

  'proposal.created': { type: 'proposal.created', proposal: d.proposal },
  'proposal.approved': { type: 'proposal.approved', proposalId: 'pr-1' },
  'proposal.edited': {
    type: 'proposal.edited',
    proposalId: 'pr-1',
    changes: { kind: 'asteroid', proposedBody: { kind: 'asteroid', name: 'Dark mode' } },
  },
  'proposal.rejected': { type: 'proposal.rejected', proposalId: 'pr-1', reason: 'not now' },
  'proposal.parked': { type: 'proposal.parked', proposalId: 'pr-1', reason: 'no free planet' },

  'body.created': { type: 'body.created', body: d.moon },
  'body.assigned': {
    type: 'body.assigned',
    bodyId: 'b-luna',
    host: { kind: 'project', id: 'p-1' },
  },
  'body.moved': {
    type: 'body.moved',
    host: { kind: 'task', id: 't-2' },
    fromBodyId: 'b-ast-1',
    toBodyId: 'b-luna',
  },
  'body.freed': { type: 'body.freed', bodyId: 'b-ast-1' },

  'project.created': { type: 'project.created', project: d.project },
  'project.updated': { type: 'project.updated', projectId: 'p-1', changes: { name: 'Auth v2' } },
  'project.state_changed': {
    type: 'project.state_changed',
    projectId: 'p-1',
    from: 'approved',
    to: 'in_progress',
  },

  'task.created': { type: 'task.created', task: d.task },
  'task.updated': { type: 'task.updated', taskId: 't-1', changes: { priority: 'urgent' } },
  'task.state_changed': {
    type: 'task.state_changed',
    taskId: 't-1',
    from: 'in_progress',
    to: 'blocked_on_user',
  },

  'control.stop': { type: 'control.stop', target: { kind: 'agent', id: 'a-steward-1' }, by: user },
  'control.cancel': { type: 'control.cancel', target: { kind: 'task', id: 't-1' }, by: user },
  'control.pause': { type: 'control.pause', target: { kind: 'task', id: 't-1' }, by: user },
  'control.resume': { type: 'control.resume', target: { kind: 'task', id: 't-1' }, by: user },
  'control.edit': {
    type: 'control.edit',
    target: { kind: 'task', id: 't-1' },
    by: user,
    changes: { description: 'Replace the session middleware (keep cookie name)' },
  },
  'control.close': { type: 'control.close', target: { kind: 'project', id: 'p-1' }, by: user },
  'control.archive': { type: 'control.archive', target: { kind: 'project', id: 'p-1' }, by: user },
  'control.pin': {
    type: 'control.pin',
    target: { kind: 'project', id: 'p-1' },
    by: user,
    pinned: true,
  },
  'control.reopen': { type: 'control.reopen', target: { kind: 'project', id: 'p-1' }, by: user },
};
