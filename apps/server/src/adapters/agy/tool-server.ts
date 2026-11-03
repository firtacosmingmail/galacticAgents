import type { ToolDefinition } from '@galactic/protocol';
import { mcpText, type HookTools, type McpCallResult, type McpToolSpec } from './hook-bridge.js';

/**
 * Mission Control's tool server for agy Stewards (P11-05; TECHNOLOGY §3.7): the session's server
 * tools (`SpawnOptions.tools`) plus the adapter's own `ask_user`, served over MCP by
 * `galactic-agy-tools.mjs` — a stdio MCP server agy starts from Mission Control's managed entry
 * in `~/.gemini/config/mcp_config.json`, which forwards `tools/list` and `tools/call` to
 * `POST /api/agy-hook/tools|call` with the session's secret. This module is the server side of
 * that: what the list holds and how a call runs.
 *
 * A call reaches agy's PreToolUse hook first (`call_mcp_tool {ServerName: "galactic", ToolName,
 * Arguments}`), where the session's gate judges it; only a call the hook let through may run
 * here (`allowed` consumes one pass per tool name), so nothing runs that the gate never saw.
 */

/** The MCP server name of the managed entry (`call_mcp_tool`'s `ServerName`). */
export const TOOL_SERVER_NAME = 'galactic';

/**
 * The adapter's own clarification tool (ruling R6, as on Codex): agy's `ask_question` cannot ask
 * anyone headless, so a Steward asks the user through this one — an
 * `agent.needs_input(clarification)` that blocks until answered; the answer is the result.
 */
export const ASK_USER_TOOL = 'ask_user';
export const ASK_USER_SPEC: McpToolSpec = {
  name: ASK_USER_TOOL,
  description:
    'Ask the user one question and wait for the answer (the answer text is the result). Use it ' +
    'whenever you need the user to decide or tell you something before you go on; offer `options` ' +
    'when the answer is one of a few choices.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question, in plain words.' },
      options: { type: 'array', items: { type: 'string' }, description: 'Choices, if any.' },
    },
    required: ['question'],
    additionalProperties: false,
  },
};

/** What the adapter adds to the Steward's first prompt about the tools (agy has no system prompt). */
export const ASK_USER_NOTE =
  'When you need the user to decide or tell you something, call the `ask_user` tool of the ' +
  '`galactic` MCP server with your question (and `options` when there are a few choices) and ' +
  'wait for its answer. Do not end your turn with a question in your reply: nobody reads it as ' +
  'one. Do not use ask_question or ask_permission: nobody can answer them here.';

export interface ToolServerOptions {
  tools: ReadonlyMap<string, ToolDefinition>;
  /** The user's answer to `ask_user` (or what a dismissal tells the agent). */
  askUser(args: unknown): Promise<McpCallResult>;
  /** Consumes the hook's pass for one call of `name`; false when the hook never let one through. */
  allowed(name: string): boolean;
}

export function createToolServer(opts: ToolServerOptions): HookTools {
  return {
    list(): McpToolSpec[] {
      const listed: McpToolSpec[] = [...opts.tools.values()].map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      if (!opts.tools.has(ASK_USER_TOOL)) listed.push(ASK_USER_SPEC);
      return listed;
    },
    async call(name: string, args: unknown): Promise<McpCallResult> {
      const tool = opts.tools.get(name);
      if (!tool && name !== ASK_USER_TOOL) return mcpText(`unknown tool: ${name}`, true);
      if (!opts.allowed(name)) {
        return mcpText(`the call to ${name} did not pass Mission Control's permission hook`, true);
      }
      if (!tool) return opts.askUser(args);
      try {
        const result = await tool.handler(args ?? {});
        return mcpText(typeof result === 'string' ? result : JSON.stringify(result ?? null));
      } catch (error) {
        return mcpText((error as Error)?.message || String(error), true);
      }
    },
  };
}
