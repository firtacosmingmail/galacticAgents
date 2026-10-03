import { describe, expect, it } from 'vitest';
import { DEFAULT_PERMISSION_POLICY } from '@galactic/protocol';
import { ApiError } from '../../console/api.js';
import {
  capsDraft,
  isSettingsResponse,
  isSpecTable,
  parseCaps,
  policyValue,
  refusalMessage,
  validateProjectsRoot,
  validateRetention,
  withPolicyValue,
} from './settings-model.js';

const caps = {
  maxConcurrentAgents: 4,
  maxStewardsPerWaykeeper: 3,
  maxSpawnsPerHour: 30,
  maxSpawnsPerHourPerBrain: 20,
  maxWallClockMs: 7_200_000,
  maxToolCalls: 500,
};

describe('settings model (P25-08)', () => {
  it('checks the projects root as the server would, where the browser can', () => {
    expect(validateProjectsRoot('/Users/me/Projects')).toBeUndefined();
    expect(validateProjectsRoot('~/Projects')).toBeUndefined();
    expect(validateProjectsRoot('')).toMatch(/Enter/);
    expect(validateProjectsRoot('Projects')).toMatch(/absolute/);
    expect(validateProjectsRoot('/')).toMatch(/root folder/);
    expect(validateProjectsRoot('~')).toMatch(/home/);
    expect(validateProjectsRoot('~/')).toMatch(/home/);
  });

  it('checks the retention period', () => {
    expect(validateRetention('7')).toBeUndefined();
    expect(validateRetention('0.5')).toBeUndefined();
    expect(validateRetention('0')).toMatch(/more than 0/);
    expect(validateRetention('4000')).toMatch(/3650/);
    expect(validateRetention('soon')).toMatch(/number/);
  });

  it('shows the wall-clock cap in minutes and checks every cap', () => {
    const draft = capsDraft(caps);
    expect(draft.maxWallClockMs).toBe('120');
    expect(parseCaps(draft).caps).toEqual(caps);
    const bad = parseCaps({ ...draft, maxConcurrentAgents: '0', maxToolCalls: '1.5' });
    expect(Object.keys(bad.errors ?? {})).toEqual(['maxToolCalls', 'maxConcurrentAgents']);
  });

  it('edits the table row by row; an absent unclassified is ask', () => {
    expect(isSpecTable(DEFAULT_PERMISSION_POLICY)).toBe(true);
    expect(policyValue(DEFAULT_PERMISSION_POLICY, 'unclassified')).toBe('ask');
    const tighter = withPolicyValue(DEFAULT_PERMISSION_POLICY, 'push', 'deny');
    expect(policyValue(tighter, 'push')).toBe('deny');
    expect(isSpecTable(tighter)).toBe(false);
    expect(isSpecTable(withPolicyValue(DEFAULT_PERMISSION_POLICY, 'unclassified', 'ask'))).toBe(
      true,
    );
  });

  it('words each server refusal', () => {
    const body = (b: Record<string, unknown>) => b;
    expect(
      refusalMessage(
        new ApiError(
          400,
          'invalid_body',
          'invalid_body',
          body({
            issues: [{ path: ['caps', 'maxToolCalls'], message: 'Too big' }],
          }),
        ),
      ),
    ).toBe('Not accepted by the server — caps.maxToolCalls: Too big.');
    expect(refusalMessage(new ApiError(400, 'not absolute', 'invalid'))).toBe(
      'Not accepted: not absolute',
    );
    expect(refusalMessage(new ApiError(403, 'only here', 'remote_settings'))).toMatch(
      /^Only on the computer running Mission Control: only here/,
    );
    expect(refusalMessage(new ApiError(409, 'unset it', 'env_override'))).toMatch(
      /^Fixed by an environment variable: unset it/,
    );
    expect(refusalMessage(new ApiError(500, 'internal', 'internal'))).toMatch(/Could not save/);
    expect(refusalMessage(new TypeError('Failed to fetch'))).toMatch(/Could not reach/);
  });

  it('recognises a settings reply', () => {
    expect(isSettingsResponse({})).toBe(false);
    expect(isSettingsResponse({ settings: {}, envOverrides: [], restartRequired: [] })).toBe(true);
  });
});
