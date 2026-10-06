import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PreflightProblem, RuntimePreflight } from '@galactic/protocol';
import { resolveCommand } from '../acp/preflight.js';
import type { PtyAgentCommand } from './pty-adapter.js';
import { ensureSpawnHelper, loadPty, ptyPackageDir } from './pty-child.js';

/**
 * The PTY runtime's preflight (P25-01; SPEC §4.6): is the configured CLI on the `PATH`, and does
 * `node-pty` load here (a native module: prebuilt for macOS and Windows, built from source on
 * Linux at install). Its version is reported as the SDK version. A CLI has no common login check:
 * one that needs a login shows it in its terminal.
 */
export async function ptyPreflight(
  agent: PtyAgentCommand,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RuntimePreflight> {
  const problems: PreflightProblem[] = [];
  const found = resolveCommand(agent.command, env['PATH'] ?? '');
  if (!found) {
    problems.push({
      code: 'not_installed',
      severity: 'error',
      message: `The terminal agent's command was not found: ${agent.command}`,
      fix: 'install it, or fix `pty.command` in config.json',
    });
  }
  const dir = ptyPackageDir();
  let sdkVersion: string | undefined;
  try {
    if (!dir) throw new Error('node-pty is not installed');
    sdkVersion = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string })
      .version;
    const stuck = ensureSpawnHelper();
    if (stuck.length > 0) {
      throw new Error(`its helper is not executable: ${stuck.join(', ')}`);
    }
    await loadPty();
  } catch (error) {
    problems.push({
      code: 'sdk_missing',
      severity: 'error',
      message: `node-pty cannot run here: ${(error as Error).message}`,
      fix: 'run `pnpm install` again (on Linux node-pty is compiled at install: it needs python3, make and a C++ compiler)',
    });
  }
  return {
    runtime: 'pty',
    ok: !problems.some((p) => p.severity === 'error'),
    installed: found !== undefined,
    ...(sdkVersion ? { sdkVersion } : {}),
    problems,
  };
}
