import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PreflightProblem, RuntimePreflight } from '@galactic/protocol';
import { INHERITED_ENV } from '../../runtime/supervisor.js';

/**
 * The Claude runtime's preflight (P25-01; SPEC §4.6, decision 17): is Claude Code installed, is
 * it logged in — with a subscription, which decision 17 assumes — and which versions. The SDK
 * drives its own bundled Claude Code but shares the `claude` CLI's login (P1-08), so the login is
 * read from `claude auth status` (JSON), as `scripts/check-real.mjs` does. Every failure is a
 * problem with a fix, never an exception. Without a `claude` on the PATH the SDK still runs its
 * bundled CLI: that is a warning (the bundled version is reported, and the login is read through
 * the bundled binary when it can be found), not an error.
 *
 * The commands get the same allow-listed environment as an agent (`INHERITED_ENV`, P1-24): the
 * server's token and any API key are not theirs, and the login they report is the agents' one.
 */

/** Runs a command and resolves with its output, or with the error (`code` ENOENT: not found). */
export type Exec = (
  file: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string; error?: { message: string; code?: unknown } }>;

const TIMEOUT_MS = 10_000;

/** The allow-listed part of the server's environment (what an agent's process inherits). */
export function allowListedEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

export const execCommand: Exec = (file, args) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: TIMEOUT_MS, encoding: 'utf8', env: allowListedEnv() },
      (error, stdout, stderr) => {
        resolve({ stdout, stderr, ...(error ? { error } : {}) });
      },
    );
  });

/** The Claude Code the Agent SDK bundles: its version (`manifest.json`) and binary, if found. */
export interface BundledCli {
  version?: string;
  path?: string;
}

export function bundledCli(): BundledCli | undefined {
  try {
    const entry = fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk'));
    const found: BundledCli = {};
    try {
      const manifest = JSON.parse(readFileSync(join(dirname(entry), 'manifest.json'), 'utf8')) as {
        version?: unknown;
      };
      if (typeof manifest.version === 'string') found.version = manifest.version;
    } catch {
      // no manifest: an SDK without a bundled CLI, or another layout
    }
    try {
      const native = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
      const pkg = createRequire(entry).resolve(`${native}/package.json`);
      const binary = join(dirname(pkg), process.platform === 'win32' ? 'claude.exe' : 'claude');
      if (existsSync(binary)) found.path = binary;
    } catch {
      // the native package for this platform is not installed
    }
    return found.version || found.path ? found : undefined;
  } catch {
    return undefined;
  }
}

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
  bundled: () => BundledCli | undefined = bundledCli,
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

  let version = await exec(binary, ['--version']);
  if (version.error?.code === 'ENOENT') {
    const cli = bundled();
    if (cli) {
      problems.push({
        code: 'not_installed',
        severity: 'warning',
        message:
          'No `claude` command on the PATH: agents run the Claude Code bundled with the Agent ' +
          `SDK${cli.version ? ` (${cli.version})` : ''}.`,
        fix: 'install Claude Code (https://claude.com/claude-code) to log in and check it from a terminal',
      });
      if (!cli.path) {
        result.installed = true;
        if (cli.version) result.version = cli.version;
        problems.push({
          code: 'auth_unreadable',
          severity: 'error',
          message: 'Could not read the Claude login: no `claude` command to ask.',
          fix: LOGIN_FIX,
        });
        return finish(result);
      }
      binary = cli.path;
      version = await exec(binary, ['--version']);
    }
  }
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
