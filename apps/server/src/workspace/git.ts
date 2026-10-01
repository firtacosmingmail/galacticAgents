import { execFile } from 'node:child_process';

/**
 * The one way the server runs git (P2-05). `execFile` with an argument array, never a shell
 * string, so a path with spaces or quotes is one argument. Every call:
 *
 * - disables hooks (`core.hooksPath=/dev/null`) and the fsmonitor daemon: a hook of the user's
 *   repo (post-checkout on `worktree add`, pre-merge-commit/post-merge on a merge, pre-commit on
 *   the initial commit) would otherwise run on the server's behalf with no agent and no permission
 *   gate in between. Stewards' own `git commit`s run in their shell, hooks included — that is the
 *   agent's business, under the project's policy.
 * - never prompts (`GIT_TERMINAL_PROMPT=0`, no editor) and speaks C locale, so output parses.
 * - gets a small environment, like an agent child (TECHNOLOGY §8): the server's token and keys
 *   never reach git, its filters or its merge drivers.
 *
 * Filters, merge drivers and `diff.external` configured in the repo are the user's own setup for
 * their repo and stay active (a `git lfs` checkout needs its smudge filter).
 */

const GIT_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'XDG_CONFIG_HOME', 'SSH_AUTH_SOCK'];

export const SAFE_GIT_CONFIG: readonly string[] = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.quotePath=false',
];

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitRunnerOptions {
  /** Extra environment (tests point `GIT_CONFIG_GLOBAL` at an empty file). */
  env?: Record<string, string>;
  /** Default 60 s: a checkout of a large repo is slow, a hang is a bug. */
  timeoutMs?: number;
}

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly result: GitResult,
  ) {
    super(
      `git ${args.join(' ')} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
    this.name = 'GitError';
  }
}

export type Git = (
  cwd: string,
  args: readonly string[],
  opts?: { allowFailure?: boolean; input?: string },
) => Promise<GitResult>;

export function gitRunner(options: GitRunnerOptions = {}): Git {
  const env: Record<string, string> = {};
  for (const name of GIT_ENV) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  Object.assign(env, {
    LC_ALL: 'C',
    LANG: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: 'true',
    GIT_MERGE_AUTOEDIT: 'no',
    GIT_OPTIONAL_LOCKS: '0',
    ...options.env,
  });
  const timeout = options.timeoutMs ?? 60_000;
  return (cwd, args, opts = {}) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        'git',
        [...SAFE_GIT_CONFIG, ...args],
        { cwd, env, timeout, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
        (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof error.code === 'number' ? error.code : -1;
          const result = { code, stdout, stderr };
          if (error && (code === -1 || !opts.allowFailure)) {
            reject(new GitError(args, code === -1 ? { ...result, stderr: error.message } : result));
          } else {
            resolve(result);
          }
        },
      );
      child.stdin?.end(opts.input ?? '');
    });
}

/** `-z` separated path lists (`diff --name-only -z`, `status --porcelain -z` paths). */
export function splitZ(out: string): string[] {
  return out.split('\0').filter(Boolean);
}
