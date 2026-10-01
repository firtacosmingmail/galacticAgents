import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PERMISSION_POLICY } from '@galactic/protocol';
import { CapsEnforcer } from './caps.js';
import { createPermissionGate } from './permission-gate.js';

const enforcers: CapsEnforcer[] = [];
function caps(maxToolCalls = 10) {
  const c = new CapsEnforcer({
    maxConcurrentAgents: 4,
    defaults: { maxWallClockMs: 60_000, maxToolCalls },
    onCapHit: () => undefined,
  });
  c.track('a-1', c.resolve());
  enforcers.push(c);
  return c;
}
afterEach(() => {
  for (const c of enforcers.splice(0)) c.dispose();
});

const base = { agentId: 'a-1', workspace: '/w/proj', cwd: '/w/proj' };
const read = { toolName: 'Read', input: { file_path: 'src/a.ts' } };
const push = { toolName: 'Bash', input: { command: 'git push' } };

describe('createPermissionGate', () => {
  it("allows a brain's own server tools by name or MCP name (P2-06)", () => {
    const gate = createPermissionGate({
      ...base,
      policy: DEFAULT_PERMISSION_POLICY,
      caps: caps(),
      serverTools: ['ask_user'],
    });
    expect(gate.check({ toolName: 'ask_user', input: {} })).toEqual({ decision: 'allow' });
    expect(gate.check({ toolName: 'mcp__galactic__ask_user' })).toEqual({ decision: 'allow' });
    const other = createPermissionGate({
      ...base,
      policy: DEFAULT_PERMISSION_POLICY,
      caps: caps(),
    });
    expect(other.check({ toolName: 'mcp__galactic__ask_user' })).toMatchObject({ decision: 'ask' });
  });

  it('decides allowed, asked and denied calls from the policy', () => {
    const gate = createPermissionGate({
      ...base,
      policy: { rules: { push: 'deny' } },
      caps: caps(),
    });
    expect(gate.check(read)).toEqual({ decision: 'allow' });
    expect(gate.check({ toolName: 'Bash', input: { command: 'rm x' } })).toMatchObject({
      decision: 'ask',
      action: 'destructive',
    });
    expect(gate.check(push)).toMatchObject({ decision: 'deny' });
  });

  it('fails closed on a policy that does not parse', () => {
    for (const policy of [
      { rules: { push: 'maybe' } },
      { rules: { read_workspace: 1 } },
      { rules: 'allow' },
      null,
      'allow',
    ]) {
      const gate = createPermissionGate({ ...base, policy, caps: caps() });
      const verdict = gate.check(read);
      expect(verdict.decision).toBe('ask');
      if (verdict.decision === 'ask') expect(verdict.reasons[0]).toMatch(/policy is invalid/);
    }
  });

  it('never throws: an exception inside the check becomes deny', () => {
    const broken = caps();
    broken.reserveToolCall = () => {
      throw new Error('boom');
    };
    const gate = createPermissionGate({ ...base, policy: DEFAULT_PERMISSION_POLICY, caps: broken });
    expect(gate.check(read)).toEqual({
      decision: 'deny',
      reason: 'permission check failed: boom',
    });
    const throwingInput = {
      get toolName(): string {
        throw new Error('bad call');
      },
    };
    const gate2 = createPermissionGate({
      ...base,
      policy: DEFAULT_PERMISSION_POLICY,
      caps: caps(),
    });
    expect(gate2.check(throwingInput as never)).toEqual({
      decision: 'deny',
      reason: 'permission check failed: bad call',
    });
  });

  it('asks for every call when cwd is outside the workspace or the workspace is the root', () => {
    for (const where of [
      { workspace: '/w/proj', cwd: '/w/other' },
      { workspace: '/w/proj', cwd: '/w/proj/../x' },
      { workspace: '/', cwd: '/w/proj' },
      { workspace: 'relative/ws', cwd: 'relative/ws' },
    ]) {
      const gate = createPermissionGate({
        agentId: 'a-1',
        ...where,
        policy: DEFAULT_PERMISSION_POLICY,
        caps: caps(),
      });
      expect(gate.check(read).decision).toBe('ask');
    }
    const ok = createPermissionGate({
      agentId: 'a-1',
      workspace: '/w/proj',
      cwd: '/w/proj/.worktrees/t1',
      policy: DEFAULT_PERMISSION_POLICY,
      caps: caps(),
    });
    expect(ok.check(read).decision).toBe('allow');
  });

  it('runs the tool-call cap pre-flight on every check unless reserve is false', () => {
    const c = caps(1);
    const gate = createPermissionGate({ ...base, policy: DEFAULT_PERMISSION_POLICY, caps: c });
    expect(gate.check(push).decision).toBe('ask');
    c.onEvent({ type: 'agent.tool_call', agentId: 'a-1', toolName: 'Bash', input: {} });
    // The cap is used up: a new call is refused…
    expect(gate.check(read)).toMatchObject({ decision: 'deny', reason: /tool-call cap/ });
    // …but a re-check of a call that already passed the pre-flight is not refused again.
    expect(gate.check(read, { reserve: false })).toEqual({ decision: 'allow' });
  });
});
