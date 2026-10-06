import { describe, expect, it } from 'vitest';
import {
  Agent,
  Body,
  DEFAULT_PERMISSION_POLICY,
  foldProposalMeta,
  PERMISSION_POLICY_PRESETS,
  PermissionPolicy,
  Project,
  Proposal,
  proposalTrust,
  Question,
  StatusRecord,
  Task,
  TrustLevel,
  trustLevelOf,
  wallClockCapApplies,
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

describe('trust levels (P2-22, decision 49)', () => {
  it('offers trusted: everything allowed except push, unclassified calls allowed', () => {
    const trusted = PERMISSION_POLICY_PRESETS.trusted;
    for (const action of PermissionAction.options) {
      expect(trusted.rules[action]).toBe(action === 'push' ? 'ask' : 'allow');
    }
    expect(trusted.unclassified).toBe('allow');
    for (const level of ['default', 'trusting', 'cautious'] as const) {
      expect(PERMISSION_POLICY_PRESETS[level]).not.toHaveProperty('unclassified');
    }
    expect(Object.keys(PERMISSION_POLICY_PRESETS)).toEqual(TrustLevel.options);
    expect(PermissionPolicy.safeParse({ rules: {}, unclassified: 'allow' }).success).toBe(true);
    expect(PermissionPolicy.safeParse({ rules: {}, unclassified: 'maybe' }).success).toBe(false);
  });

  it('names the level a policy amounts to', () => {
    expect(trustLevelOf(undefined)).toBe('default');
    expect(trustLevelOf({ rules: {} })).toBe('default');
    for (const level of TrustLevel.options) {
      expect(trustLevelOf(PERMISSION_POLICY_PRESETS[level])).toBe(level);
    }
    expect(trustLevelOf({ rules: { network: 'allow' } })).toBe('trusting');
    expect(trustLevelOf({ rules: { push: 'deny' } })).toBe('custom');
    // A floored trusted policy is the default table again.
    expect(trustLevelOf({ ...DEFAULT_PERMISSION_POLICY, unclassified: 'ask' })).toBe('default');
  });

  it('folds the trust chosen on a card into meta.trust; default drops it', () => {
    const meta = foldProposalMeta(undefined, { trust: 'trusted' });
    expect(meta).toEqual({ trust: 'trusted' });
    expect(proposalTrust({ meta })).toBe('trusted');
    expect(foldProposalMeta(meta, { trust: 'default' })).toBeUndefined();
    expect(foldProposalMeta({ initGit: true, trust: 'cautious' }, { parked: null })).toEqual({
      initGit: true,
      trust: 'cautious',
    });
    expect(proposalTrust({ meta: { trust: 'yolo' } })).toBe('default');
    expect(proposalTrust(undefined)).toBe('default');
  });

  it('the wall-clock cap applies to Stewards and free-form agents, not to brains (decision 103)', () => {
    expect(wallClockCapApplies({ role: 'steward' })).toBe(true);
    expect(wallClockCapApplies({})).toBe(true);
    expect(wallClockCapApplies({ role: 'harmonizer' })).toBe(false);
    expect(wallClockCapApplies({ role: 'waykeeper', meta: { cwd: '/w' } })).toBe(false);
    expect(wallClockCapApplies({ role: 'waykeeper', meta: { freeForm: true } })).toBe(true);
    expect(wallClockCapApplies({ role: 'steward', meta: { freeForm: true } })).toBe(true);
  });

  it('a status record without a wall-clock limit is valid (an uncapped brain)', () => {
    const caps = { ...fx.status.caps, wallClockMs: { used: 5_000 } };
    expect(StatusRecord.safeParse({ ...fx.status, caps }).success).toBe(true);
  });
});
