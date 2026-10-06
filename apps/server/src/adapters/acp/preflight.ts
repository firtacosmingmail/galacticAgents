import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuntimePreflight } from '@galactic/protocol';
import type { AcpAgentCommand } from './acp-adapter.js';

/**
 * The ACP runtime's preflight (P25-01; SPEC §4.6): is the configured agent command there. ACP
 * agents have no common version or login command (`gemini --version` exists, `codex-acp` and
 * `claude-agent-acp` speak only ACP on stdio), so the check finds the executable on the `PATH`
 * and reports the SDK version; a missing login shows up as the first spawn's `session/new` error.
 */
export async function acpPreflight(
  agent: AcpAgentCommand,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RuntimePreflight> {
  const found = resolveCommand(agent.command, env['PATH'] ?? '');
  const sdkVersion = sdkPackageVersion();
  return {
    runtime: 'acp',
    ok: found !== undefined,
    installed: found !== undefined,
    ...(sdkVersion ? { sdkVersion } : {}),
    problems: found
      ? []
      : [
          {
            code: 'not_installed',
            severity: 'error',
            message: `The ACP agent command was not found: ${agent.command}`,
            fix:
              'install the agent (for example `npm i -g @agentclientprotocol/claude-agent-acp`, ' +
              '`codex-acp`, or Gemini CLI run with `--acp`) or fix `acp.command` in config.json',
          },
        ],
  };
}

/** The executable `command` names: a path as given, else the first match on `PATH`. */
export function resolveCommand(command: string, path: string): string | undefined {
  const candidates =
    isAbsolute(command) || command.includes('/')
      ? [command]
      : path
          .split(delimiter)
          .filter(Boolean)
          .map((dir) => join(dir, command));
  return candidates.find((c) => {
    try {
      accessSync(c, constants.X_OK);
      return statSync(c).isFile();
    } catch {
      return false;
    }
  });
}

/** The SDK's version from its `package.json` (not exported: found next to its entry point). */
function sdkPackageVersion(): string | undefined {
  try {
    const entry = fileURLToPath(import.meta.resolve('@agentclientprotocol/sdk'));
    const pkg = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version;
  } catch {
    return undefined;
  }
}
