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

  describe('fix round 1', () => {
    const t1 = '/w/.worktrees/t1';
    const nm = markFromApproval({ toolCall: bash('rm -rf node_modules') }, ctx);

    it('follows a cd before the approved delete', () => {
      const mark = markFromApproval({ toolCall: bash('cd node_modules && rm -rf .cache') }, ctx);
      expect(mark).toEqual({
        kind: 'folder',
        category: 'destructive',
        paths: [`${t1}/node_modules/.cache`],
      });
      expect(covers(mark, bash('rm -rf node_modules/.cache'))).toBe(true);
      expect(covers(mark, bash('rm -rf node_modules/other'))).toBe(false);
    });

    it.each(['cd "$D" && rm -rf .cache', 'cd - && rm -rf .cache', '(cd a); rm -rf .cache'])(
      'falls back to the prefix when the cwd is not certain: %s',
      (command) => {
        expect(markFromApproval({ toolCall: bash(command) }, ctx)).toEqual({
          kind: 'prefix',
          words: ['rm'],
        });
      },
    );

    it('reads plain arguments as targets only for file commands', () => {
      expect(markFromApproval({ toolCall: bash('git branch -D feat') }, ctx)).toEqual({
        kind: 'prefix',
        words: ['git', 'branch'],
      });
      expect(markFromApproval({ toolCall: bash('git clean -fdx') }, ctx)).toEqual({
        kind: 'folder',
        category: 'destructive',
        paths: [t1],
      });
      expect(
        markFromApproval({ toolCall: bash('find node_modules -name x -delete') }, ctx),
      ).toEqual({ kind: 'folder', category: 'destructive', paths: [`${t1}/node_modules`] });
    });

    it.each(['rm -rf .', 'rm -rf /w/.worktrees/t1', 'git clean -fdx', 'find . -name x -delete'])(
      'a delete mark covers a delete of a folder that contains it: %s',
      (command) => {
        expect(covers(nm, bash(command))).toBe(true);
      },
    );

    it.each(['rm -rf dist', 'git branch -D feat', 'find dist -delete'])(
      'a delete mark does not cover %s',
      (command) => {
        expect(covers(nm, bash(command))).toBe(false);
      },
    );

    it('a read or edit mark does not cover its parent', () => {
      const mark = markFromApproval(
        { toolCall: { toolName: 'Read', input: { file_path: `${t1}/src/a.ts` } } },
        ctx,
      );
      expect(mark).toEqual({
        kind: 'folder',
        category: 'read_workspace',
        paths: [`${t1}/src/a.ts`],
      });
      expect(covers(mark, { toolName: 'Read', input: { file_path: `${t1}/src` } })).toBe(false);
    });

    it('starts the fallback prefix at the command name', () => {
      const mark = markFromApproval({ toolCall: bash('FOO=1 pnpm test') }, ctx);
      expect(mark).toEqual({ kind: 'prefix', words: ['pnpm', 'test'] });
      expect(covers(mark, bash('pnpm test'))).toBe(true);
    });

    it('a delete of an unplaceable target gives a prefix mark', () => {
      expect(markFromApproval({ toolCall: bash('rm -rf $X') }, ctx)).toEqual({
        kind: 'prefix',
        words: ['rm'],
      });
    });

    it("a file tool on someone else's home gives a tool mark, which asks for that tool", () => {
      const call: ToolCall = { toolName: 'Read', input: { file_path: '~bob/x' } };
      const mark = markFromApproval({ toolCall: call }, ctx);
      expect(mark).toEqual({ kind: 'tool', toolName: 'Read' });
      expect(covers(mark, call)).toBe(true);
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

describe('folder marks relative to the Steward’s worktree and scratch folder (P13-16)', () => {
  const t1 = { worktree: '/w/.worktrees/t1', scratch: '/w/.scratch/t1' };
  const t2 = { worktree: '/w/.worktrees/t2', scratch: '/w/.scratch/t2' };
  const ctx2: PolicyContext = { workspace: '/w', cwd: t2.worktree, home: '/Users/me' };
  const coversIn2 = (match: ApprovalMarkMatch, command: string) => {
    const toolCall = bash(command);
    return markCovers(match, { toolCall, parts: partsOfCall(toolCall, ctx2), ctx: ctx2 }, t2);
  };
  const mark = markFromApproval({ toolCall: bash('rm -rf node_modules') }, ctx, t1);

  it('stores a path in the worktree as {worktree}/<rest>', () => {
    expect(mark).toEqual({
      kind: 'folder',
      category: 'destructive',
      paths: ['{worktree}/node_modules'],
    });
    expect(markFromApproval({ toolCall: bash('rm -rf .') }, ctx, t1)).toEqual({
      kind: 'folder',
      category: 'destructive',
      paths: ['{worktree}'],
    });
  });

  it('stores a path in the scratch folder as {scratch}, the longer root first; others stay absolute', () => {
    expect(
      markFromApproval(
        { toolCall: bash('rm -rf /w/.scratch/t1/out /tmp/x /w/.scratch/t1/out') },
        ctx,
        t1,
      ),
    ).toEqual({ kind: 'folder', category: 'destructive', paths: ['/tmp/x', '{scratch}/out'] });
    const nested = { worktree: '/w/.worktrees/t1', scratch: '/w/.worktrees/t1/.tmp' };
    expect(markFromApproval({ toolCall: bash('rm -rf .tmp/a') }, ctx, nested)).toEqual({
      kind: 'folder',
      category: 'destructive',
      paths: ['{scratch}/a'],
    });
  });

  it.each(['rm -rf node_modules/.cache', 'rm -rf /w/.worktrees/t2/node_modules', 'rm -rf .'])(
    'covers %s run from another Steward’s worktree',
    (command) => {
      expect(coversIn2(mark, command)).toBe(true);
    },
  );

  it.each(['rm -rf /w/.worktrees/t1/node_modules', 'rm -rf dist'])(
    'does not cover %s from t2',
    (command) => {
      expect(coversIn2(mark, command)).toBe(false);
    },
  );

  it('a {scratch} mark expands to the requester’s scratch folder, and to nothing without one', () => {
    const scratchMark: ApprovalMarkMatch = {
      kind: 'folder',
      category: 'destructive',
      paths: ['{scratch}/out'],
    };
    expect(coversIn2(scratchMark, 'rm -rf /w/.scratch/t2/out/a')).toBe(true);
    expect(coversIn2(scratchMark, 'rm -rf /w/.scratch/t1/out/a')).toBe(false);
    const toolCall = bash('rm -rf /w/.scratch/t2/out/a');
    expect(
      markCovers(
        scratchMark,
        { toolCall, parts: partsOfCall(toolCall, ctx2), ctx: ctx2 },
        {
          worktree: t2.worktree,
        },
      ),
    ).toBe(false);
  });

  it('an absolute mark path matches as before', () => {
    const abs = markFromApproval({ toolCall: bash('rm -rf /tmp/cache') }, ctx, t1);
    expect(abs).toEqual({ kind: 'folder', category: 'destructive', paths: ['/tmp/cache'] });
    expect(coversIn2(abs, 'rm -rf /tmp/cache/x')).toBe(true);
  });
});
