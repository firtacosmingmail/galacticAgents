import { execFile } from 'node:child_process';
import type { PreflightProblem, RuntimePreflight } from '@galactic/protocol';
import { versionInRange, versionOf } from '../version-range.js';

/**
 * The Codex runtime's preflight (P11-04; SPEC §4.6): is the `codex` CLI there, which version,
 * and is it logged in with a ChatGPT subscription (Global Constraints: subscription logins only).
 * `codex --version` prints `codex-cli 0.166.0`; `codex login status` prints `Logged in using
 * ChatGPT` and exits 0, or exits non-zero when logged out (P11-01 research). Neither spends a
 * turn, and `~/.codex/auth.json` is never read. Every failure is a problem with a fix.
 */

/** The Codex versions this adapter was tested with (P11-01 ran 0.166.0). */
export const KNOWN_CODEX_VERSIONS = '>=0.166 <0.200';

export type CodexExec = (
  file: string,
  args: string[],
  env: Record<string, string>,
) => Promise<{ stdout: string; stderr: string; code: number | null; missing: boolean }>;

const TIMEOUT_MS = 10_000;

export const execCodex: CodexExec = (file, args, env) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: TIMEOUT_MS, encoding: 'utf8', env },
      (error, stdout, stderr) => {
        const err = error as (NodeJS.ErrnoException & { code?: unknown }) | null;
        resolve({
          stdout,
          stderr,
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          missing: err?.code === 'ENOENT',
        });
      },
    );
  });

export interface CodexPreflightOptions {
  command: string;
  /** Arguments before the subcommand (tests: the fake agent's script). */
  args?: string[];
  env: Record<string, string>;
  exec?: CodexExec;
}

export async function codexPreflight(opts: CodexPreflightOptions): Promise<RuntimePreflight> {
  const exec = opts.exec ?? execCodex;
  const pre = opts.args ?? [];
  const base = { runtime: 'codex' as const, provider: 'chatgpt' as const };
  const problems: PreflightProblem[] = [];

  const versionRun = await exec(opts.command, [...pre, '--version'], opts.env);
  if (versionRun.missing || (versionRun.code !== 0 && !versionOf(versionRun.stdout))) {
    return {
      ...base,
      ok: false,
      installed: false,
      problems: [
        {
          code: 'not_installed',
          severity: 'error',
          message: versionRun.missing
            ? `The Codex CLI was not found: ${opts.command}`
            : `The Codex CLI did not run: ${(versionRun.stderr || versionRun.stdout).trim().slice(0, 200) || `exit ${versionRun.code}`}`,
          fix: 'Install it with `npm i -g @openai/codex` (or `brew install codex`), or fix `codex.command` in config.json',
        },
      ],
    };
  }
  const version = versionOf(versionRun.stdout);
  if (version && !versionInRange(version, KNOWN_CODEX_VERSIONS)) {
    problems.push({
      code: 'check_failed',
      severity: 'warning',
      message: `Codex ${version} has not been tested with GalacticAgents`,
      fix: `Versions ${KNOWN_CODEX_VERSIONS} are known to work; Stewards may still run`,
    });
  }

  const login = await exec(opts.command, [...pre, 'login', 'status'], opts.env);
  const said = `${login.stdout}\n${login.stderr}`;
  let loggedIn = login.code === 0 && !/not logged in/i.test(said);
  let authMethod: string | undefined;
  if (loggedIn) {
    if (/api key/i.test(said)) {
      authMethod = 'api_key';
      problems.push({
        code: 'not_subscription',
        severity: 'error',
        message:
          'Codex is logged in with an API key; GalacticAgents runs Codex on a ChatGPT subscription only',
        fix: 'Run `codex logout`, then `codex login` in Terminal and sign in with ChatGPT',
      });
    } else if (/chatgpt/i.test(said)) {
      authMethod = 'chatgpt';
    }
  } else {
    loggedIn = false;
    problems.push({
      code: 'not_logged_in',
      severity: 'error',
      message: 'Codex is not logged in',
      fix: 'Run codex login in Terminal',
    });
  }
  return {
    ...base,
    ok: !problems.some((p) => p.severity === 'error'),
    installed: true,
    ...(version ? { version } : {}),
    loggedIn,
    ...(authMethod ? { authMethod } : {}),
    problems,
  };
}
