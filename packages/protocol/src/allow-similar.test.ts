import { describe, expect, it } from 'vitest';
import { PermissionRule } from './domain.js';
import { PermissionDecided } from './events.js';
import { AllowSimilarBody } from './rest.js';

const base = {
  id: 'r-1',
  projectId: 'p-1',
  tool: 'Bash',
  categories: ['network'],
  label: 'x',
  createdBy: { type: 'user' },
  createdAt: '2026-11-09T10:00:00.000Z',
  origin: 'local',
};

describe('per-reason "Allow similar" shapes (P14-01)', () => {
  it('parses a site rule on a host', () => {
    const rule = { ...base, scope: 'site', match: { kind: 'host', host: 'github.com' } };
    expect(PermissionRule.safeParse(rule).success).toBe(true);
    expect(PermissionRule.safeParse({ ...rule, match: { kind: 'host', host: '' } }).success).toBe(
      false,
    );
  });

  it('parses a folder rule made from a command (access any)', () => {
    const rule = {
      ...base,
      scope: 'folder',
      match: { kind: 'folder', folder: '/tmp/x', access: 'any' },
    };
    expect(PermissionRule.safeParse(rule).success).toBe(true);
    expect(
      PermissionRule.safeParse({ ...rule, match: { kind: 'folder', folder: '/tmp/x' } }).success,
    ).toBe(true);
    expect(
      PermissionRule.safeParse({ ...rule, match: { kind: 'folder', folder: '/t', access: 'rw' } })
        .success,
    ).toBe(false);
  });

  it('needs at least one digest and a call digest to allow similar', () => {
    expect(AllowSimilarBody.safeParse({ digests: ['d'] }).success).toBe(false);
    expect(AllowSimilarBody.safeParse({ scope: 'exact', digest: 'x' }).success).toBe(false);
    expect(AllowSimilarBody.safeParse({ digests: [], callDigest: 'c' }).success).toBe(false);
    expect(AllowSimilarBody.safeParse({ digests: ['d'], callDigest: 'c' }).success).toBe(true);
    expect(
      AllowSimilarBody.safeParse({ digests: Array(21).fill('d'), callDigest: 'c' }).success,
    ).toBe(false);
  });

  it('parses permission.decided with ruleIds, and with only the old ruleId', () => {
    const decided = {
      type: 'permission.decided',
      agentId: 'a-1',
      toolCall: { toolName: 'Bash' },
      decision: 'allow',
      decidedBy: { type: 'system' },
    };
    expect(PermissionDecided.safeParse({ ...decided, ruleIds: ['r-1', 'r-2'] }).success).toBe(true);
    expect(PermissionDecided.safeParse({ ...decided, ruleId: 'r-1' }).success).toBe(true);
    expect(PermissionDecided.safeParse({ ...decided, ruleIds: [] }).success).toBe(false);
  });
});
