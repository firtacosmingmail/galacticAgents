import { describe, expect, it } from 'vitest';
import {
  Agent,
  Body,
  DEFAULT_PERMISSION_POLICY,
  PermissionPolicy,
  Project,
  Proposal,
  Question,
  StatusRecord,
  Task,
} from './domain.js';
import { AgentState, PermissionAction, WorkState } from './enums.js';
import * as fx from './fixtures/domain.js';

describe('domain schemas', () => {
  it.each([
    ['Body (planet)', Body, fx.body],
    ['Body (moon hosting a project)', Body, fx.moon],
    ['Body (asteroid hosting a task)', Body, fx.asteroid],
    ['Project', Project, fx.project],
    ['Task (project task)', Task, fx.task],
    ['Task (asteroid task)', Task, fx.asteroidTask],
    ['Agent (steward)', Agent, fx.agent],
    ['Agent (harmonizer)', Agent, fx.harmonizer],
    ['Proposal', Proposal, fx.proposal],
    ['Question (clarification)', Question, fx.question],
    ['Question (permission)', Question, fx.permissionQuestion],
    ['StatusRecord', StatusRecord, fx.status],
    ['PermissionPolicy', PermissionPolicy, fx.policy],
    ['PermissionPolicy (default)', PermissionPolicy, DEFAULT_PERMISSION_POLICY],
  ])('parses a valid %s fixture', (_name, schema, fixture) => {
    expect(schema.parse(fixture)).toEqual(fixture);
  });

  it.each([
    ['Body with an unknown kind', Body, { ...fx.body, kind: 'comet' }],
    ['Project without a workspace', Project, { ...fx.project, workspace: '' }],
    ['Task with an unknown state', Task, { ...fx.task, state: 'done' }],
    ['Agent with a bad role', Agent, { ...fx.agent, role: 'captain' }],
    [
      'Agent with non-positive caps',
      Agent,
      { ...fx.agent, caps: { maxWallClockMs: 0, maxToolCalls: 5 } },
    ],
    ['Proposal with an unknown state', Proposal, { ...fx.proposal, state: 'maybe' }],
    ['Question with an unknown kind', Question, { ...fx.question, kind: 'rhetorical' }],
    ['Question with a negative version', Question, { ...fx.question, version: -1 }],
    ['StatusRecord with a bad timestamp', StatusRecord, { ...fx.status, lastEventAt: 'yesterday' }],
    ['PermissionPolicy with an unknown decision', PermissionPolicy, { rules: { push: 'maybe' } }],
  ])('rejects %s', (_name, schema, bad) => {
    expect(schema.safeParse(bad).success).toBe(false);
  });

  it('covers every action in the default permission policy', () => {
    for (const action of PermissionAction.options) {
      expect(DEFAULT_PERMISSION_POLICY.rules[action]).toBeDefined();
    }
  });

  it('exposes the state enums from the docs', () => {
    expect(AgentState.options).toEqual([
      'starting',
      'working',
      'waiting_for_input',
      'idle',
      'stalled',
      'paused',
      'interrupted',
      'finished',
      'failed',
      'stopped',
    ]);
    expect(WorkState.options).toContain('blocked_on_user');
    expect(WorkState.options).toContain('awaiting_closure');
  });
});
