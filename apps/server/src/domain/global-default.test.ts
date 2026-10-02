import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PERMISSION_POLICY, PERMISSION_POLICY_PRESETS } from '@galactic/protocol';
import { CapsEnforcer } from '../runtime/caps.js';
import {
  decide,
  globalDefaultPolicy,
  noLooserThan,
  policyForWrite,
  resolvePolicy,
  setGlobalDefaultPolicy,
} from './permissions.js';

afterEach(() => setGlobalDefaultPolicy(null));

describe('the settable global default table (P25-01; decision 22)', () => {
  it('is the SPEC table until set, and every merge and floor follows it', () => {
    expect(globalDefaultPolicy()).toEqual(DEFAULT_PERMISSION_POLICY);
    expect(decide({ rules: {} }, ['network'])).toBe('ask');

    setGlobalDefaultPolicy({ rules: { network: 'allow', edit_workspace: 'ask' } });
    // Left-out categories keep the SPEC's value.
    expect(globalDefaultPolicy().rules).toEqual({
      ...DEFAULT_PERMISSION_POLICY.rules,
      network: 'allow',
      edit_workspace: 'ask',
    });
    // A project without a table of its own decides by it.
    expect(resolvePolicy().rules.network).toBe('allow');
    expect(decide({ rules: {} }, ['network'])).toBe('allow');
    expect(decide({ rules: {} }, ['edit_workspace'])).toBe('ask');
    // A project's own table still overrides per category.
    expect(decide({ rules: { network: 'deny' } }, ['network'])).toBe('deny');
    // The remote floor is the configured default now.
    const floored = policyForWrite(PERMISSION_POLICY_PRESETS.trusted, { origin: 'remote' });
    expect(floored.rules.edit_workspace).toBe('ask');
    expect(floored.rules.network).toBe('allow');
    expect(noLooserThan({ rules: { push: 'allow' } }).rules.push).toBe('ask');

    setGlobalDefaultPolicy(null);
    expect(globalDefaultPolicy()).toEqual(DEFAULT_PERMISSION_POLICY);
  });
});

describe('CapsEnforcer.update (P25-01)', () => {
  it('changes the limits for the next spawn and the next agent', () => {
    const caps = new CapsEnforcer({
      maxConcurrentAgents: 1,
      defaults: { maxWallClockMs: 60_000, maxToolCalls: 5 },
      onCapHit: () => {},
    });
    caps.track('s1', caps.resolve(), { role: 'steward' });
    expect(caps.canSpawn({ role: 'steward' }).ok).toBe(false);
    caps.update({
      maxConcurrentAgents: 2,
      maxSpawnsPerHour: 3,
      defaults: { maxWallClockMs: 1, maxToolCalls: 9 },
    });
    expect(caps.canSpawn({ role: 'steward' }).ok).toBe(true);
    expect(caps.spawnCaps.maxSpawnsPerHour).toBe(3);
    expect(caps.spawnCaps.maxStewardsPerWaykeeper).toBe(3);
    expect(caps.resolve().maxToolCalls).toBe(9);
    // The running agent keeps its caps.
    expect(caps.usage('s1')?.toolCalls.limit).toBe(5);
    caps.dispose();
  });
});
