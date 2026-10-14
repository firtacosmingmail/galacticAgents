import { describe, expect, it } from 'vitest';
import { PERMISSION_POLICY_PRESETS } from './domain.js';
import { ENDED_STATES } from './enums.js';
import {
  AnswerBody,
  ControlBody,
  MessagesResponse,
  PermissionPolicyPresetName,
  ProposalDecisionBody,
  RuntimesInfo,
  TerminalInputBody,
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
    // A reply (P8-17): the target only; any quoted text a client adds is not part of the body.
    expect(
      SendBody.parse({
        text: 'yes',
        replyTo: { kind: 'question', id: 'q-1', version: 2, answerId: 'k', text: 'forged' },
      }),
    ).toEqual({ text: 'yes', replyTo: { kind: 'question', id: 'q-1', version: 2, answerId: 'k' } });
    expect(SendBody.safeParse({ text: 'x', replyTo: { kind: 'card', id: 'c' } }).success).toBe(
      false,
    );
    expect(SendBody.safeParse({ text: 'x', replyTo: { kind: 'message', id: '' } }).success).toBe(
      false,
    );
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

describe('ControlBody (P2-14)', () => {
  it('takes every panel action and refuses edits of other fields', () => {
    const target = { kind: 'task', id: 't-1' } as const;
    for (const action of ['stop', 'cancel', 'pause', 'resume', 'close', 'archive', 'reopen']) {
      expect(ControlBody.safeParse({ target, action: { action } }).success).toBe(true);
    }
    expect(
      ControlBody.parse({ target, action: { action: 'edit', changes: { priority: 'high' } } }),
    ).toEqual({ target, action: { action: 'edit', changes: { priority: 'high' } } });
    expect(
      ControlBody.safeParse({ target, action: { action: 'edit', changes: { bodyId: 'b' } } })
        .success,
    ).toBe(false);
    expect(ControlBody.safeParse({ target, action: { action: 'pin' } }).success).toBe(false);
    expect(
      ControlBody.safeParse({ target: { kind: 'body', id: 'b' }, action: { action: 'stop' } })
        .success,
    ).toBe(false);
  });
});

describe('ControlBody project policy edit (P2-21)', () => {
  it('takes a permission policy or null, and refuses a malformed one', () => {
    const target = { kind: 'project', id: 'p-1' } as const;
    const policy = { rules: { destructive: 'allow' } };
    for (const permissionPolicy of [policy, null]) {
      expect(
        ControlBody.safeParse({ target, action: { action: 'edit', changes: { permissionPolicy } } })
          .success,
      ).toBe(true);
    }
    expect(
      ControlBody.safeParse({
        target,
        action: {
          action: 'edit',
          changes: { permissionPolicy: { rules: { destructive: 'sure' } } },
        },
      }).success,
    ).toBe(false);
  });

  it('parses proposal decisions, versioned answers and chat history (P2-18)', () => {
    expect(ProposalDecisionBody.parse({ decision: 'approve' })).toEqual({ decision: 'approve' });
    expect(
      ProposalDecisionBody.parse({
        decision: 'edit',
        changes: { kind: 'moon', proposedBody: { kind: 'moon', name: 'Io' }, initGit: true },
      }),
    ).toMatchObject({ changes: { kind: 'moon', initGit: true } });
    // Only the card's size, body, workspace and the git consent are editable.
    expect(
      ProposalDecisionBody.safeParse({ decision: 'edit', changes: { requestText: 'x' } }).success,
    ).toBe(false);
    expect(ProposalDecisionBody.safeParse({ decision: 'park' }).success).toBe(false);
    // The trust level of the project the card creates (P2-22): a known level only.
    expect(ProposalDecisionBody.parse({ decision: 'edit', changes: { trust: 'trusted' } })).toEqual(
      { decision: 'edit', changes: { trust: 'trusted' } },
    );
    expect(
      ProposalDecisionBody.safeParse({ decision: 'edit', changes: { trust: 'yolo' } }).success,
    ).toBe(false);
    expect(ProposalDecisionBody.safeParse({ decision: 'reject' }).success).toBe(true);
    expect(AnswerBody.parse({ answer: 'yes', version: 2 })).toEqual({ answer: 'yes', version: 2 });
    expect(AnswerBody.safeParse({ answer: 'yes', version: -1 }).success).toBe(false);
    expect(
      MessagesResponse.safeParse({
        messages: [
          {
            messageId: 'm',
            agentId: 'a',
            seq: 1,
            at: 'now',
            sender: { type: 'user' },
            text: 'hi',
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('TerminalInputBody refuses control characters but keeps tabs and printable text', () => {
    expect(TerminalInputBody.safeParse({ text: 'yes\tplease — ok ✓' }).success).toBe(true);
    for (const bad of ['stop\x03', '\x15rm', '\x1b[31mred', 'a\nb', 'a\rb', 'x\x7f', 'y\x9b1m']) {
      const r = TerminalInputBody.safeParse({ text: bad });
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]?.message).toMatch(/control characters/);
    }
  });
});
