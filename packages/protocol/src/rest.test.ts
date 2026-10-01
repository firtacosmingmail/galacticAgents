import { describe, expect, it } from 'vitest';
import { PERMISSION_POLICY_PRESETS } from './domain.js';
import { ENDED_STATES } from './enums.js';
import {
  AnswerBody,
  PermissionPolicyPresetName,
  RuntimesInfo,
  SendBody,
  SpawnBody,
} from './rest.js';

describe('REST body schemas (P1-38)', () => {
  it('derives the policy names from the presets', () => {
    expect(PermissionPolicyPresetName.options).toEqual(Object.keys(PERMISSION_POLICY_PRESETS));
  });

  it('fills the spawn defaults and refuses unknown policies', () => {
    expect(SpawnBody.parse({ runtime: 'fake', prompt: 'p', cwd: '/tmp' })).toEqual({
      role: 'steward',
      runtime: 'fake',
      prompt: 'p',
      cwd: '/tmp',
      policy: 'default',
    });
    expect(
      SpawnBody.safeParse({ runtime: 'fake', prompt: 'p', cwd: '/tmp', policy: 'yolo' }).success,
    ).toBe(false);
    expect(SpawnBody.safeParse({ runtime: 'fake', prompt: '', cwd: '/tmp' }).success).toBe(false);
  });

  it('parses send, answer and runtimes bodies', () => {
    expect(SendBody.parse({ text: 'hi', interrupt: true })).toEqual({
      text: 'hi',
      interrupt: true,
    });
    expect(SendBody.safeParse({ text: '' }).success).toBe(false);
    expect(AnswerBody.safeParse({}).success).toBe(false);
    expect(
      RuntimesInfo.parse({
        runtimes: [{ name: 'fake', resumable: true, scenarios: ['echo'] }],
        policies: ['default', 'cautious'],
        caps: { maxWallClockMs: 1000, maxToolCalls: 5 },
        maxConcurrentAgents: 2,
      }).runtimes[0]?.name,
    ).toBe('fake');
    expect(
      RuntimesInfo.safeParse({
        runtimes: [],
        policies: ['yolo'],
        caps: { maxWallClockMs: 1000, maxToolCalls: 5 },
        maxConcurrentAgents: 2,
      }).success,
    ).toBe(false);
  });

  it('names the ended agent states', () => {
    expect([...ENDED_STATES].sort()).toEqual(['failed', 'finished', 'interrupted', 'stopped']);
  });
});
