import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { Id, UsedSource } from '@galactic/protocol';
import { hostOfUrl } from '../domain/hosts.js';
import { SERVER_TOOL_SERVER } from './permission-gate.js';

/**
 * What a job run actually read from (P15-02): Mission Control notes it from the run Steward's
 * allowed tool calls — the run never reports it, so a dashboard can show what really fed a value.
 * Only the kind and a target (a server, a host, a folder) are kept, never the call's content.
 */

/** The sources one run keeps: past this the later ones are not recorded. */
export const MAX_USED_SOURCES = 50;

const MCP_TOOL = /^mcp__(.+?)__/;
const URL_IN_TEXT = /https?:\/\/[^\s'"<>|;&)]+/i;
/** Bash commands that read their path arguments (a read, never a write). */
const READ_COMMANDS = new Set([
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'wc',
  'grep',
  'rg',
  'ls',
  'find',
  'tree',
  'stat',
  'file',
]);
/** Of those, the commands whose path argument is a folder to look in, not a file in one. */
const FOLDER_COMMANDS = new Set(['ls', 'find', 'tree', 'grep', 'rg']);

const record = (input: unknown): Record<string, unknown> =>
  input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {};
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const absolute = (path: string, cwd: string): string => resolve(cwd, path);

function inside(path: string, cwd: string): boolean {
  const rel = relative(cwd, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function bashSource(command: string, cwd: string): UsedSource | undefined {
  const words = command.trim().split(/\s+/);
  const program = words[0]?.split('/').pop();
  if (!program) return undefined;
  if (program === 'curl' || program === 'wget') {
    const host = hostOfUrl(URL_IN_TEXT.exec(command)?.[0] ?? '');
    return host ? { kind: 'site', target: host } : undefined;
  }
  if (!READ_COMMANDS.has(program)) return undefined;
  for (const raw of words.slice(1)) {
    const word = raw.replace(/^['"]|['"]$/g, '');
    // A home-folder path is outside the workspace; the shell expands it, so it is kept as written.
    const path = word.startsWith('~') ? word : word.startsWith('/') ? resolve(word) : undefined;
    if (path === undefined || (!path.startsWith('~') && inside(path, cwd))) continue;
    return { kind: 'files', target: FOLDER_COMMANDS.has(program) ? path : dirname(path) };
  }
  return undefined;
}

/**
 * The source one allowed tool call used, or `undefined` when it is not one: an MCP server's tool
 * (`mcp__<server>__<tool>`, never Mission Control's own `galactic` server), a web fetch or search
 * or a `curl`/`wget` URL (the host), a file read or search or a Bash read command on a path outside
 * `cwd` (its folder; the run's own checkout is not a data source).
 */
export function usedSourceOf(
  toolName: string,
  input: unknown,
  cwd: string,
): UsedSource | undefined {
  const mcp = MCP_TOOL.exec(toolName);
  if (mcp) return mcp[1] === SERVER_TOOL_SERVER ? undefined : { kind: 'mcp', target: mcp[1]! };
  const args = record(input);
  switch (toolName) {
    case 'WebFetch': {
      const host = hostOfUrl(text(args['url']) ?? '');
      return host ? { kind: 'site', target: host } : undefined;
    }
    case 'WebSearch':
      return { kind: 'site', target: 'web search' };
    case 'Read': {
      const file = text(args['file_path']);
      if (!file) return undefined;
      const folder = dirname(absolute(file, cwd));
      return inside(folder, cwd) ? undefined : { kind: 'files', target: folder };
    }
    case 'Grep':
    case 'Glob': {
      const given = text(args['path']);
      if (!given) return undefined;
      const folder = absolute(given, cwd);
      return inside(folder, cwd) ? undefined : { kind: 'files', target: folder };
    }
    case 'Bash': {
      const command = text(args['command']);
      return command ? bashSource(command, cwd) : undefined;
    }
    default:
      return undefined;
  }
}

/** The sources each running agent used so far; `take` hands them over once, when its run ends. */
export class RunSourceRecorder {
  private readonly byAgent = new Map<Id, Map<string, UsedSource>>();

  note(agentId: Id, toolName: string, input: unknown, cwd: string): void {
    try {
      const source = usedSourceOf(toolName, input, cwd);
      if (!source) return;
      const kept = this.byAgent.get(agentId) ?? new Map<string, UsedSource>();
      const key = `${source.kind}:${source.target}`;
      if (!kept.has(key) && kept.size < MAX_USED_SOURCES) kept.set(key, source);
      this.byAgent.set(agentId, kept);
    } catch {
      // Context for the dashboard only: a call that cannot be read is left out.
    }
  }

  take(agentId: Id): UsedSource[] {
    const kept = this.byAgent.get(agentId);
    this.byAgent.delete(agentId);
    return kept ? [...kept.values()] : [];
  }
}
