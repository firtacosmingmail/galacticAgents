import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
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

  describe('identity (P11-11)', () => {
    const saved = { ...process.env };
    afterEach(() => {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    });

    it('passes EMAIL through as the fallback email, and no other identity or secret', async () => {
      process.env.EMAIL = 'fallback@test.invalid';
      process.env.GIT_COMMITTER_NAME = 'Shell Name';
      process.env.GALACTIC_SECRET_FOR_TEST = 'must-not-pass';
      const git = gitRunner({ env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
      const ident = await git(tmpdir(), ['-c', 'user.name=Mission', 'var', 'GIT_COMMITTER_IDENT']);
      expect(ident.stdout).toMatch(/^Mission <fallback@test\.invalid>/);
      const env = await git(tmpdir(), ['-c', 'alias.show-env=!env', 'show-env']);
      expect(env.stdout).not.toContain('GALACTIC_SECRET_FOR_TEST');
    });
  });
});
