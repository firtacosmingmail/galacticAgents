import type { z } from 'zod';
import type {
  AgentAdapter,
  HarnessAdvanceResponse,
  HarnessStewardScriptBody,
  Id,
  ModelInfo,
  ProviderUsage,
} from '@galactic/protocol';
import { FakeAdapter, type FakeAdapterOptions } from '../adapters/fake/fake-adapter.js';
import type { FakeScenario } from '../adapters/fake/scenario.js';
import { must } from '../domain/errors.js';
import type { EventLog } from '../domain/event-log.js';
import type { HarnessJobScripts } from './harness-jobs.js';
import type { UsageLimits } from './usage-limits.js';

/**
 * The dev harness's provider hooks (P11-10, development only): Stewards on ChatGPT and Gemini
 * without either CLI, and a usage-limit wait whose reset a test can reach.
 *
 *   - **Fake providers** (ruling R4): `devProviderFakes()` are `FakeAdapter`s registered as the
 *     `codex` and `agy` runtimes, reporting what the real adapters would — model lists (Gemini's
 *     can make images, ChatGPT's cannot), a usage window per quota, ChatGPT can publish and Gemini
 *     cannot. `replaceAdapters` puts them in the adapter list in place of any real adapter of the
 *     same runtime, with a log line, so a machine that has `codex` or `agy` installed (and maybe
 *     signed out) behaves the same as one that has neither.
 *   - **Steward scripts**: the next Steward spawned for a task follows a script — a publish
 *     request (it then waits for the answer) or a stop at its usage limit — through the same
 *     `scenarioFor` hook the recurring-job scripts use (`HarnessJobScripts`).
 *   - **The clock** the usage-limit waits are checked against (`HarnessClock`): a test moves it
 *     forward instead of waiting for a reset an hour away.
 */

/** A clock a test can move forward; starts at the real time. */
export class HarnessClock {
  private offsetMs = 0;

  now = (): number => Date.now() + this.offsetMs;

  iso(): string {
    return new Date(this.now()).toISOString();
  }

  advance(ms: number): void {
    this.offsetMs += ms;
  }
}

/** A Steward script, as the route parsed it. */
export type StewardScript = z.output<typeof HarnessStewardScriptBody>;

/**
 * The Steward's one turn: a publish request (`request_publish`, then it waits for the answer, which
 * the server relays to it as a message), or work that stops at the provider's usage limit.
 */
export function stewardScript(body: StewardScript, clock: HarnessClock): FakeScenario {
  if (body.publish) {
    const publish = body.publish;
    return {
      steps: [
        {
          kind: 'script',
          run: async (io) => {
            const result = await io.toolCall('request_publish', publish);
            if (result.status === 'denied')
              io.output(`request_publish was denied: ${result.reason}`);
          },
        },
        { kind: 'idle' },
      ],
    };
  }
  if (body.limit) {
    const resetsAt = new Date(clock.now() + body.limit.resetsInMs).toISOString();
    return {
      steps: [
        { kind: 'output', text: 'Working on it.' },
        { kind: 'fail', error: 'usage limit reached', reason: 'limit', resetsAt },
      ],
    };
  }
  return { steps: [{ kind: 'output', text: 'Nothing to do.' }] };
}

export interface HarnessStewards {
  /** The next Steward of the task follows the script (once). */
  script(taskId: Id, body: StewardScript): { seq: number };
  /** Moves the usage-limit clock forward, then checks the waits once. */
  advanceLimits(ms: number): Promise<HarnessAdvanceResponse>;
}

export function harnessStewards(opts: {
  log: EventLog;
  scripts: HarnessJobScripts;
  clock: HarnessClock;
  limits: Pick<UsageLimits, 'tick'>;
}): HarnessStewards {
  const { log, scripts, clock, limits } = opts;
  return {
    script(taskId, body) {
      must(log.tables.tasks.get(taskId), 'task', taskId);
      scripts.set(taskId, stewardScript(body, clock));
      return { seq: log.currentSeq() };
    },
    async advanceLimits(ms) {
      clock.advance(ms);
      await limits.tick();
      return { seq: log.currentSeq(), now: clock.iso() };
    },
  };
}

/** The runtimes `devProviderFakes` stand in for: a Steward's override never replaces them. */
export const DEV_PROVIDER_RUNTIMES = ['codex', 'agy'] as const;

const model = (
  id: string,
  label: string,
  family: ModelInfo['family'],
  capabilities: ModelInfo['capabilities'],
  isDefault = false,
): ModelInfo => ({ id, label, family, capabilities, isDefault });

const usage = (plan: string, windows: ProviderUsage['windows']): ProviderUsage => ({
  plan,
  windows,
});

/**
 * Fakes standing in for the Codex and Antigravity adapters: ChatGPT publishes but makes no images;
 * Gemini makes images (its own models and a Claude model through Antigravity) but never publishes.
 * Antigravity's two quota buckets are reported apart, as the real adapter does, with room left in
 * both (a limit is a Steward's `agent.failed`, not a usage report).
 */
export function devProviderFakes(scenarioFor: FakeAdapterOptions['scenarioFor']): FakeAdapter[] {
  return [
    new FakeAdapter({
      runtime: 'codex',
      canPublish: true,
      models: [model('gpt-5.6-terra', 'GPT 5.6 terra', 'gpt', ['text'], true)],
      usage: usage('Plus', [{ label: '5 hours', remainingFraction: 0.8 }]),
      ...(scenarioFor ? { scenarioFor } : {}),
    }),
    new FakeAdapter({
      runtime: 'agy',
      canPublish: false,
      models: [
        model('gemini-3.8-flash', 'Gemini 3.8 Flash', 'gemini', ['text', 'image'], true),
        model('claude-sonnet-5', 'Claude Sonnet 5', 'claude', ['text', 'image']),
      ],
      usage: usage('Pro', [
        { label: 'Gemini Models', remainingFraction: 0.2 },
        { label: 'Claude and GPT models', remainingFraction: 0.6 },
      ]),
      ...(scenarioFor ? { scenarioFor } : {}),
    }),
  ];
}

/**
 * Puts `fakes` in `adapters`, each in the place of the adapter of its runtime (the real Codex or
 * Antigravity one), or at the end when there is none; one log line per replacement.
 */
export function replaceAdapters(
  adapters: AgentAdapter[],
  fakes: AgentAdapter[],
  log: (message: string) => void,
): void {
  for (const fake of fakes) {
    const at = adapters.findIndex((a) => a.runtime === fake.runtime);
    if (at >= 0) {
      adapters[at] = fake;
      log(`[dev] a fake adapter replaces the ${fake.runtime} runtime (development harness)`);
    } else {
      adapters.push(fake);
      log(`[dev] a fake adapter registers as the ${fake.runtime} runtime (development harness)`);
    }
  }
}
