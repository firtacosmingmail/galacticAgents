import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PERMISSION_POLICY,
  publishFingerprint,
  PERMISSION_POLICY_PRESETS,
  type PublishContext,
  type ToolCall,
} from '@galactic/protocol';
import { sha256 } from '../domain/publish.js';
import { CapsEnforcer } from './caps.js';
import { createPermissionGate } from './permission-gate.js';
import {
  PUBLISH_ALLOWANCE_TTL_MS,
  PublishAllowanceStore,
  publishingPolicy,
} from './publish-allowance.js';

/**
 * P11-06 (plan Task 7) — the one-shot allowance an approved publish arms: the run's next call the
 * policy asks about for the network goes through once, as long as every approved file is still
 * the file that was approved; it expires after 30 minutes and never turns a deny into an allow.
 */

const folders: string[] = [];
const enforcers: CapsEnforcer[] = [];
afterEach(() => {
  for (const f of folders.splice(0)) rmSync(f, { recursive: true, force: true });
  for (const c of enforcers.splice(0)) c.dispose();
});

const TEXT = 'We launched today!';
const CURL: ToolCall = {
  toolName: 'Bash',
  input: { command: `curl -X POST https://api.x.com -d "status=${TEXT}"` },
};
const OTHER: ToolCall = {
  toolName: 'Bash',
  input: { command: 'curl -X POST https://api.x.com -d "status=Something else"' },
};

function setup(policy = DEFAULT_PERMISSION_POLICY, text = TEXT) {
  const worktree = mkdtempSync(join(tmpdir(), 'galactic-allowance-'));
  folders.push(worktree);
  writeFileSync(join(worktree, 'post.png'), 'png bytes');
  let now = 1_000_000;
  const store = new PublishAllowanceStore({ now: () => now });
  const files = [{ path: 'post.png', sha256: sha256('png bytes') }];
  const base = { platform: 'X', account: '@shop', text, files };
  const publish: PublishContext = { ...base, fingerprint: publishFingerprint(base, sha256) };
  const caps = new CapsEnforcer({
    maxConcurrentAgents: 4,
    defaults: { maxWallClockMs: 60_000, maxToolCalls: 100 },
    onCapHit: () => undefined,
  });
  caps.track('a-1', caps.resolve());
  enforcers.push(caps);
  const gate = createPermissionGate({
    agentId: 'a-1',
    policy,
    workspace: worktree,
    cwd: worktree,
    caps,
    allowOnce: (call, verdict, categories) =>
      store.check(
        'a-1',
        call,
        categories ?? (verdict.decision === 'ask' && verdict.action ? [verdict.action] : []),
      ) === 'allow',
  });
  return {
    worktree,
    store,
    publish,
    gate,
    advance: (ms: number) => void (now += ms),
  };
}

describe('PublishAllowanceStore', () => {
  it('allows exactly one network ask after approval', () => {
    const s = setup();
    expect(s.gate.check(CURL).decision).toBe('ask');
    s.store.arm('a-1', s.publish, s.worktree);
    // A call that is not a network ask leaves the allowance armed.
    expect(s.store.check('a-1', CURL, ['edit_workspace'])).toBe('none');
    expect(s.gate.check(CURL).decision).toBe('allow');
    expect(s.gate.check(CURL).decision).toBe('ask');
    expect(s.store.check('a-1', CURL, ['network'])).toBe('none');
  });

  it('allowance refused when a file changed', () => {
    const s = setup();
    s.store.arm('a-1', s.publish, s.worktree);
    writeFileSync(join(s.worktree, 'post.png'), 'other bytes');
    expect(s.store.check('a-1', CURL, ['network'])).toBe('none');
    // Disarmed: the original file back does not bring it back.
    writeFileSync(join(s.worktree, 'post.png'), 'png bytes');
    expect(s.store.check('a-1', CURL, ['network'])).toBe('none');
    expect(s.gate.check(CURL).decision).toBe('ask');
  });

  it('allowance refused when a file became a symlink, even to the same bytes (I2)', () => {
    const s = setup();
    const outside = mkdtempSync(join(tmpdir(), 'galactic-outside-'));
    folders.push(outside);
    writeFileSync(join(outside, 'post.png'), 'png bytes');
    s.store.arm('a-1', s.publish, s.worktree);
    unlinkSync(join(s.worktree, 'post.png'));
    symlinkSync(join(outside, 'post.png'), join(s.worktree, 'post.png'));
    expect(s.store.check('a-1', CURL, ['network'])).toBe('none');
    expect(s.store.isArmed('a-1')).toBe(false);
  });

  it('expires after 30 minutes', () => {
    const s = setup();
    s.store.arm('a-1', s.publish, s.worktree);
    s.advance(PUBLISH_ALLOWANCE_TTL_MS + 1);
    expect(s.store.check('a-1', CURL, ['network'])).toBe('none');
    s.store.arm('a-1', s.publish, s.worktree);
    s.store.disarm('a-1');
    expect(s.store.check('a-1', CURL, ['network'])).toBe('none');
  });

  it('a call carrying different text asks and leaves the allowance armed (R15)', () => {
    const s = setup();
    s.store.arm('a-1', s.publish, s.worktree);
    expect(s.gate.check(OTHER).decision).toBe('ask');
    expect(s.store.isArmed('a-1')).toBe(true);
    expect(s.gate.check(CURL).decision).toBe('allow');
  });

  it('the approved text JSON-escaped or URL-encoded counts as the text (R15)', () => {
    const text = 'Line one\nWe said "hi" & more';
    for (const input of [
      { url: 'https://api.x.com', body: JSON.stringify({ status: text }) },
      { command: `curl https://api.x.com -d 'status=${encodeURIComponent(text)}'` },
      {
        command: `curl https://api.x.com -d 'status=${encodeURIComponent(text).replace(/%20/g, '+')}'`,
      },
      { url: 'https://api.x.com', payload: { nested: [{ status: text }] } },
    ]) {
      const s = setup(DEFAULT_PERMISSION_POLICY, text);
      s.store.arm('a-1', s.publish, s.worktree);
      expect(s.store.check('a-1', { toolName: 'Bash', input }, ['network'])).toBe('allow');
    }
  });

  it('a files-only publish allows a call naming one of its files (R15)', () => {
    const s = setup(DEFAULT_PERMISSION_POLICY, '');
    s.store.arm('a-1', s.publish, s.worktree);
    expect(s.gate.check(OTHER).decision).toBe('ask');
    const upload: ToolCall = {
      toolName: 'Bash',
      input: { command: 'curl -F media=@post.png https://upload.x.com' },
    };
    expect(s.gate.check(upload).decision).toBe('allow');
    expect(s.gate.check(upload).decision).toBe('ask');
  });

  it('a short text (under 12 characters) never matches: the call asks (R15, round 2)', () => {
    const s = setup(DEFAULT_PERMISSION_POLICY, 'Hi!');
    s.store.arm('a-1', s.publish, s.worktree);
    const call: ToolCall = {
      toolName: 'Bash',
      input: { command: 'curl -X POST https://api.x.com -d "status=Hi!"' },
    };
    expect(s.store.check('a-1', call, ['network'])).toBe('none');
    // A short text with files: an approved file named as a path token lets the call through.
    const upload: ToolCall = {
      toolName: 'Bash',
      input: { command: 'curl -F "status=Hi!" -F media=@post.png https://upload.x.com' },
    };
    expect(s.store.check('a-1', upload, ['network'])).toBe('allow');
  });

  it('the text counts only inside string values, never keys or the serialized input', () => {
    const text = 'command and url';
    const s = setup(DEFAULT_PERMISSION_POLICY, text);
    s.store.arm('a-1', s.publish, s.worktree);
    const keyed: ToolCall = {
      toolName: 'WebFetch',
      input: { 'command and url': 'https://api.x.com', url: 'https://api.x.com' },
    };
    expect(s.store.check('a-1', keyed, ['network'])).toBe('none');
    expect(s.store.isArmed('a-1')).toBe(true);
  });

  it('a files-only publish matches a path token, not a bare substring', () => {
    const s = setup(DEFAULT_PERMISSION_POLICY, '');
    s.store.arm('a-1', s.publish, s.worktree);
    for (const command of [
      'curl https://cdn.x.com/post.png',
      'curl -F media=@repost.png https://upload.x.com',
      'curl -F media=@post.png.bak https://upload.x.com',
    ]) {
      expect(s.store.check('a-1', { toolName: 'Bash', input: { command } }, ['network'])).toBe(
        'none',
      );
    }
    const absolute = `curl -F "media=@${join(s.worktree, 'post.png')}" https://upload.x.com`;
    expect(
      s.store.check('a-1', { toolName: 'Bash', input: { command: absolute } }, ['network']),
    ).toBe('allow');
  });

  it('never turns a deny into allow', () => {
    const s = setup({
      ...DEFAULT_PERMISSION_POLICY,
      rules: { ...DEFAULT_PERMISSION_POLICY.rules, network: 'deny' },
    });
    s.store.arm('a-1', s.publish, s.worktree);
    expect(s.gate.check(CURL).decision).toBe('deny');
    // Still armed: a denial does not use it up.
    expect(s.store.check('a-1', CURL, ['network'])).toBe('allow');
  });
});

describe('publishingPolicy (ruling R26)', () => {
  it('makes the network and unclassified calls ask under the trusted preset; a deny stays', () => {
    const trusted = publishingPolicy(PERMISSION_POLICY_PRESETS.trusted);
    expect(trusted.rules.network).toBe('ask');
    expect(trusted.unclassified).toBe('ask');
    expect(trusted.rules.edit_workspace).toBe('allow');
    const denied = publishingPolicy({ rules: { network: 'deny' } });
    expect(denied.rules.network).toBe('deny');
    expect(publishingPolicy({ rules: {} }).rules.network).toBe('ask');
  });

  it('makes running a workspace command ask too, since a script can reach the network (P11-12)', () => {
    expect(PERMISSION_POLICY_PRESETS.trusted.rules.run_workspace).toBe('allow');
    expect(publishingPolicy(PERMISSION_POLICY_PRESETS.trusted).rules.run_workspace).toBe('ask');
    expect(publishingPolicy(DEFAULT_PERMISSION_POLICY).rules.run_workspace).toBe('ask');
    expect(publishingPolicy({ rules: { run_workspace: 'deny' } }).rules.run_workspace).toBe('deny');
  });

  it('never lets the publish allowance pass a workspace command (P11-12)', () => {
    const s = setup(publishingPolicy(PERMISSION_POLICY_PRESETS.trusted));
    s.store.arm('a-1', s.publish, s.worktree);
    const script: ToolCall = {
      toolName: 'Bash',
      input: { command: `node post.js "${s.publish.text}"` },
    };
    expect(s.gate.check(script).decision).toBe('ask');
    // The approved network call itself still goes through once.
    expect(s.gate.check(CURL).decision).toBe('allow');
    expect(s.gate.check(CURL).decision).toBe('ask');
  });
});
