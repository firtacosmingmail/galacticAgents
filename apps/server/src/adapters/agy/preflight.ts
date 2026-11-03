import { execFile } from 'node:child_process';
import type { ModelInfo, PreflightProblem, RuntimePreflight } from '@galactic/protocol';
import { versionInRange, versionOf } from '../version-range.js';
import { usageSucceeded } from './limits.js';

/**
 * The Antigravity runtime's preflight (P11-05; SPEC §4.6): is `agy` there, which version, and is
 * it logged in with a Google account. agy has no auth-status command; `agy -p "/usage"
 * --output-format json` answers without a model turn (`status: SUCCESS`) when logged in, and
 * prints "Authentication required" with a login URL when not (P11-01 notes; seen with an empty
 * home). Credentials are never read. Every failure is a problem with a fix.
 */

/** The agy versions this adapter was tested with (P11-01 and P11-05 ran 1.4.12). */
export const KNOWN_AGY_VERSIONS = '>=1.4.12 <1.5';

export type AgyExec = (
  file: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs?: number,
) => Promise<{ stdout: string; stderr: string; code: number | null; missing: boolean }>;

const TIMEOUT_MS = 15_000;

export const execAgy: AgyExec = (file, args, env, timeoutMs = TIMEOUT_MS) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, encoding: 'utf8', env, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const err = error as (NodeJS.ErrnoException & { code?: unknown }) | null;
        resolve({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          missing: err?.code === 'ENOENT',
        });
      },
    );
  });

export const USAGE_ARGS = ['-p', '/usage', '--output-format', 'json'];

export interface AgyPreflightOptions {
  command: string;
  /** Arguments before agy's own (tests: the fake agent's script). */
  args?: string[];
  env: Record<string, string>;
  exec?: AgyExec;
  /** A problem with Mission Control's global hook entries (the adapter checks them). */
  entriesProblem?: string;
}

export async function agyPreflight(opts: AgyPreflightOptions): Promise<RuntimePreflight> {
  const exec = opts.exec ?? execAgy;
  const pre = opts.args ?? [];
  const base = { runtime: 'agy' as const, provider: 'gemini' as const };
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
            ? `The Antigravity CLI was not found: ${opts.command}`
            : `The Antigravity CLI did not run: ${(versionRun.stderr || versionRun.stdout).trim().slice(0, 200) || `exit ${versionRun.code}`}`,
          fix: 'Install the Antigravity CLI (`agy`), or fix `agy.command` in config.json',
        },
      ],
    };
  }
  const version = versionOf(versionRun.stdout);
  if (version && !versionInRange(version, KNOWN_AGY_VERSIONS)) {
    problems.push({
      code: 'check_failed',
      severity: 'warning',
      message: `Antigravity CLI ${version} has not been tested with GalacticAgents`,
      fix: `Versions ${KNOWN_AGY_VERSIONS} are known to work; Stewards may still run`,
    });
  }
  if (opts.entriesProblem) {
    problems.push({
      code: 'check_failed',
      severity: 'error',
      message: opts.entriesProblem,
      fix: 'Fix ~/.gemini/config/hooks.json and mcp_config.json so GalacticAgents can add its entries',
    });
  }

  const usage = await exec(opts.command, [...pre, ...USAGE_ARGS], opts.env);
  const said = `${usage.stdout}\n${usage.stderr}`;
  const loggedIn = usage.code === 0 && usageSucceeded(usage.stdout);
  if (!loggedIn) {
    problems.push(
      /authenticat|log ?in|sign ?in/i.test(said) || usage.code !== 0
        ? {
            code: 'not_logged_in',
            severity: 'error',
            message: 'The Antigravity CLI is not logged in',
            fix: 'Run agy in Terminal and sign in with your Google account',
          }
        : {
            code: 'check_failed',
            severity: 'error',
            message: `The Antigravity CLI's /usage did not answer as expected: ${said.trim().slice(0, 200)}`,
            fix: 'Run `agy -p /usage` in Terminal to see what it says',
          },
    );
  }
  return {
    ...base,
    ok: !problems.some((p) => p.severity === 'error'),
    installed: true,
    ...(version ? { version } : {}),
    loggedIn,
    ...(loggedIn ? { authMethod: 'google' } : {}),
    problems,
  };
}

/**
 * `agy models` (tab-separated `id\tlabel`, after a "Fetching available models..." line): Gemini
 * models make images too; the family comes from the id's prefix.
 */
export function parseModels(stdout: string): ModelInfo[] {
  const out: ModelInfo[] = [];
  for (const line of stdout.split('\n')) {
    const [id, label] = line.split('\t').map((s) => s.trim());
    if (!id || !label || /\s/.test(id)) continue;
    const family = id.startsWith('gemini')
      ? 'gemini'
      : id.startsWith('claude')
        ? 'claude'
        : id.startsWith('gpt')
          ? 'gpt'
          : 'other';
    out.push({
      id,
      label,
      isDefault: false,
      capabilities: id.startsWith('gemini-') ? ['text', 'image'] : ['text'],
      family,
    });
  }
  return out;
}
