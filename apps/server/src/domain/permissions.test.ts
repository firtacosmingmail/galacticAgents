import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PERMISSION_POLICY,
  type PermissionAction,
  type PermissionDecision,
  type PermissionPolicy,
} from '@galactic/protocol';
import {
  classifyCommand,
  classifyToolCall,
  decide,
  evaluate,
  isInsideWorkspace,
  pathsInCommand,
  resolvePolicy,
  splitCommand,
  strictest,
} from './permissions.js';

const ctx = {
  workspace: '/home/cosmin/projects/csv',
  cwd: '/home/cosmin/projects/csv/.worktrees/t1',
  home: '/home/cosmin',
};
const policy = DEFAULT_PERMISSION_POLICY;

// ---------------------------------------------------------------------------
// SPEC §3.6 — one block per row of the default policy table
// ---------------------------------------------------------------------------

type Row = [
  tool: string,
  input: unknown,
  actions: PermissionAction[],
  decision: PermissionDecision,
];

function check(rows: Row[]) {
  for (const [tool, input, actions, decision] of rows) {
    const verdict = evaluate(policy, { toolName: tool, input }, ctx);
    expect({ tool, input, actions: verdict.actions.sort(), decision: verdict.decision }).toEqual({
      tool,
      input,
      actions: [...actions].sort(),
      decision,
    });
  }
}

describe('SPEC §3.6 row 1 — read, run tests/builds, edit inside the workspace: allowed', () => {
  it('classifies reads, edits and workspace-local commands as allowed', () => {
    check([
      [
        'Read',
        { file_path: '/home/cosmin/projects/csv/src/index.ts' },
        ['read_workspace'],
        'allow',
      ],
      ['Read', { file_path: 'src/index.ts' }, ['read_workspace'], 'allow'],
      [
        'Glob',
        { pattern: '**/*.ts', path: '/home/cosmin/projects/csv' },
        ['read_workspace'],
        'allow',
      ],
      ['Grep', { pattern: 'TODO' }, ['read_workspace'], 'allow'],
      [
        'Write',
        { file_path: '/home/cosmin/projects/csv/README.md', content: 'x' },
        ['edit_workspace'],
        'allow',
      ],
      [
        'Edit',
        { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' },
        ['edit_workspace'],
        'allow',
      ],
      ['NotebookEdit', { notebook_path: './nb.ipynb' }, ['edit_workspace'], 'allow'],
      ['Bash', { command: 'pnpm test' }, ['run_workspace'], 'allow'],
      ['Bash', { command: 'npm run build && node dist/index.js' }, ['run_workspace'], 'allow'],
      [
        'Bash',
        { command: 'ls -la src/ && cat package.json | head -20' },
        ['run_workspace'],
        'allow',
      ],
      [
        'Bash',
        { command: 'git status && git diff && git commit -m "x"' },
        ['run_workspace'],
        'allow',
      ],
      ['Bash', { command: 'mkdir -p out && cp a.txt out/b.txt' }, ['run_workspace'], 'allow'],
      ['Bash', { command: 'cd ../t1 && pnpm test' }, ['run_workspace'], 'allow'],
      ['TodoWrite', { todos: [] }, [], 'allow'],
      ['Bash', { command: 'timeout 30 pnpm test' }, ['run_workspace'], 'allow'],
      ['Bash', { command: 'git -c core.pager=cat log --oneline' }, ['run_workspace'], 'allow'],
      ['Bash', { command: 'git checkout -b feature/x' }, ['run_workspace'], 'allow'],
      ['Bash', { command: 'git restore --staged src/a.ts' }, ['run_workspace'], 'allow'],
      ['Bash', { command: 'find . -name "*.ts" | xargs grep TODO' }, ['run_workspace'], 'allow'],
      ['Bash', { command: 'echo $PATH' }, ['run_workspace'], 'allow'],
      ['Bash', { command: 'cat $PWD/package.json' }, ['run_workspace'], 'allow'],
      ['Bash', { command: 'cd src && cd .. && pnpm test' }, ['run_workspace'], 'allow'],
    ]);
  });
});

describe('SPEC §3.6 row 2 — destructive actions: ask', () => {
  it('flags file deletion, branch deletion and force operations', () => {
    check([
      ['Bash', { command: 'rm -rf dist' }, ['destructive'], 'ask'],
      ['Bash', { command: 'rm file.txt' }, ['destructive'], 'ask'],
      ['Bash', { command: 'sudo rm -rf /' }, ['destructive', 'outside_workspace'], 'ask'],
      ['Bash', { command: 'find . -name "*.log" -delete' }, ['destructive'], 'ask'],
      ['Bash', { command: 'git branch -D feature/x' }, ['destructive'], 'ask'],
      ['Bash', { command: 'git branch --delete feature/x' }, ['destructive'], 'ask'],
      ['Bash', { command: 'git push origin --delete feature/x' }, ['destructive', 'push'], 'ask'],
      ['Bash', { command: 'git push --force origin main' }, ['destructive', 'push'], 'ask'],
      ['Bash', { command: 'git push -f' }, ['destructive', 'push'], 'ask'],
      ['Bash', { command: 'git reset --hard HEAD~3' }, ['destructive'], 'ask'],
      ['Bash', { command: 'git clean -fdx' }, ['destructive'], 'ask'],
      ['Bash', { command: 'git checkout -- .' }, ['destructive'], 'ask'],
      ['Bash', { command: 'git worktree remove ../t2' }, ['destructive'], 'ask'],
      ['Bash', { command: 'pnpm install --force' }, ['destructive', 'network'], 'ask'],
      ['Bash', { command: 'pnpm test && rm -rf node_modules' }, ['destructive'], 'ask'],
      // spellings that hide the command name
      ['Bash', { command: '\\rm -rf dist' }, ['destructive'], 'ask'],
      ['Bash', { command: '(rm -rf dist)' }, ['destructive'], 'ask'],
      ['Bash', { command: '{ rm -rf dist; }' }, ['destructive'], 'ask'],
      ['Bash', { command: 'RM -rf dist' }, ['destructive'], 'ask'],
      ['Bash', { command: 'Git Push --Force' }, ['destructive', 'push'], 'ask'],
      ['Bash', { command: 'find . -name "*.log" | xargs rm' }, ['destructive'], 'ask'],
      ['Bash', { command: 'exec rm -rf dist' }, ['destructive'], 'ask'],
      // git global options between git and the subcommand
      ['Bash', { command: 'git -c x=y push' }, ['push'], 'ask'],
      ['Bash', { command: 'git -C . push origin main' }, ['push'], 'ask'],
      ['Bash', { command: 'git --no-pager push' }, ['push'], 'ask'],
      ['Bash', { command: 'git -c core.x=1 reset --hard' }, ['destructive'], 'ask'],
      ['Bash', { command: 'git checkout -- src' }, ['destructive'], 'ask'],
      ['Bash', { command: 'git checkout main' }, ['destructive'], 'ask'],
      ['Bash', { command: 'git restore src/index.ts' }, ['destructive'], 'ask'],
      ['Bash', { command: 'git restore --staged --worktree src' }, ['destructive'], 'ask'],
      ['Bash', { command: 'git worktree prune' }, ['destructive'], 'ask'],
    ]);
  });

  it('asks for wrapped or quoted commands it cannot see into', () => {
    check([
      ['Bash', { command: 'bash -c "rm -rf dist"' }, [], 'ask'],
      ['Bash', { command: "sh -lc 'git push --force'" }, [], 'ask'],
      ['Bash', { command: 'eval "rm -rf dist"' }, [], 'ask'],
      ['Bash', { command: "node -e \"require('fs').rmSync('/', {recursive: true})\"" }, [], 'ask'],
      ['Bash', { command: 'python3 -c "import shutil; shutil.rmtree(\'dist\')"' }, [], 'ask'],
      ['Bash', { command: 'perl -e \'unlink glob "*"\'' }, [], 'ask'],
      ['Bash', { command: 'ruby -e "puts 1"' }, [], 'ask'],
      ['Bash', { command: 'osascript -e \'tell app "Finder" to empty trash\'' }, [], 'ask'],
    ]);
    // Even without the opaque rule, quoted payloads trip the ordinary rules.
    expect(classifyCommand('echo "rm -rf /"', ctx).actions).toContain('destructive');
  });
});

describe('SPEC §3.6 row 3 — anything outside the workspace: ask', () => {
  it('flags reads, edits and commands that touch paths outside the workspace', () => {
    check([
      ['Read', { file_path: '/etc/passwd' }, ['outside_workspace'], 'ask'],
      ['Read', { file_path: '~/.ssh/id_rsa' }, ['outside_workspace'], 'ask'],
      ['Read', { file_path: '/home/cosmin/projects/other/x.ts' }, ['outside_workspace'], 'ask'],
      ['Write', { file_path: '/tmp/out.txt', content: '' }, ['outside_workspace'], 'ask'],
      ['Glob', { pattern: '*', path: '/' }, ['outside_workspace'], 'ask'],
      ['Bash', { command: 'cat /etc/hosts' }, ['outside_workspace'], 'ask'],
      ['Bash', { command: 'cat ~/.zshrc' }, ['outside_workspace'], 'ask'],
      ['Bash', { command: 'cp a.txt /Users/x/Desktop/' }, ['outside_workspace'], 'ask'],
      ['Bash', { command: 'sudo make install' }, ['outside_workspace'], 'ask'],
      ['Bash', { command: 'chmod -R 777 src' }, ['outside_workspace'], 'ask'],
      ['Bash', { command: 'kill -9 1234' }, ['outside_workspace'], 'ask'],
      ['Bash', { command: 'echo hi > /tmp/x' }, ['outside_workspace'], 'ask'],
      ['Bash', { command: 'node --prefix=/opt/tool run' }, ['outside_workspace'], 'ask'],
      // shell variables in paths
      ['Bash', { command: 'cat $HOME/.ssh/id_rsa' }, ['outside_workspace'], 'ask'],
      ['Bash', { command: 'cat "$HOME"/.zshrc' }, ['outside_workspace'], 'ask'],
      ['Bash', { command: 'cat ${HOME}/.netrc' }, ['outside_workspace'], 'ask'],
      ['Bash', { command: 'cat $SOME_DIR/secret' }, ['outside_workspace'], 'ask'],
      ['Bash', { command: 'cat $TMPDIR' }, ['outside_workspace'], 'ask'],
      ['Bash', { command: 'cat `pwd`/../../../x' }, ['outside_workspace'], 'ask'],
      // stateful cd
      ['Bash', { command: 'cd .. && cd .. && cd .. && cat .env' }, ['outside_workspace'], 'ask'],
      ['Bash', { command: 'cd && ls' }, ['outside_workspace'], 'ask'],
      ['Bash', { command: 'cd ~ && ls' }, ['outside_workspace'], 'ask'],
      ['Bash', { command: 'cd - && ls' }, ['outside_workspace'], 'ask'],
      ['Bash', { command: 'cd /tmp; ls' }, ['outside_workspace'], 'ask'],
      ['Bash', { command: 'cd $DIR && ls' }, ['outside_workspace'], 'ask'],
      ['Glob', { pattern: '/etc/**' }, ['outside_workspace'], 'ask'],
      ['Glob', { pattern: '../../../**/*.env' }, ['outside_workspace'], 'ask'],
      ['Grep', { pattern: 'password', glob: '~/**' }, ['outside_workspace'], 'ask'],
    ]);
  });

  it('catches path traversal out of the workspace, however it is spelled', () => {
    check([
      ['Read', { file_path: '../../../secrets.env' }, ['outside_workspace'], 'ask'],
      ['Read', { file_path: '../../../other/x' }, ['outside_workspace'], 'ask'],
      ['Read', { file_path: '/home/cosmin/projects/csv/../other/x' }, ['outside_workspace'], 'ask'],
      ['Read', { file_path: 'src/../../../../x' }, ['outside_workspace'], 'ask'],
      [
        'Write',
        { file_path: '/home/cosmin/projects/csv-other/x', content: '' },
        ['outside_workspace'],
        'ask',
      ],
      ['Bash', { command: 'cat ../../../.env' }, ['outside_workspace'], 'ask'],
      ['Bash', { command: 'cd ../../.. && ls' }, ['outside_workspace'], 'ask'],
      [
        'Bash',
        { command: 'cat /home/cosmin/projects/csv/.worktrees/t1/../../../../.netrc' },
        ['outside_workspace'],
        'ask',
      ],
      // Traversal that stays inside is fine: the worktree is under the workspace.
      ['Read', { file_path: '../../src/index.ts' }, ['read_workspace'], 'allow'],
      ['Bash', { command: 'cat ../../package.json' }, ['run_workspace'], 'allow'],
    ]);
  });
});

describe('SPEC §3.6 row 4 — network access (installs, external calls): ask', () => {
  it('flags installs, HTTP clients, remote git operations and web tools', () => {
    check([
      ['Bash', { command: 'pnpm install' }, ['network'], 'ask'],
      ['Bash', { command: 'pnpm add zod' }, ['network'], 'ask'],
      ['Bash', { command: 'npm i -D vitest' }, ['network'], 'ask'],
      ['Bash', { command: 'npx create-vite app' }, ['network'], 'ask'],
      ['Bash', { command: 'pip install requests' }, ['network'], 'ask'],
      ['Bash', { command: 'pip3 install -r requirements.txt' }, ['network'], 'ask'],
      ['Bash', { command: 'brew install jq' }, ['network'], 'ask'],
      ['Bash', { command: 'apt-get install -y curl' }, ['network'], 'ask'],
      ['Bash', { command: 'cargo add serde' }, ['network'], 'ask'],
      ['Bash', { command: 'go get github.com/x/y' }, ['network'], 'ask'],
      ['Bash', { command: 'curl -s https://example.com/api' }, ['network'], 'ask'],
      ['Bash', { command: 'wget http://example.com/file' }, ['network'], 'ask'],
      ['Bash', { command: 'git fetch origin' }, ['network'], 'ask'],
      ['Bash', { command: 'git pull' }, ['network'], 'ask'],
      ['Bash', { command: 'git clone https://github.com/x/y' }, ['network'], 'ask'],
      ['Bash', { command: 'ssh user@host ls' }, ['network'], 'ask'],
      ['Bash', { command: 'docker pull node:22' }, ['network'], 'ask'],
      ['Bash', { command: 'gh pr view 12' }, ['network'], 'ask'],
      ['WebFetch', { url: 'https://example.com' }, ['network'], 'ask'],
      ['WebSearch', { query: 'zod 4' }, ['network'], 'ask'],
    ]);
  });
});

describe('SPEC §3.6 row 5 — git push / anything that leaves the machine: ask', () => {
  it('flags pushes, publishes and writes to remote services', () => {
    check([
      ['Bash', { command: 'git push' }, ['push'], 'ask'],
      ['Bash', { command: 'git push origin HEAD:refs/heads/x' }, ['push'], 'ask'],
      ['Bash', { command: 'git add -A && git commit -m "x" && git push' }, ['push'], 'ask'],
      ['Bash', { command: 'npm publish' }, ['push'], 'ask'],
      ['Bash', { command: 'gh pr create --fill' }, ['network', 'push'], 'ask'],
      ['Bash', { command: 'scp dist.tgz user@host:/srv' }, ['network', 'push'], 'ask'],
      ['Bash', { command: 'docker push repo/img:1' }, ['push'], 'ask'],
    ]);
  });
});

describe('unclassifiable calls', () => {
  it('asks for unknown tools, MCP tools and empty commands', () => {
    check([
      ['mcp__github__create_issue', { title: 'x' }, [], 'ask'],
      ['SomeNewTool', {}, [], 'ask'],
      ['Bash', { command: '' }, [], 'ask'],
      ['Bash', {}, [], 'ask'],
    ]);
    expect(evaluate(policy, { toolName: 'Weird' }, ctx).reasons).toEqual(['unknown tool Weird']);
  });
});

// ---------------------------------------------------------------------------
// Policy merge and strictness
// ---------------------------------------------------------------------------

describe('resolvePolicy / decide', () => {
  it('merges a per-project override over the global default', () => {
    const merged = resolvePolicy({ rules: { network: 'allow', push: 'deny' } });
    expect(merged.rules).toEqual({
      ...DEFAULT_PERMISSION_POLICY.rules,
      network: 'allow',
      push: 'deny',
    });
    expect(resolvePolicy(undefined)).toEqual(DEFAULT_PERMISSION_POLICY);
    expect(resolvePolicy({ rules: {} })).toEqual(DEFAULT_PERMISSION_POLICY);
  });

  it('applies the override when deciding', () => {
    const relaxed: PermissionPolicy = { rules: { network: 'allow' } };
    expect(
      evaluate(relaxed, { toolName: 'Bash', input: { command: 'pnpm install' } }, ctx).decision,
    ).toBe('allow');
    expect(
      evaluate(relaxed, { toolName: 'Bash', input: { command: 'git push' } }, ctx).decision,
    ).toBe('ask');
    const locked: PermissionPolicy = { rules: { edit_workspace: 'ask', push: 'deny' } };
    expect(evaluate(locked, { toolName: 'Edit', input: { file_path: 'a.ts' } }, ctx).decision).toBe(
      'ask',
    );
    expect(
      evaluate(locked, { toolName: 'Bash', input: { command: 'git push' } }, ctx).decision,
    ).toBe('deny');
  });

  it('lets the strictest category win', () => {
    expect(strictest(['allow', 'allow'])).toBe('allow');
    expect(strictest(['allow', 'ask'])).toBe('ask');
    expect(strictest(['ask', 'deny', 'allow'])).toBe('deny');
    expect(strictest([])).toBe('allow');
    const relaxed: PermissionPolicy = { rules: { network: 'allow', destructive: 'ask' } };
    expect(decide(relaxed, ['network', 'destructive'])).toBe('ask');
    expect(decide(relaxed, ['network'])).toBe('allow');
    expect(decide(relaxed, [])).toBe('ask');
  });

  it('a rule missing from both policies asks', () => {
    const bare = { rules: {} } as PermissionPolicy;
    // resolvePolicy fills every default, so only a truly unknown action could be missing.
    expect(decide(bare, ['read_workspace'])).toBe('allow');
    expect(decide(bare, ['nonsense' as PermissionAction])).toBe('ask');
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe('isInsideWorkspace', () => {
  it('treats the workspace itself and everything under it as inside', () => {
    expect(isInsideWorkspace('/home/cosmin/projects/csv', ctx)).toBe(true);
    expect(isInsideWorkspace('/home/cosmin/projects/csv/', ctx)).toBe(true);
    expect(isInsideWorkspace('.', ctx)).toBe(true);
    expect(isInsideWorkspace('~/projects/csv/src', ctx)).toBe(true);
    expect(isInsideWorkspace('/home/cosmin/projects/csv/..hidden', ctx)).toBe(true);
  });
  it('rejects siblings with a shared prefix, parents, home and absolute elsewhere', () => {
    expect(isInsideWorkspace('/home/cosmin/projects/csv2', ctx)).toBe(false);
    expect(isInsideWorkspace('/home/cosmin/projects', ctx)).toBe(false);
    expect(isInsideWorkspace('~', ctx)).toBe(false);
    expect(isInsideWorkspace('/', ctx)).toBe(false);
    expect(isInsideWorkspace('../../..', ctx)).toBe(false);
  });
  it('resolves relative paths from cwd, defaulting to the workspace', () => {
    expect(isInsideWorkspace('..', { workspace: '/w', cwd: '/w/sub' })).toBe(true);
    expect(isInsideWorkspace('..', { workspace: '/w' })).toBe(false);
  });
});

describe('command parsing', () => {
  it('splits on shell operators', () => {
    expect(splitCommand('a && b || c; d | e\nf $(g) `h` (i) { j; } \\k')).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
      'h',
      'i',
      'j',
      'k',
    ]);
  });
  it('extracts path-like tokens only', () => {
    expect(
      pathsInCommand('cat /etc/hosts ~/x ../y src/z plain --out=/tmp/o > /var/log/q https://a/b'),
    ).toEqual({ paths: ['/etc/hosts', '~/x', '../y', '/tmp/o', '/var/log/q'], unresolvable: [] });
    expect(pathsInCommand('cat $HOME/a ${PWD}/b $X/c $Y `pwd`/d')).toEqual({
      paths: ['~/a'], // `$PWD/b` resolves to `./b`, a plain relative path: inside

      unresolvable: ['$X/c', '`pwd`/d'],
    });
  });
  it('reports every reason it found', () => {
    const c = classifyCommand('rm -rf /tmp/x && git push --force', ctx);
    expect(c.actions.sort()).toEqual(['destructive', 'outside_workspace', 'push']);
    expect(c.reasons.length).toBeGreaterThanOrEqual(3);
  });
  it('classifyToolCall tolerates non-object input', () => {
    expect(classifyToolCall({ toolName: 'Read', input: 'nope' }, ctx).actions).toEqual([
      'read_workspace',
    ]);
    expect(
      evaluate({ rules: { read_workspace: 'ask' } }, { toolName: 'TodoWrite' }, ctx).decision,
    ).toBe('allow');
    expect(classifyToolCall({ toolName: 'Bash', input: null }, ctx).actions).toEqual([]);
  });
});
