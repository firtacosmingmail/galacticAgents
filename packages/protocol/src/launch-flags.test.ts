import { describe, expect, it } from 'vitest';
import { QuestionKind } from './enums.js';
import {
  LAUNCH_FLAGS,
  LaunchFlag,
  flagOfTool,
  launchCommand,
  launchOf,
  unsupportedFlags,
} from './launch-flags.js';

const PREFIX = 'mcp__claude-in-chrome__';

describe('launch flag catalogue', () => {
  it('maps a flag tool to its flag', () => {
    expect(flagOfTool(['chrome'], `${PREFIX}navigate`)).toBe('chrome');
    expect(flagOfTool(['chrome'], 'Bash')).toBeUndefined();
    expect(flagOfTool([], `${PREFIX}navigate`)).toBeUndefined();
  });

  it('builds the launch command', () => {
    expect(launchCommand(['chrome'])).toBe('claude --chrome');
  });

  it('reports flags a runtime cannot carry', () => {
    expect(unsupportedFlags(['chrome'], 'codex')).toEqual(['chrome']);
    expect(unsupportedFlags(['chrome'], 'claude-sdk')).toEqual([]);
  });

  it('never catalogues a permission-changing flag', () => {
    expect(LaunchFlag.safeParse('dangerously-skip-permissions').success).toBe(false);
    for (const spec of Object.values(LAUNCH_FLAGS)) {
      expect(spec.cli).not.toMatch(/dangerously|permission|allowed-?tools|mcp-config/i);
    }
  });

  it('reads the launch record from agent meta', () => {
    const launch = {
      flags: ['chrome'],
      expectedUse: 'x',
      check: 'y',
      approvalId: 'q1',
      precedents: [],
    };
    expect(launchOf({ meta: { launch } })?.flags).toEqual(['chrome']);
    expect(launchOf({ meta: { launch: { flags: ['nope'] } } })).toBeUndefined();
    expect(launchOf({})).toBeUndefined();
  });

  it('adds the launch question kind', () => {
    expect(QuestionKind.options).toContain('launch');
  });
});
