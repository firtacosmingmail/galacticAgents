import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { gitRunner } from './git.js';

describe('gitRunner', () => {
  it('survives a git command that exits without reading its stdin (no uncaught EPIPE)', async () => {
    // `git --version` never reads stdin; a large input makes the write outlive the process, so the
    // pipe is closed under it. Without a listener on stdin that EPIPE was an uncaught exception.
    const git = gitRunner();
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on('uncaughtException', onUncaught);
    try {
      for (let i = 0; i < 5; i++) {
        const result = await git(tmpdir(), ['--version'], { input: 'x'.repeat(8 * 1024 * 1024) });
        expect(result.code).toBe(0);
        expect(result.stdout).toMatch(/^git version/);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off('uncaughtException', onUncaught);
    }
    expect(uncaught).toEqual([]);
  });
});
