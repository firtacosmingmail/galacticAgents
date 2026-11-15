import { execFile } from 'node:child_process';
import type { GitRead } from '../domain/git-push.js';

/** How long one read-only `git` call may take before the push is treated as unknown. */
export const GIT_READ_TIMEOUT_MS = 3000;

/**
 * A `GitRead` in `cwd` (P13-20): runs `git <args>` with no prompt and no pager, and gives its
 * trimmed output, or `undefined` when git fails, times out or prints nothing on a failure.
 */
export function gitReader(cwd: string): GitRead {
  return (args) =>
    new Promise((resolve) => {
      execFile(
        'git',
        ['--no-pager', ...args],
        {
          cwd,
          timeout: GIT_READ_TIMEOUT_MS,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
        },
        (error, stdout) => resolve(error ? undefined : String(stdout).trim()),
      );
    });
}
