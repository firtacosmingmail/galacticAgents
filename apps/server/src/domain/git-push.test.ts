import { describe, expect, it } from 'vitest';
import { gitPushOf, mainBranchesOf, pushesToMain, type GitRead } from './git-push.js';

/** A fake `git` in the Steward's worktree: on `feat`, tracking `origin/feat`, default `main`. */
function fakeGit(over: Partial<Record<string, string | undefined>> = {}): GitRead {
  const answers: Record<string, string | undefined> = {
    'symbolic-ref --quiet --short HEAD': 'feat',
    'for-each-ref --format=%(upstream:lstrip=3)%09%(push:lstrip=3) refs/heads/feat': 'feat\tfeat',
    'for-each-ref --format=%(upstream:lstrip=3)%09%(push:lstrip=3) refs/heads/topic': '\t',
    'for-each-ref --format=%(upstream:lstrip=3)%09%(push:lstrip=3) refs/heads/sneaky': 'main\tmain',
    'symbolic-ref --quiet --short refs/remotes/origin/HEAD': 'origin/main',
    ...over,
  };
  return (args) => Promise.resolve(answers[args.join(' ')]);
}

const branchesOf = async (text: string, git: GitRead = fakeGit(), moved = false) =>
  gitPushOf(text, git, moved);

describe('gitPushOf', () => {
  it('is undefined for anything but a single git push', async () => {
    expect(await branchesOf('gh pr create --fill')).toBeUndefined();
    expect(await branchesOf('npm publish')).toBeUndefined();
    expect(await branchesOf('git status')).toBeUndefined();
    expect(await branchesOf('git push origin feat && git push origin main')).toEqual({
      unknown: 'more than one command',
    });
  });

  it.each([
    ['git push origin feat', ['feat']],
    ['git push -u origin feat', ['feat']],
    ['git push --force-with-lease origin feat', ['feat']],
    ['git push origin HEAD:refs/heads/release-2', ['release-2']],
    ['git push origin +topic:wip', ['wip']],
    ['git push origin topic', ['topic']],
    ['git push origin --delete old-branch', ['old-branch']],
    ['git push origin :old-branch', ['old-branch']],
    ['git -c push.default=current push origin feat', ['feat']],
    ['git push origin v1.2.0', ['v1.2.0']],
    ['git push -o ci.skip origin feat', ['feat']],
  ])('reads the branches of %s', async (text, branches) => {
    expect(await branchesOf(text)).toEqual({ branches });
  });

  it.each([
    ['git push', ['feat']],
    ['git push origin', ['feat']],
    ['git push -u origin HEAD', ['feat']],
    ['git push origin @', ['feat']],
  ])('resolves the current branch and where it pushes for %s', async (text, branches) => {
    expect(await branchesOf(text)).toEqual({ branches });
  });

  it('adds the upstream a named branch pushes to', async () => {
    expect(await branchesOf('git push origin sneaky')).toEqual({ branches: ['sneaky', 'main'] });
  });

  it.each([
    ['git push --all origin', 'every branch'],
    ['git push --mirror origin', 'every branch'],
    ['git push origin "refs/heads/*:refs/heads/*"', 'a pattern'],
    ['git push origin $BRANCH', 'a variable'],
    ['git push origin $(git branch --show-current)', 'a variable'],
  ])('cannot tell the target of %s', async (text, why) => {
    expect(await branchesOf(text)).toEqual({ unknown: expect.stringContaining(why) });
  });

  it('cannot place the current branch after a cd or -C, or without git', async () => {
    expect(await branchesOf('git push', fakeGit(), true)).toEqual({
      unknown: expect.stringContaining('folder'),
    });
    expect(await branchesOf('git -C ../other push')).toEqual({
      unknown: expect.stringContaining('folder'),
    });
    expect(await branchesOf('git -C ../other push origin feat')).toEqual({ branches: ['feat'] });
    expect(await branchesOf('GIT_DIR=../other/.git git push')).toEqual({
      unknown: expect.stringContaining('folder'),
    });
    expect(
      await branchesOf('git push', fakeGit({ 'symbolic-ref --quiet --short HEAD': undefined })),
    ).toEqual({ unknown: expect.stringContaining('current branch') });
  });
});

describe('mainBranchesOf and pushesToMain', () => {
  it('is main, master and the default branch', async () => {
    expect(await mainBranchesOf(fakeGit())).toEqual(['main', 'master']);
    expect(
      await mainBranchesOf(
        fakeGit({ 'symbolic-ref --quiet --short refs/remotes/origin/HEAD': 'origin/development' }),
      ),
    ).toEqual(['main', 'master', 'development']);
    expect(await mainBranchesOf(undefined)).toEqual(['main', 'master']);
  });

  it.each([
    [['main'], true],
    [['MAIN'], true],
    [['refs/heads/master'], true],
    [['feat', 'main'], true],
    [['feat'], false],
    [['main-fix'], false],
  ])('%j pushes to main: %s', (branches, expected) => {
    expect(pushesToMain(branches, ['main', 'master'])).toBe(expected);
  });
});
