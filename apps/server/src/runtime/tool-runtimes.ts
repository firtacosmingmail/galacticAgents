import type { AgentRuntime } from '@galactic/protocol';

/**
 * The runtimes whose sessions serve the server's own tools (`SpawnOptions.tools`, TECHNOLOGY
 * §3.1): the Claude Agent SDK through its in-process MCP server, the fake runtime (tests, dev
 * mode), and Codex and Antigravity (P11-03; their adapters serve them from P11-04/P11-05: Codex
 * as dynamic tools, agy through Mission Control's tool server). The ACP adapter refuses `tools` (§3.2, decision 108 keeps its sessions isolated) and a
 * terminal agent has none (§3.3), so their Stewards list their deliverables in their "Done:"
 * report instead (P9-04, decision 120).
 */
export const TOOL_RUNTIMES: ReadonlySet<AgentRuntime> = new Set<AgentRuntime>([
  'claude-sdk',
  'fake',
  'codex',
  'agy',
]);

/** Whether a Steward on `runtime` declares its deliverables itself (else it lists them in its report). */
export const stewardDeclares = (runtime: AgentRuntime | undefined): boolean =>
  runtime === undefined || TOOL_RUNTIMES.has(runtime);
