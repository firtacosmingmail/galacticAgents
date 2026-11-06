import { z } from 'zod';
import type { ToolCall } from './domain.js';
import type { Agent } from './domain.js';
import type { AgentRuntime } from './enums.js';
import { Id } from './primitives.js';

/**
 * Launch flags (P12; design 2026-11-05-steward-launch-flags): the catalogued CLI flags a Steward
 * may be started with. Only entries here can be requested; a flag that changes permissions or
 * tool configuration is never catalogued.
 */
export const LaunchFlag = z.enum(['chrome']);
export type LaunchFlag = z.infer<typeof LaunchFlag>;

export interface LaunchFlagSpec {
  /** The CLI flag as the user would type it. */
  cli: string;
  /** What the flag lets the Steward do, in the user's words. */
  label: string;
  /** Runtimes that can carry the flag. */
  runtimes: readonly AgentRuntime[];
  /** Tool-name prefixes of the tools the flag adds (confirmed by the P12-01 spike). */
  toolPrefixes: readonly string[];
}

export const LAUNCH_FLAGS: Record<LaunchFlag, LaunchFlagSpec> = {
  chrome: {
    cli: '--chrome',
    label: 'controls your Chrome browser',
    runtimes: ['claude-sdk'],
    toolPrefixes: ['mcp__claude-in-chrome__'],
  },
};

/** The flag (among `flags`) that owns `toolName`, if any. */
export function flagOfTool(flags: readonly LaunchFlag[], toolName: string): LaunchFlag | undefined {
  return flags.find((flag) =>
    LAUNCH_FLAGS[flag].toolPrefixes.some((prefix) => toolName.startsWith(prefix)),
  );
}

/** The command the user approves, e.g. `claude --chrome`. */
export function launchCommand(flags: readonly LaunchFlag[]): string {
  return ['claude', ...flags.map((flag) => LAUNCH_FLAGS[flag].cli)].join(' ');
}

/** The flags `runtime` cannot carry. */
export function unsupportedFlags(
  flags: readonly LaunchFlag[],
  runtime: AgentRuntime,
): LaunchFlag[] {
  return flags.filter((flag) => !LAUNCH_FLAGS[flag].runtimes.includes(runtime));
}

/** Each flag at most once. */
const uniqueFlags = (flags: readonly LaunchFlag[]) => new Set(flags).size === flags.length;
const UNIQUE = { message: 'a flag is named more than once' };

/** A Waykeeper's request to start a Steward with flags. */
export const LaunchRequest = z.object({
  flags: z.array(LaunchFlag).min(1).max(4).refine(uniqueFlags, UNIQUE),
  reason: z.string().min(1).max(2000),
  expectedUse: z.string().min(1).max(2000),
  check: z.string().min(1).max(2000),
});
export type LaunchRequest = z.infer<typeof LaunchRequest>;

/** What a `launch` question shows: the request plus the exact command, cwd and instructions. */
export const LaunchContext = LaunchRequest.extend({
  taskId: Id,
  command: z.string(),
  cwd: z.string(),
  instructions: z.string().min(1),
});
export type LaunchContext = z.infer<typeof LaunchContext>;

export const LAUNCH_ACTIONS = ['Approve and start', 'Start without flags', 'Deny'] as const;

/** What an off-script question shows: the flag, what was approved and why the judge objected. */
export const OffScriptContext = z.object({
  flag: LaunchFlag,
  expectedUse: z.string(),
  precedents: z.array(z.string()),
  judgeReason: z.string(),
});
export type OffScriptContext = z.infer<typeof OffScriptContext>;

export const OFF_SCRIPT_ACTIONS = ['Approve and continue', 'Stop the Steward'] as const;

/** A Steward's approved launch, kept in `agent.meta.launch`. */
export const AgentLaunch = z.object({
  flags: z.array(LaunchFlag).min(1).refine(uniqueFlags, UNIQUE),
  expectedUse: z.string(),
  check: z.string(),
  approvalId: Id,
  precedents: z.array(z.string()),
});
export type AgentLaunch = z.infer<typeof AgentLaunch>;

/** Parses `agent.meta.launch`; undefined when absent or invalid. */
export function launchOf(agent: Pick<Agent, 'meta'>): AgentLaunch | undefined {
  const parsed = AgentLaunch.safeParse(agent.meta?.['launch']);
  return parsed.success ? parsed.data : undefined;
}

export interface ScopeJudgeInput {
  flag: LaunchFlag;
  expectedUse: string;
  precedents: readonly string[];
  /** Already redacted. */
  toolCall: ToolCall;
}

export interface ScopeVerdict {
  verdict: 'consistent' | 'off_script';
  reason: string;
}

/** Decides whether a flag-tool call fits the approved use. Implementations fail closed. */
export interface ScopeJudge {
  judge(input: ScopeJudgeInput, signal: AbortSignal): Promise<ScopeVerdict>;
}
