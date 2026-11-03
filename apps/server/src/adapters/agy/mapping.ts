import { isAbsolute, join, relative, resolve, sep } from 'node:path';
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

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

function pathOf(args: Record<string, unknown>): string | undefined {
  for (const key of PATH_KEYS) {
    const v = str(args[key]);
    if (v) return v;
  }
  return undefined;
}

/** `~/x` and relative paths made absolute (relative to the Steward's worktree). */
function absolute(p: string, ctx: MappingContext): string {
  const home = p === '~' || p.startsWith('~/') ? join(ctx.home, p.slice(1)) : p;
  return isAbsolute(home) ? resolve(home) : resolve(ctx.cwd, home);
}

/** A path under agy's own configuration: `.agents/` (workspace) or `.gemini/` (home). */
function isAgyConfig(p: string, ctx: MappingContext): boolean {
  const segments = absolute(p, ctx)
    .split(sep)
    .map((s) => s.normalize('NFC').toLowerCase());
  return segments.includes('.agents') || segments.includes('.gemini');
}

function within(dir: string, p: string): boolean {
  const rel = relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** A shell line run from `cwd`: prefixed with `cd` when that is not the worktree. */
function commandCall(args: Record<string, unknown>, ctx: MappingContext): ToolCall {
  const line = str(args['CommandLine']) ?? str(args['command']) ?? '';
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
    const p = pathOf(args);
    if (p && isUrl(p)) return { kind: 'gate', call: { toolName: 'WebFetch', input: { url: p } } };
    if (p) {
      const cli = join(ctx.home, '.gemini', 'antigravity-cli');
      const target = absolute(p, ctx);
      // Mission Control's tool descriptors, and agy's own built-in skills (read-only docs it
      // ships and its model reads to learn how to work): reading them is not an action.
      if (
        within(join(cli, 'mcp', TOOL_SERVER_NAME), target) ||
        within(join(cli, 'builtin'), target)
      ) {
        return { kind: 'allow' };
      }
    }
    return { kind: 'gate', call: { toolName: 'Read', input: p ? { file_path: p } : {} } };
  }
  if (WRITE_TOOLS.has(name) || EDIT_TOOLS.has(name)) {
    const p = pathOf(args);
    if (p && isAgyConfig(p, ctx)) {
      return { kind: 'deny', reason: `${p} is agy's configuration: Stewards may not change it` };
    }
    const toolName = WRITE_TOOLS.has(name) ? 'Write' : 'Edit';
    return { kind: 'gate', call: { toolName, input: p ? { file_path: p } : {} } };
  }

  switch (name) {
    case 'run_command':
      return { kind: 'gate', call: commandCall(args, ctx) };
    case 'list_dir': {
      const p = str(args['DirectoryPath']) ?? pathOf(args);
      return { kind: 'gate', call: { toolName: 'LS', input: p ? { path: p } : {} } };
    }
    case 'find_by_name': {
      const p = str(args['SearchDirectory']) ?? pathOf(args);
      const pattern = str(args['Pattern']);
      return {
        kind: 'gate',
        call: {
          toolName: 'Glob',
          input: { ...(p ? { path: p } : {}), ...(pattern ? { pattern } : {}) },
        },
      };
    }
    case 'grep_search': {
      const p = str(args['SearchPath']) ?? pathOf(args);
      const pattern = str(args['Query']);
      return {
        kind: 'gate',
        call: {
          toolName: 'Grep',
          input: { ...(p ? { path: p } : {}), ...(pattern ? { pattern } : {}) },
        },
      };
    }
    case 'search_web':
      return {
        kind: 'gate',
        call: {
          toolName: 'WebSearch',
          input: { query: str(args['query']) ?? str(args['Query']) ?? '' },
        },
      };
    case 'read_url_content':
      return {
        kind: 'gate',
        call: { toolName: 'WebFetch', input: { url: str(args['Url']) ?? str(args['url']) ?? '' } },
      };
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
