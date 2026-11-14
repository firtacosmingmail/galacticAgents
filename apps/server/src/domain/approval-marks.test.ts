import { describe, expect, it } from 'vitest';
import type { ApprovalMarkMatch, ToolCall } from '@galactic/protocol';
import { markCovers, markFromApproval } from './approval-marks.js';
import { partsOfCall } from './command-parts.js';
import type { PolicyContext } from './permissions.js';

const ctx: PolicyContext = { workspace: '/w', cwd: '/w/.worktrees/t1', home: '/Users/me' };

const bash = (command: string): ToolCall => ({ toolName: 'Bash', input: { command } });

/** Whether `match` covers the call, its parts split as the watch splits them. */
const covers = (match: ApprovalMarkMatch, toolCall: ToolCall) =>
  markCovers(match, { toolCall, parts: partsOfCall(toolCall, ctx), ctx });

describe('markFromApproval and markCovers', () => {
  describe('a delete: the same category on that folder or inside it', () => {
    const mark = markFromApproval({ toolCall: bash('rm -rf node_modules') }, ctx);

    it('derives a folder mark with the resolved path', () => {
      expect(mark).toEqual({
        kind: 'folder',
        category: 'destructive',
        paths: ['/w/.worktrees/t1/node_modules'],
      });
    });

    it.each([
      'rm -rf node_modules/.cache',
      'rm node_modules/x',
      'rm -rf /w/.worktrees/t1/node_modules/.cache',
      "sh -c 'rm -rf node_modules/a'",
      'echo start && rm -rf node_modules/b',
      'rm -rf $X',
      'rm -rf *',
      'cd node_modules && rm -rf .cache',
      'cd "$D" && rm -rf .cache',
    ])('covers %s', (command) => {
      expect(covers(mark, bash(command))).toBe(true);
    });

    it.each(['rm -rf dist', 'echo hi > node_modules/x', 'ls node_modules', 'rm -rf node_modules2'])(
      'does not cover %s',
      (command) => {
        expect(covers(mark, bash(command))).toBe(false);
      },
    );

    it('is the same JSON for the same approval, paths sorted and de-duplicated', () => {
      const a = markFromApproval({ toolCall: bash('rm -rf b a b') }, ctx);
      expect(a).toEqual({
        kind: 'folder',
        category: 'destructive',
        paths: ['/w/.worktrees/t1/a', '/w/.worktrees/t1/b'],
      });
      expect(JSON.stringify(markFromApproval({ toolCall: bash('rm -rf a b') }, ctx))).toBe(
        JSON.stringify(a),
      );
    });

    it('uses the logged parts and the approval cwd', () => {
      const call = bash('rm -rf node_modules');
      const parts = partsOfCall(call, ctx);
      expect(
        markFromApproval({ toolCall: call, parts }, { ...ctx, cwd: '/w/.worktrees/t2' }),
      ).toEqual({
        kind: 'folder',
        category: 'destructive',
        paths: ['/w/.worktrees/t2/node_modules'],
      });
    });

    it('takes the part that gives the call its log category', () => {
      expect(markFromApproval({ toolCall: bash('pnpm build && rm -rf dist') }, ctx)).toEqual({
        kind: 'folder',
        category: 'destructive',
        paths: ['/w/.worktrees/t1/dist'],
      });
    });
  });

  describe('a network call: the same site and its subdomains', () => {
    const mark = markFromApproval({ toolCall: bash('curl https://api.posthog.com/api/x') }, ctx);

    it('derives a site mark', () => {
      expect(mark).toEqual({ kind: 'site', host: 'api.posthog.com' });
    });

    it('covers the site and its subdomains, not its parent', () => {
      expect(covers(mark, bash('curl https://api.posthog.com/other'))).toBe(true);
      expect(covers(mark, bash('curl https://eu.api.posthog.com/'))).toBe(true);
      expect(covers(mark, bash('curl https://posthog.com/'))).toBe(false);
      expect(covers(mark, bash('pnpm test'))).toBe(false);
    });

    it('covers a WebFetch of the site', () => {
      expect(
        covers(mark, { toolName: 'WebFetch', input: { url: 'https://api.posthog.com/x' } }),
      ).toBe(true);
    });
  });

  describe('any other command: the same first words', () => {
    const mark = markFromApproval({ toolCall: bash('pnpm test') }, ctx);

    it('derives a prefix mark', () => {
      expect(mark).toEqual({ kind: 'prefix', words: ['pnpm', 'test'] });
    });

    it('covers commands that start with the words, in any part', () => {
      expect(covers(mark, bash('pnpm test --watch'))).toBe(true);
      expect(covers(mark, bash('cd x && pnpm test'))).toBe(true);
      expect(covers(mark, bash('pnpm build'))).toBe(false);
    });

    it('keeps all the words when no prefix is proposed', () => {
      expect(markFromApproval({ toolCall: bash('bash build.sh') }, ctx)).toEqual({
        kind: 'prefix',
        words: ['bash', 'build.sh'],
      });
    });
  });

  describe('a non-Bash tool', () => {
    it('an MCP tool: the same tool, whatever its input', () => {
      const mark = markFromApproval(
        { toolCall: { toolName: 'mcp__slack__post_message', input: { text: 'hi' } } },
        ctx,
      );
      expect(mark).toEqual({ kind: 'tool', toolName: 'mcp__slack__post_message' });
      expect(covers(mark, { toolName: 'mcp__slack__post_message', input: { text: 'other' } })).toBe(
        true,
      );
      expect(covers(mark, { toolName: 'mcp__slack__read', input: {} })).toBe(false);
    });

    it('a file tool: a folder mark on its path and category', () => {
      const mark = markFromApproval(
        { toolCall: { toolName: 'Edit', input: { file_path: '/w/.worktrees/t1/src/a.ts' } } },
        ctx,
      );
      expect(mark).toEqual({
        kind: 'folder',
        category: 'edit_workspace',
        paths: ['/w/.worktrees/t1/src/a.ts'],
      });
      expect(covers(mark, { toolName: 'Edit', input: { file_path: 'src/a.ts' } })).toBe(true);
      expect(covers(mark, { toolName: 'Edit', input: { file_path: 'src/b.ts' } })).toBe(false);
      expect(covers(mark, { toolName: 'Read', input: { file_path: 'src/a.ts' } })).toBe(false);
    });

    it('a WebFetch: a site mark', () => {
      expect(
        markFromApproval(
          { toolCall: { toolName: 'WebFetch', input: { url: 'https://Docs.Example.com/x' } } },
          ctx,
        ),
      ).toEqual({ kind: 'site', host: 'docs.example.com' });
    });
  });
});
