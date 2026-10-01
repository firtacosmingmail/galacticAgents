import type { BrainDefinition, BrainTool, BrainToolContext } from '../definition.js';

/**
 * Canned pieces for brain tests (P2-07): a one-line tool builder, a definition builder and a
 * minimal Harmonizer to sit at the top of the hierarchy (a Waykeeper needs a supervisor), plus a
 * latch to hold a tool handler mid-turn.
 */

export interface ToolOptions {
  description?: string;
  inputSchema?: Record<string, unknown>;
  endsTurn?: boolean;
}

/** A brain tool from a name and a handler; schema and description default to permissive stubs. */
export function tool(
  name: string,
  handler: (input: unknown, ctx: BrainToolContext) => Promise<unknown> | unknown,
  opts: ToolOptions = {},
): BrainTool {
  return {
    name,
    description: opts.description ?? name,
    inputSchema: opts.inputSchema ?? { type: 'object' },
    ...(opts.endsTurn !== undefined ? { endsTurn: opts.endsTurn } : {}),
    handler: async (input, ctx) => handler(input, ctx),
  };
}

export function brainDefinition(
  role: BrainDefinition['role'],
  tools: BrainTool[] = [],
  opts: Partial<Omit<BrainDefinition, 'role' | 'tools'>> = {},
): BrainDefinition {
  return {
    role,
    systemPrompt: opts.systemPrompt ?? `You are the ${role} of a test.`,
    tools,
    ...(opts.wakeRules ? { wakeRules: opts.wakeRules } : {}),
  };
}

/** A Harmonizer with the given tools (none by default): the supervisor a test Waykeeper needs. */
export const harmonizerDefinition = (tools: BrainTool[] = []): BrainDefinition =>
  brainDefinition('harmonizer', tools, { systemPrompt: 'You are the Harmonizer of a test.' });

/** A promise the test resolves by hand, e.g. to hold a tool handler (and so the turn) open. */
export function latch(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}
