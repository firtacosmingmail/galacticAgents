import type { ChildProcess } from 'node:child_process';

/**
 * The slice of `@anthropic-ai/claude-agent-sdk` the adapter uses, typed locally so the adapter
 * is written against what it actually needs and tests can script it (`FakeSdk`). The real
 * module is loaded lazily by `loadSdk()`; nothing outside `adapters/claude-sdk` imports it
 * (CLAUDE.md: the adapter boundary).
 */

export interface SdkContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

export interface SdkSystemInit {
  type: 'system';
  subtype: 'init';
  session_id: string;
  model?: string;
  tools?: string[];
}

export interface SdkAssistantMessage {
  type: 'assistant';
  message: { content: SdkContentBlock[] };
  parent_tool_use_id: string | null;
  session_id?: string;
}

export interface SdkUserMessage {
  type: 'user';
  message: { role: 'user'; content: string | SdkContentBlock[] };
  parent_tool_use_id: string | null;
  session_id?: string;
  isSynthetic?: boolean;
}

export interface SdkResultMessage {
  type: 'result';
  subtype:
    | 'success'
    | 'error_during_execution'
    | 'error_max_turns'
    | 'error_max_budget_usd'
    | 'error_max_structured_output_retries';
  is_error: boolean;
  session_id: string;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  num_turns?: number;
  result?: string;
  errors?: string[];
}

/** Anything else the stream carries (status, rate limits, hooks, …) is ignored by type name. */
export interface SdkOtherMessage {
  type: string;
  subtype?: string;
  [key: string]: unknown;
}

export type SdkMessage =
  SdkSystemInit | SdkAssistantMessage | SdkUserMessage | SdkResultMessage | SdkOtherMessage;

export type SdkPermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string; interrupt?: boolean };

export interface SdkCanUseToolOptions {
  signal: AbortSignal;
  title?: string;
  displayName?: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
  toolUseID?: string;
}

export type SdkCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: SdkCanUseToolOptions,
) => Promise<SdkPermissionResult>;

export interface SdkHookInput {
  hook_event_name: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  session_id?: string;
}

export interface SdkHookOutput {
  hookSpecificOutput?: {
    hookEventName: 'PreToolUse';
    permissionDecision?: 'allow' | 'deny' | 'ask';
    permissionDecisionReason?: string;
  };
}

export type SdkHook = (
  input: SdkHookInput,
  toolUseId: string | undefined,
  options: { signal: AbortSignal },
) => Promise<SdkHookOutput>;

export interface SdkSpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
}

export interface SdkQueryOptions {
  cwd?: string;
  sessionId?: string;
  resume?: string;
  model?: string;
  systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string };
  settingSources?: ('user' | 'project' | 'local')[];
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
  includePartialMessages?: boolean;
  persistSession?: boolean;
  abortController?: AbortController;
  canUseTool?: SdkCanUseTool;
  hooks?: { PreToolUse?: { hooks: SdkHook[] }[] };
  mcpServers?: Record<string, unknown>;
  allowedTools?: string[];
  extraArgs?: Record<string, string | null>;
  env?: Record<string, string | undefined>;
  stderr?: (data: string) => void;
  spawnClaudeCodeProcess?: (options: SdkSpawnOptions) => ChildProcess;
  maxTurns?: number;
}

export type SdkStreamingPrompt = AsyncIterable<SdkUserMessage>;

/** The handle `query()` returns: the message stream plus control calls. */
export interface SdkQuery extends AsyncIterable<SdkMessage> {
  interrupt(): Promise<unknown>;
  close?(): void;
}

export interface SdkToolHandler {
  (input: Record<string, unknown>): Promise<{ content: { type: 'text'; text: string }[] }>;
}

export interface SdkSurface {
  query(params: { prompt: string | SdkStreamingPrompt; options?: SdkQueryOptions }): SdkQuery;
  /** Builds an in-process MCP server for the brains' tools (`ToolDefinition`). */
  createSdkMcpServer(config: { name: string; version?: string; tools: unknown[] }): unknown;
  /** `inputShape` is a zod raw shape (see `json-schema-to-zod.ts`). */
  tool(name: string, description: string, inputShape: unknown, handler: SdkToolHandler): unknown;
}

/** Loads the real SDK. Kept in one place so the import is easy to find and easy to mock. */
export async function loadSdk(): Promise<SdkSurface> {
  const mod = (await import('@anthropic-ai/claude-agent-sdk')) as unknown as {
    query: SdkSurface['query'];
    createSdkMcpServer: SdkSurface['createSdkMcpServer'];
    tool: (
      name: string,
      description: string,
      schema: unknown,
      handler: (args: Record<string, unknown>) => Promise<unknown>,
    ) => unknown;
  };
  return {
    query: (params) => mod.query(params),
    createSdkMcpServer: (config) => mod.createSdkMcpServer(config),
    tool: (name, description, inputShape, handler) =>
      mod.tool(name, description, inputShape, handler),
  };
}
