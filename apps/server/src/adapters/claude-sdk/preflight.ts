import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PreflightProblem, RuntimePreflight } from '@galactic/protocol';

/**
 * The Claude runtime's preflight (P25-01; SPEC §4.6, decision 17): is Claude Code installed, is
 * it logged in — with a subscription, which decision 17 assumes — and which versions. The SDK
 * drives its own bundled Claude Code but shares the `claude` CLI's login (P1-08), so the login is
 * read from `claude auth status` (JSON), as `scripts/check-real.mjs` does. Every failure is a
 * problem with a fix, never an exception.
 */

/** Runs a command and resolves with its output, or with the error (`code` ENOENT: not found). */
export type Exec = (
  file: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string; error?: { message: string; code?: unknown } }>;

const TIMEOUT_MS = 10_000;

export const execCommand: Exec = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: TIMEOUT_MS, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ stdout, stderr, ...(error ? { error } : {}) });
    });
  });

/** The Agent SDK's version from its package.json; `undefined` when it cannot be found. */
export function sdkVersion(): string | undefined {
  try {
    const entry = fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk'));
    const pkg = JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

interface AuthStatus {
  loggedIn?: unknown;
  authMethod?: unknown;
  subscriptionType?: unknown;
  apiProvider?: unknown;
}

const LOGIN_FIX = 'run `claude` in a terminal and log in with /login (or `claude auth login`)';

export async function claudePreflight(
  exec: Exec = execCommand,
  sdk: () => string | undefined = sdkVersion,
  binary = 'claude',
): Promise<RuntimePreflight> {
  const problems: PreflightProblem[] = [];
  const result: RuntimePreflight = {
    runtime: 'claude-sdk',
    ok: false,
    installed: false,
    problems,
  };
  const sdkV = sdk();
  if (sdkV) result.sdkVersion = sdkV;
  else {
    problems.push({
      code: 'sdk_missing',
      severity: 'error',
      message: 'The Claude Agent SDK is not installed with the server.',
      fix: 'reinstall the server’s dependencies (`pnpm install`)',
    });
  }

  const version = await exec(binary, ['--version']);
  if (version.error) {
    const missing = version.error.code === 'ENOENT';
    problems.push({
      code: missing ? 'not_installed' : 'check_failed',
      severity: 'error',
      message: missing
        ? 'Claude Code is not installed (no `claude` command on the PATH).'
        : `\`claude --version\` failed: ${firstLine(version.error.message)}`,
      fix: missing
        ? 'install Claude Code (https://claude.com/claude-code, or `npm install -g @anthropic-ai/claude-code`), then restart GalacticAgents'
        : 'run `claude --version` in a terminal to see what is wrong',
    });
    return finish(result);
  }
  result.installed = true;
  const v = /(\d+\.\d+\.\d+\S*)/.exec(version.stdout);
  if (v) result.version = v[1]!;

  const auth = await exec(binary, ['auth', 'status']);
  let status: AuthStatus | undefined;
  try {
    status = JSON.parse(auth.stdout) as AuthStatus;
  } catch {
    status = undefined;
  }
  if (!status || typeof status !== 'object') {
    problems.push({
      code: 'auth_unreadable',
      severity: 'error',
      message: `Could not read the Claude login (\`claude auth status\`${auth.error ? `: ${firstLine(auth.error.message)}` : ''}).`,
      fix: LOGIN_FIX,
    });
    return finish(result);
  }
  result.loggedIn = status.loggedIn === true;
  if (typeof status.authMethod === 'string') result.authMethod = status.authMethod;
  if (typeof status.subscriptionType === 'string')
    result.subscriptionType = status.subscriptionType;
  if (typeof status.apiProvider === 'string') result.apiProvider = status.apiProvider;
  if (!result.loggedIn) {
    problems.push({
      code: 'not_logged_in',
      severity: 'error',
      message: 'Claude Code is installed but not logged in.',
      fix: LOGIN_FIX,
    });
  } else if (result.authMethod !== 'claude.ai') {
    problems.push({
      code: 'not_subscription',
      severity: 'warning',
      message:
        `Claude Code is logged in with ${result.authMethod ?? 'an unknown method'}, not a Claude ` +
        'subscription: agents bill that account instead (decision 17).',
      fix: 'to use your subscription, run `claude` and /login with your Claude.ai account',
    });
  }
  return finish(result);
}

function finish(result: RuntimePreflight): RuntimePreflight {
  result.ok = !result.problems.some((p) => p.severity === 'error');
  return result;
}

function firstLine(text: string): string {
  return text.split('\n')[0]!.slice(0, 200);
}
