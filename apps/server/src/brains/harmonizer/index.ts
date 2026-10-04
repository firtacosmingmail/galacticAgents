import type { Actor, Agent, AgentRuntime, Id } from '@galactic/protocol';
import type { BrainDefinition } from '../definition.js';
import { STEWARD_TOOLS } from '../steward-tools.js';
import type { BrainPlacement, BrainRunner, BrainRunnerOptions } from '../runner.js';
import { SUPERVISOR_TOOLS } from './agent-tools.js';
import { CLOSURE_TOOLS, harmonizerStartNotes } from './closure-tools.js';
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
export {
  CLOSURE_TOOLS,
  closureNotes,
  harmonizerStartNotes,
  strandedQuestionNotes,
} from './closure-tools.js';
export { findRelated, words, type RelatedMatch } from './related.js';

/** The Harmonizer's definition: its prompt, its own tools, the closure tools (P2-13), then the supervisor tools. */
export function harmonizerBrain(deps: HarmonizerDeps): BrainDefinition {
  return {
    role: 'harmonizer',
    systemPrompt: HARMONIZER_SYSTEM_PROMPT,
    tools: [...harmonizerTools(deps), ...CLOSURE_TOOLS, ...SUPERVISOR_TOOLS, ...STEWARD_TOOLS],
    // Closure requests recorded while no Harmonizer could relay them (P2-16).
    startNotes: harmonizerStartNotes,
  };
}

/** What the boot-time start needs from the composed runtime. */
export interface HarmonizerHost {
  runtime: { liveAgents(): Agent[]; stop(agentId: Id, by: Actor): Promise<void> };
  /** The runner of a running brain (P2-16). */
  runnerOf?(agentId: Id): BrainRunner | undefined;
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
  /**
   * Lines for the first turn of the Harmonizer this call starts, before its own start notes (P5-06:
   * "the user restarted you"). Ignored when one already runs.
   */
  notes?: string[];
}

export type StartHarmonizerResult =
  /** `replaced`: a Harmonizer on another runtime was stopped to make way for this one. */
  | { status: 'started'; agentId: Id; runner: BrainRunner; replaced?: Id }
  /**
   * One already runs (resumed by startup recovery, say): no second one (decision 32). `runner` is
   * its runner when the host drives it (P2-16: recovery resumes it as a brain).
   */
  | { status: 'running'; agentId: Id; runner?: BrainRunner };

/**
 * Starts the Harmonizer unless one already runs. Called once at boot, after `recover()`: an
 * interrupted Harmonizer that recovery resumed (through its runner, P2-16) is left running; one
 * that could not be resumed stays interrupted, and a fresh one replaces it.
 */
export async function startHarmonizer(
  host: HarmonizerHost,
  opts: StartHarmonizerOptions,
): Promise<StartHarmonizerResult> {
  const live = host.runtime.liveAgents().find((a) => a.role === 'harmonizer');
  if (live && live.runtime === opts.runtime) {
    const runner = host.runnerOf?.(live.id);
    return { status: 'running', agentId: live.id, ...(runner ? { runner } : {}) };
  }
  // One on another runtime (a fake one from an earlier dev run that recovery brought back) gives
  // way: stopped by the system, it is not resumed again, and one Harmonizer runs (decision 32).
  if (live) await host.runtime.stop(live.id, { type: 'system' });
  const definition = harmonizerBrain(opts.deps);
  const notes = opts.notes ?? [];
  if (notes.length > 0) {
    // Once: the first session's first turn (a later session's start notes are its own).
    let pending = notes;
    const own = definition.startNotes;
    definition.startNotes = async (ctx) => {
      const first = pending;
      pending = [];
      return [...first, ...((await own?.(ctx)) ?? [])];
    };
  }
  const runner = await host.startBrain(
    definition,
    { runtime: opts.runtime, cwd: opts.cwd },
    opts.runner ?? {},
  );
  return {
    status: 'started',
    agentId: runner.agentId,
    runner,
    ...(live ? { replaced: live.id } : {}),
  };
}

/**
 * Which runtime the boot-time Harmonizer uses (`GALACTIC_HARMONIZER`): unset means real Claude
 * (`claude-sdk`), in dev mode too (2026-10-02: `pnpm dev` starts with a real Harmonizer); `fake`
 * picks the fake adapter (no Claude needed); `off` (or `0`) starts none.
 */
export function harmonizerRuntime(setting: string | undefined): AgentRuntime | undefined {
  const value = setting?.trim().toLowerCase();
  if (value === 'off' || value === '0' || value === 'false') return undefined;
  if (value === 'fake' || value === 'claude-sdk') return value;
  return 'claude-sdk';
}
