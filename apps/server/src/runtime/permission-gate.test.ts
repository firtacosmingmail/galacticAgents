import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  it("asks before a Steward writes into the project's deliverables folder, read on every check (P9-06)", () => {
    let folders: string[] = [];
    const gate = createPermissionGate({
      ...base,
      cwd: '/w/proj/.galactic/worktrees/t1',
      policy: DEFAULT_PERMISSION_POLICY,
      caps: caps(),
      userFolders: () => folders,
    });
    const write = {
      toolName: 'Write',
      input: { file_path: '/w/proj/deliverables/t1/report.md', content: 'x' },
    };
    expect(gate.check(write)).toEqual({ decision: 'allow' });
    folders = ['/w/proj/deliverables'];
    expect(gate.check(write)).toMatchObject({ decision: 'ask', action: 'outside_workspace' });
    expect(gate.check({ toolName: 'Read', input: write.input })).toEqual({ decision: 'allow' });
  });

  it('treats the resolved and the given spelling of a symlinked workspace as one place (dev-machine run)', () => {
    // macOS: a temp folder is /var/folders/…, which is really /private/var/folders/…; Claude Code
    // resolves its cwd, so it asks about the resolved path. Reproduced with a symlink anywhere.
    const real = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-real-')));
    mkdirSync(join(real, 'src'));
    const link = join(realpathSync(mkdtempSync(join(tmpdir(), 'galactic-link-'))), 'ws');
    symlinkSync(real, link);
    const gate = createPermissionGate({
      agentId: 'a-1',
      workspace: link,
      cwd: link,
      policy: DEFAULT_PERMISSION_POLICY,
      caps: caps(),
    });
    expect(gate.check({ toolName: 'Read', input: { file_path: join(real, 'README.md') } })).toEqual(
      {
        decision: 'allow',
      },
    );
    expect(gate.check({ toolName: 'Edit', input: { file_path: join(link, 'src/a.ts') } })).toEqual({
      decision: 'allow',
    });
    // Agent configuration stays outside, whichever spelling is used.
    expect(
      gate.check({ toolName: 'Write', input: { file_path: join(real, '.claude/settings.json') } }),
    ).toMatchObject({ decision: 'ask' });
    // A sibling of the real folder is still outside.
    expect(
      gate.check({ toolName: 'Read', input: { file_path: join(real, '..', 'other', 'x') } }),
    ).toMatchObject({ decision: 'ask' });
  });

  it('reads the workspace on every check: a moved workspace applies at once (wave-3 review)', () => {
    let workspace = '/w/proj';
    const gate = createPermissionGate({
      agentId: 'a-1',
      workspace: () => workspace,
      cwd: '/w/proj',
      policy: DEFAULT_PERMISSION_POLICY,
      caps: caps(),
    });
    const edit = { toolName: 'Edit', input: { file_path: '/w/proj/src/a.ts' } };
    expect(gate.check(edit)).toEqual({ decision: 'allow' });
    workspace = '/w/elsewhere';
    expect(gate.check(edit)).toMatchObject({ decision: 'ask' });
  });

  it("allows a brain's own server tools by name or MCP name (P2-06)", () => {
    const gate = createPermissionGate({
      ...base,
      policy: DEFAULT_PERMISSION_POLICY,
      caps: caps(),
      serverTools: ['ask_user'],
    });
    const inProcess = { name: 'galactic', source: 'sdk' };
    expect(gate.check({ toolName: 'ask_user', input: {} })).toEqual({ decision: 'allow' });
    expect(gate.check({ toolName: 'mcp__galactic__ask_user', mcpServer: inProcess })).toEqual({
      decision: 'allow',
    });
    const other = createPermissionGate({
      ...base,
      policy: DEFAULT_PERMISSION_POLICY,
      caps: caps(),
    });
    expect(
      other.check({ toolName: 'mcp__galactic__ask_user', mcpServer: inProcess }),
    ).toMatchObject({ decision: 'ask' });
  });

  it("allows an MCP name only from the host's own in-process server, never a namesake (P9 review)", () => {
    const gate = createPermissionGate({
      ...base,
      policy: DEFAULT_PERMISSION_POLICY,
      caps: caps(),
      serverTools: ['declare_deliverable'],
    });
    const call = { toolName: 'mcp__galactic__declare_deliverable', input: {} };
    // A repository's `.mcp.json` (or the user's, or a plugin's) server named `galactic`.
    for (const source of ['project', 'local', 'user', 'plugin', 'dynamic']) {
      expect(gate.check({ ...call, mcpServer: { name: 'galactic', source } })).toMatchObject({
        decision: 'ask',
      });
    }
    // No provenance proves nothing.
    expect(gate.check(call)).toMatchObject({ decision: 'ask' });
    // Another in-process server's tool of the same bare name, or a prefixed bare-name lookalike.
    expect(
      gate.check({
        toolName: 'mcp__other__declare_deliverable',
        mcpServer: { name: 'other', source: 'sdk' },
      }),
    ).toMatchObject({ decision: 'ask' });
    expect(gate.check({ ...call, mcpServer: { name: 'galactic', source: 'sdk' } })).toEqual({
      decision: 'allow',
    });
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

describe('createPermissionGate — live policy and refusals (P2-04)', () => {
  const rm = { toolName: 'Bash', input: { command: 'rm -rf dist' } };

  it('reads a policy function on every check, so a changed table applies to the next call', () => {
    let policy: unknown = DEFAULT_PERMISSION_POLICY;
    const gate = createPermissionGate({ ...base, policy: () => policy, caps: caps() });
    expect(gate.check(push)).toMatchObject({ decision: 'ask', action: 'push' });
    policy = { rules: { push: 'allow' } };
    expect(gate.check(push)).toEqual({ decision: 'allow' });
    policy = { rules: { push: 'nonsense' } };
    expect(gate.check(read)).toMatchObject({ decision: 'ask' }); // invalid table: every action asks
  });

  it('tells onDeny about policy refusals but not about a cap refusal', () => {
    const denials: unknown[] = [];
    const c = caps(1);
    const gate = createPermissionGate({
      ...base,
      policy: { rules: { destructive: 'deny' } },
      caps: c,
      onDeny: (call, verdict, action) => denials.push({ call, reason: verdict.reason, action }),
    });
    expect(gate.check(rm)).toMatchObject({ decision: 'deny' });
    expect(denials).toEqual([{ call: rm, reason: expect.any(String), action: 'destructive' }]);
    c.onEvent({ type: 'agent.tool_call', agentId: 'a-1', toolName: 'Read', input: {} });
    expect(gate.check(read)).toMatchObject({ decision: 'deny', reason: /tool-call cap/ });
    expect(denials).toHaveLength(1);
  });

  it('decide() gives the same verdict without reserving a call or calling onDeny', () => {
    let told = 0;
    const gate = createPermissionGate({
      ...base,
      policy: { rules: { destructive: 'deny' } },
      caps: caps(1),
      onDeny: () => told++,
    });
    expect(gate.decide(rm)).toMatchObject({
      verdict: { decision: 'deny' },
      action: 'destructive',
    });
    expect(gate.decide(push)).toMatchObject({ verdict: { decision: 'ask' }, action: 'push' });
    expect(told).toBe(0);
    expect(gate.check(read)).toEqual({ decision: 'allow' }); // the one call is still available
  });
});
