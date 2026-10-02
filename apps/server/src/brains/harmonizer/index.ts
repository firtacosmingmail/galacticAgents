import type { Agent, AgentRuntime, Id } from '@galactic/protocol';
import type { BrainDefinition } from '../definition.js';
import type { BrainPlacement, BrainRunner, BrainRunnerOptions } from '../runner.js';
import { SUPERVISOR_TOOLS } from './agent-tools.js';
import { HARMONIZER_SYSTEM_PROMPT } from './prompt.js';
import { harmonizerTools, type HarmonizerDeps } from './tools.js';

/**
 * The Harmonizer brain (P2-08; SPEC §2.1, TECHNOLOGY §5): the system prompt and the tool set
 * against `DomainCommands`, plus the server's boot-time start (the Harmonizer starts with the
 * application and is idle otherwise; SPEC decision 32: one at a time).
 */

export { HARMONIZER_SYSTEM_PROMPT } from './prompt.js';
export {
  harmonizerTools,
  defaultStewardPrompt,
  hintKind,
  nameFrom,
  SCRATCH_DIR,
  type HarmonizerDeps,
  type HarmonizerRequest,
} from './tools.js';
export { SUPERVISOR_TOOLS, statusReport } from './agent-tools.js';
export { findRelated, words, type RelatedMatch } from './related.js';

/** The Harmonizer's definition: its prompt, its own tools, then the supervisor tools. */
export function harmonizerBrain(deps: HarmonizerDeps): BrainDefinition {
  return {
    role: 'harmonizer',
    systemPrompt: HARMONIZER_SYSTEM_PROMPT,
    tools: [...harmonizerTools(deps), ...SUPERVISOR_TOOLS],
  };
}

/** What the boot-time start needs from the composed runtime. */
export interface HarmonizerHost {
  runtime: { liveAgents(): Agent[] };
  startBrain(
    definition: BrainDefinition,
    placement: BrainPlacement,
    opts?: Pick<BrainRunnerOptions, 'coalesceMs' | 'reset'>,
  ): Promise<BrainRunner>;
}

export interface StartHarmonizerOptions {
  runtime: AgentRuntime;
  /** The Harmonizer's working directory (it has no project; SPEC decision 24). */
  cwd: string;
  deps: HarmonizerDeps;
  runner?: Pick<BrainRunnerOptions, 'coalesceMs' | 'reset'>;
}

export type StartHarmonizerResult =
  | { status: 'started'; agentId: Id; runner: BrainRunner }
  /** One already runs (resumed by startup recovery, say): no second one (decision 32). */
  | { status: 'running'; agentId: Id };

/**
 * Starts the Harmonizer unless one already runs. Called once at boot, after `recover()`: an
 * interrupted Harmonizer that recovery resumed is left alone (P2-16 gives it back its runner);
 * one that could not be resumed has ended, and a fresh one replaces it.
 */
export async function startHarmonizer(
  host: HarmonizerHost,
  opts: StartHarmonizerOptions,
): Promise<StartHarmonizerResult> {
  const live = host.runtime.liveAgents().find((a) => a.role === 'harmonizer');
  if (live) return { status: 'running', agentId: live.id };
  const runner = await host.startBrain(
    harmonizerBrain(opts.deps),
    { runtime: opts.runtime, cwd: opts.cwd },
    opts.runner ?? {},
  );
  return { status: 'started', agentId: runner.agentId, runner };
}
