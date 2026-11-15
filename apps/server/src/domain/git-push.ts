import { gitGlobals } from './approval-marks.js';
import { commandHead, lexCommand } from './permissions.js';

/**
 * Where a Steward's `git push` goes (P13-20, SPEC decision 161): in Auto the Waykeeper approves a
 * push to a branch other than the main branch, and never approves one to the main branch or one
 * whose target it cannot tell. Reads the command's own words; the current branch and where a
 * branch pushes come from `git` in the Steward's worktree.
 */

/** Runs `git <args>` in the Steward's worktree: its trimmed output, or `undefined` on any failure. */
export type GitRead = (args: string[]) => Promise<string | undefined>;

/** The branches a push updates, or why they cannot be told. */
export type GitPush = { branches: string[] } | { unknown: string };

/** Options of `git push` that take the next word as their value. */
const VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-o',
  '--push-option',
  '--repo',
  '--receive-pack',
  '--exec',
]);
/** Options that push more than the named branches. */
const EVERY_BRANCH: ReadonlySet<string> = new Set(['--all', '--mirror', '--branches', '--prune']);
/** Commands that move the shell to another folder before a push. */
const MOVES = /^(cd|pushd|popd)$/;

/** Whether a part's text moves to another folder (`cd`, `pushd`): the current branch is unknown. */
export function movesFolder(text: string): boolean {
  return lexCommand(text).commands.some((c) => {
    const h = commandHead(c.words);
    return MOVES.test(c.words[h] ?? '');
  });
}

/**
 * The branches a part's `git push` updates: every refspec's destination (`src:dst`, `:dst`,
 * `--delete b`), a plain `src` with the branch its upstream or push config sends it to, and with
 * no refspec (or `HEAD`) the current branch with its upstream and push branch. `undefined` when
 * the part is no git push; `unknown` for more than one command, `--all`/`--mirror`/`--prune`, a
 * pattern, a variable, or a current branch that cannot be read (after a `cd` or `-C`, a
 * detached head, git failing). `moved` says an earlier part changed folder.
 */
export async function gitPushOf(
  text: string,
  git: GitRead | undefined,
  moved: boolean,
): Promise<GitPush | undefined> {
  const commands = lexCommand(text).commands;
  const push = commands.find((c) => {
    const h = commandHead(c.words);
    const name = (c.words[h] ?? '').split('/').pop();
    return name === 'git' && gitGlobals(c.words.slice(h + 1)).rest[0] === 'push';
  });
  if (push === undefined) return undefined;
  const h = commandHead(push.words);
  const globals = push.words.slice(h + 1);
  const { dirs, rest } = gitGlobals(globals);
  const args = rest.slice(1);
  if (args.some((w) => /[$`]/.test(w))) return { unknown: 'its target is a variable' };
  if (commands.length > 1) return { unknown: 'more than one command' };
  const elsewhere =
    moved ||
    dirs.length > 0 ||
    globals.some((w) => /^--(git-dir|work-tree)\b/.test(w)) ||
    push.words.slice(0, h).some((w) => /^GIT_[A-Z_]*=/.test(w));

  const positional: string[] = [];
  let deleting = false;
  let options = true;
  for (let k = 0; k < args.length; k++) {
    const w = args[k]!;
    if (options && w === '--') {
      options = false;
      continue;
    }
    if (options && w.startsWith('-') && w !== '-') {
      const bare = w.split('=')[0]!;
      if (EVERY_BRANCH.has(bare)) return { unknown: `${bare} pushes every branch` };
      if (bare === '--delete') deleting = true;
      else if (VALUE_OPTIONS.has(w)) k++;
      else if (/^-[a-zA-Z]+$/.test(w)) {
        if (w.includes('d')) deleting = true;
        if (w.endsWith('o')) k++;
      }
      continue;
    }
    positional.push(w);
  }
  const refspecs = positional.slice(1);

  const branches: string[] = [];
  const current = async (): Promise<GitPush | undefined> => {
    if (elsewhere) return { unknown: 'the push runs in another folder' };
    const branch = await git?.(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (!branch) return { unknown: 'the current branch cannot be read' };
    branches.push(branch, ...(await pushedTo(git, branch)));
    return undefined;
  };

  if (refspecs.length === 0) {
    const failed = await current();
    if (failed) return failed;
  }
  for (const spec of refspecs) {
    if (spec.includes('*')) return { unknown: 'a pattern names its branches' };
    const plain = spec.replace(/^\+/, '');
    const colon = plain.indexOf(':');
    if (colon >= 0) {
      const dst = plain.slice(colon + 1);
      if (dst === '') return { unknown: `the refspec ${spec} names no branch` };
      branches.push(dst);
    } else if (plain === 'HEAD' || plain === '@') {
      const failed = await current();
      if (failed) return failed;
    } else {
      branches.push(plain);
      if (!deleting && !elsewhere) branches.push(...(await pushedTo(git, plain)));
    }
  }
  return { branches: [...new Set(branches.map(branchName))] };
}

/** The remote branches `branch` tracks and pushes to (`origin/main` → `main`), when set. */
async function pushedTo(git: GitRead | undefined, branch: string): Promise<string[]> {
  const out = await git?.([
    'for-each-ref',
    '--format=%(upstream:lstrip=3)%09%(push:lstrip=3)',
    `refs/heads/${branchName(branch)}`,
  ]);
  return (out ?? '')
    .split('\t')
    .map((b) => b.trim())
    .filter((b) => b !== '');
}

/** `refs/heads/x` → `x`. */
function branchName(ref: string): string {
  return ref.replace(/^refs\/heads\//, '');
}

/** The branches that count as the main branch: `main`, `master` and the remote's default branch. */
export async function mainBranchesOf(git: GitRead | undefined): Promise<string[]> {
  const head = await git?.(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  const fallback = head?.replace(/^[^/]+\//, '');
  return [...new Set(['main', 'master', ...(fallback ? [fallback] : [])])];
}

/** Whether any of `branches` is one of `mains` (ignoring case and a `refs/heads/` in front). */
export function pushesToMain(branches: readonly string[], mains: readonly string[]): boolean {
  const main = new Set(mains.map((m) => m.toLowerCase()));
  return branches.some((b) => main.has(branchName(b).toLowerCase()));
}
