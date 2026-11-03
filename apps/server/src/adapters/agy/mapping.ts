import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ToolCall } from '@galactic/protocol';
import { ASK_USER_TOOL, TOOL_SERVER_NAME } from './tool-server.js';

/**
 * What Mission Control's hook says about one agy tool call (P11-05; P11-01 notes, agy 4 and 6):
 * the call in agy's words (`run_command {CommandLine}`, `write_file {Path, Content}`, …) becomes
 * a call the permission gate understands (`Bash {command}`, `Write {file_path}`, …), or a fixed
 * verdict for what the gate has no rule about:
 *
 * - **deny**: every tool outside this list (an unknown or future tool, `schedule`, plugins,
 *   notebooks, …); the browser tools (unexercised in P11-01); agy's own question tools (nobody
 *   can answer them headless — the Steward is told to use `ask_user`); a write under `.agents/`
 *   or `.gemini/` (agy's hook and MCP configuration); an MCP call to any server but Mission
 *   Control's own `galactic`.
 * - **allow** without the gate: agy's bookkeeping (`send_message`, `wait`, `invoke_subagent` —
 *   the subagent's own tool calls reach the hook too), reading the descriptor of one of
 *   Mission Control's tools (agy reads `~/.gemini/antigravity-cli/mcp/galactic/<tool>.json`
 *   before calling it) and reading agy's built-in skills (`~/.gemini/antigravity-cli/builtin/`).
 * - **ask_user**: the adapter's clarification tool, a question not an action.
 * - **gate**: everything else, as a gate call; a server tool by its bare name.
 */

export type AgyVerdict =
  | { kind: 'deny'; reason: string }
  | { kind: 'allow'; report?: ToolCall }
  | { kind: 'ask_user' }
  | { kind: 'gate'; call: ToolCall; mcpTool?: string };

export interface MappingContext {
  cwd: string;
  home: string;
  serverTools: ReadonlySet<string>;
}

const BROWSER_TOOLS = new Set([
  'open_browser_url',
  'read_browser_page',
  'click_browser_pixel',
  'capture_browser_screenshot',
  'capture_browser_console_logs',
  'execute_browser_javascript',
  'list_browser_pages',
]);
const QUESTION_TOOLS = new Set(['ask_question', 'ask_permission', 'ask_custom_permission']);
/** agy's own bookkeeping: no effect outside the conversation. */
const BOOKKEEPING = new Set([
  'send_message',
  'wait',
  'wait_5_seconds',
  'finish',
  'command_status',
  'list_permissions',
  'manage_task',
  'invoke_subagent',
]);
const READ_TOOLS = new Set(['read_file', 'view_file']);
const WRITE_TOOLS = new Set(['write_file', 'write_to_file']);
const EDIT_TOOLS = new Set(['edit_file', 'replace_file_content', 'multi_replace_file_content']);
/** Input keys that name a file, in the order agy's tools use them. */
const PATH_KEYS = ['Path', 'AbsolutePath', 'TargetFile', 'File', 'FilePath', 'file_path', 'path'];
/** Input keys that name a directory to list or search. */
const DIR_KEYS = ['DirectoryPath', 'SearchDirectory', 'SearchPath', 'Directory', ...PATH_KEYS];

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/**
 * Every location the call names under `keys` (distinct, in key order). All of them go to the gate
 * (`paths`), so a second path key the tool really uses cannot hide behind the first.
 */
function pathsOf(args: Record<string, unknown>, keys: readonly string[] = PATH_KEYS): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const v = str(args[key]);
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** The gate input for the locations of a call: the first as `file_path`/`path`, all as `paths`. */
function located(field: 'file_path' | 'path', paths: string[]): Record<string, unknown> {
  return { [field]: paths[0], ...(paths.length > 1 ? { paths } : {}) };
}

/**
 * Fail closed on an argument the mapping cannot find (an unobserved or renamed key): the call is
 * refused, never judged as if it named the worktree.
 */
function missing(name: string, what: string): AgyVerdict {
  return {
    kind: 'deny',
    reason: `${name} names no ${what} GalacticAgents can check, so it is refused`,
  };
}

/** `~/x` and relative paths made absolute (relative to the Steward's worktree). */
function absolute(p: string, ctx: MappingContext): string {
  const home = p === '~' || p.startsWith('~/') ? join(ctx.home, p.slice(1)) : p;
  return isAbsolute(home) ? resolve(home) : resolve(ctx.cwd, home);
}

/**
 * `p` with symlinks resolved: the real path of its longest existing ancestor, plus the rest
 * (a file that does not exist yet is judged by where its folder really is).
 */
export function realLocation(p: string): string {
  let head = p;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...rest.reverse());
    } catch {
      const up = dirname(head);
      if (up === head) return p;
      rest.push(basename(head));
      head = up;
    }
  }
}

const AGY_CONFIG_DIRS = (s: string) => s === '.agents' || s === '.gemini';

/**
 * A path under agy's own configuration: `.agents/` (workspace) or `.gemini/` (home), as written
 * or once symlinks are resolved (a link in the worktree pointing into one counts).
 */
export function isAgyConfig(p: string, ctx: MappingContext): boolean {
  const lexical = absolute(p, ctx);
  return [lexical, realLocation(lexical)].some((candidate) =>
    candidate
      .split(sep)
      .map((s) => s.normalize('NFC').toLowerCase())
      .some(AGY_CONFIG_DIRS),
  );
}

function within(dir: string, p: string): boolean {
  const rel = relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** A shell line run from `cwd`: prefixed with `cd` when that is not the worktree. */
function commandCall(args: Record<string, unknown>, ctx: MappingContext): ToolCall | undefined {
  const line = str(args['CommandLine']) ?? str(args['command']);
  if (line === undefined || !line.trim()) return undefined;
  const cwd = str(args['Cwd']) ?? str(args['cwd']);
  const command =
    cwd && resolve(absolute(cwd, ctx)) !== resolve(ctx.cwd)
      ? `cd '${absolute(cwd, ctx).replace(/'/g, `'\\''`)}' && ${line}`
      : line;
  return { toolName: 'Bash', input: { command } };
}

const isUrl = (p: string) => /^https?:\/\//i.test(p);

export function mapAgyCall(call: ToolCall, ctx: MappingContext): AgyVerdict {
  const name = call.toolName;
  const args = asRecord(call.input);

  if (name.startsWith('browser_') || BROWSER_TOOLS.has(name)) {
    return { kind: 'deny', reason: 'browser tools are not available to GalacticAgents Stewards' };
  }
  if (QUESTION_TOOLS.has(name)) {
    return {
      kind: 'deny',
      reason: `nobody can answer ${name} here: ask the user with the ${ASK_USER_TOOL} tool of the ${TOOL_SERVER_NAME} MCP server`,
    };
  }
  if (BOOKKEEPING.has(name)) return { kind: 'allow', report: { toolName: name, input: args } };

  if (name === 'call_mcp_tool') {
    const server = str(args['ServerName']);
    const tool = str(args['ToolName']) ?? '';
    if (server !== TOOL_SERVER_NAME) {
      return {
        kind: 'deny',
        reason: `only the ${TOOL_SERVER_NAME} MCP server is available to GalacticAgents Stewards`,
      };
    }
    if (tool === ASK_USER_TOOL && !ctx.serverTools.has(ASK_USER_TOOL)) return { kind: 'ask_user' };
    if (!ctx.serverTools.has(tool)) return { kind: 'deny', reason: `unknown tool: ${tool}` };
    return {
      kind: 'gate',
      call: { toolName: tool, input: args['Arguments'] ?? {} },
      mcpTool: tool,
    };
  }

  if (READ_TOOLS.has(name)) {
    const paths = pathsOf(args);
    if (paths.length === 0) return missing(name, 'file');
    const urls = paths.filter(isUrl);
    if (urls.length > 0) {
      if (urls.length !== paths.length) return missing(name, 'single location');
      return { kind: 'gate', call: { toolName: 'WebFetch', input: { url: urls[0] } } };
    }
    const cli = join(ctx.home, '.gemini', 'antigravity-cli');
    // Mission Control's tool descriptors, and agy's own built-in skills (read-only docs it ships
    // and its model reads to learn how to work): reading them is not an action.
    const harmless = (p: string) => {
      const target = realLocation(absolute(p, ctx));
      return (
        within(realLocation(join(cli, 'mcp', TOOL_SERVER_NAME)), target) ||
        within(realLocation(join(cli, 'builtin')), target)
      );
    };
    if (paths.every(harmless)) return { kind: 'allow' };
    return { kind: 'gate', call: { toolName: 'Read', input: located('file_path', paths) } };
  }
  if (WRITE_TOOLS.has(name) || EDIT_TOOLS.has(name)) {
    const paths = pathsOf(args);
    if (paths.length === 0) return missing(name, 'file');
    const config = paths.find((p) => isAgyConfig(p, ctx));
    if (config) {
      return {
        kind: 'deny',
        reason: `${config} is agy's configuration: Stewards may not change it`,
      };
    }
    const toolName = WRITE_TOOLS.has(name) ? 'Write' : 'Edit';
    return { kind: 'gate', call: { toolName, input: located('file_path', paths) } };
  }

  switch (name) {
    case 'run_command': {
      const call = commandCall(args, ctx);
      return call ? { kind: 'gate', call } : missing(name, 'command');
    }
    case 'list_dir': {
      const paths = pathsOf(args, DIR_KEYS);
      if (paths.length === 0) return missing(name, 'folder');
      return { kind: 'gate', call: { toolName: 'LS', input: located('path', paths) } };
    }
    case 'find_by_name':
    case 'grep_search': {
      const paths = pathsOf(args, DIR_KEYS);
      if (paths.length === 0) return missing(name, 'folder');
      const pattern = str(args['Pattern']) ?? str(args['Query']);
      return {
        kind: 'gate',
        call: {
          toolName: name === 'find_by_name' ? 'Glob' : 'Grep',
          input: { ...located('path', paths), ...(pattern ? { pattern } : {}) },
        },
      };
    }
    case 'search_web': {
      const query = str(args['query']) ?? str(args['Query']);
      if (!query) return missing(name, 'query');
      return { kind: 'gate', call: { toolName: 'WebSearch', input: { query } } };
    }
    case 'read_url_content': {
      const url = str(args['Url']) ?? str(args['url']);
      if (!url) return missing(name, 'URL');
      return { kind: 'gate', call: { toolName: 'WebFetch', input: { url } } };
    }
    case 'generate_image':
      // An image costs a large share of the weekly quota: the table's unclassified entry decides.
      return { kind: 'gate', call: { toolName: 'agy:generate_image', input: args } };
    default:
      return {
        kind: 'deny',
        reason: `${name} is not available to GalacticAgents Stewards`,
      };
  }
}

/** A one-line description of an agy call for transcript lines and permission cards. */
export function describeAgyCall(call: ToolCall): string {
  const input = asRecord(call.input);
  if (call.toolName === 'Bash' && typeof input['command'] === 'string') {
    return `\`${input['command'].slice(0, 300)}\``;
  }
  const p = str(input['file_path']) ?? str(input['path']) ?? str(input['url']);
  return p ? `${call.toolName} on ${p.slice(0, 300)}` : call.toolName;
}
