import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { gitPushOf, mainBranchesOf } from '../domain/git-push.js';
import { gitReader } from './git-read.js';

const root = mkdtempSync(join(process.cwd(), '.tmp-git-read-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('gitReader', () => {
  it('reads the current branch and gives undefined when git fails', async () => {
    const g = (...a: string[]) => execFileSync('git', a, { cwd: root, stdio: 'ignore' });
    g('init', '-q', '-b', 'feat');
    g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x');
    const git = gitReader(root);
    expect(await git(['symbolic-ref', '--quiet', '--short', 'HEAD'])).toBe('feat');
    expect(await git(['no-such-command'])).toBeUndefined();
    expect(await gitPushOf('git push', git, false)).toEqual({ branches: ['feat'] });
    expect(await mainBranchesOf(git)).toEqual(['main', 'master']);
  });
});
