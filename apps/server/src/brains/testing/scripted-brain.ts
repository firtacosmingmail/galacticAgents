import type { SpawnOptions } from '@galactic/protocol';
import { FakeAdapter, type FakeAdapterOptions } from '../../adapters/fake/fake-adapter.js';
import type { FakeStep } from '../../adapters/fake/scenario.js';

/**
 * The minimal scripted fake "LLM" for brains (P2-06; P2-07 grows it into the full harness). A
 * script maps a turn prompt to the steps the brain performs: tool calls of its own tools (whose
 * handlers run in the server, as with the SDK), output, `idle`. The fake adapter runs brains
 * (any role but `steward`) from the script and everyone else from the usual `scenario:` prompts.
 *
 * Every call is recorded in `prompts`, so a test can assert what each turn saw.
 */

export interface ScriptedTurn {
  /** 0 for a session's spawn prompt, then 1, 2, … for each later turn of that session. */
  n: number;
  prompt: string;
  agentId: string;
}

export type BrainScript = (turn: ScriptedTurn) => FakeStep[];

export interface ScriptedBrains {
  adapter: FakeAdapter;
  /** Every turn prompt a brain received, in order. */
  prompts: ScriptedTurn[];
}

/** A step that calls one of the brain's tools. */
export const callTool = (toolName: string, input: unknown = {}): FakeStep => ({
  kind: 'tool_call',
  toolName,
  input,
});

export function scriptedBrains(
  script: BrainScript,
  opts: Omit<FakeAdapterOptions, 'scenarioFor'> = {},
): ScriptedBrains {
  const prompts: ScriptedTurn[] = [];
  const run = (turn: ScriptedTurn) => {
    prompts.push(turn);
    return script(turn);
  };
  const adapter = new FakeAdapter({
    speed: 0,
    ...opts,
    scenarioFor: (spawn: SpawnOptions) =>
      spawn.role === 'steward'
        ? undefined
        : {
            name: 'scripted-brain',
            scenario: {
              steps: run({ n: 0, prompt: spawn.prompt, agentId: spawn.agentId }),
              onMessage: (message, n) => run({ n, prompt: message, agentId: spawn.agentId }),
            },
          },
  });
  return { adapter, prompts };
}
