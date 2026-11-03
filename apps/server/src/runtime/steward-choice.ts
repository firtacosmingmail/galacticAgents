import {
  PROVIDER_RUNTIME,
  type AgentRuntime,
  type Job,
  type Project,
  type Provider,
  type Task,
} from '@galactic/protocol';

/**
 * Which provider, runtime and model a new Steward runs on (P11-03, SPEC decision 146; TECHNOLOGY
 * §3.5). One resolver for the four Steward spawn sites — the Waykeeper's and the Harmonizer's
 * `spawn_steward`, the job scheduler and `DomainCommands.spawnAgent` — so they never disagree.
 * The Harmonizer and the Waykeepers are not chosen here: brains always run on `claude-sdk`.
 */

export interface StewardChoice {
  provider: Provider;
  runtime: AgentRuntime;
  /** The exact model; absent: the CLI's own default model. */
  model?: string;
}

export interface StewardChoiceInput {
  task?: Partial<Pick<Task, 'provider' | 'model'>>;
  job?: Partial<Pick<Job, 'provider' | 'model' | 'followUpProvider' | 'followUpModel'>>;
  /** The run carries an approved follow-up (a send, a spend, a publish): its own provider first. */
  followUp?: boolean;
  project?: Partial<Pick<Project, 'defaultProvider'>>;
  /** The Settings' `defaultProvider`. */
  defaultProvider?: Provider;
  /** A provider's default model (Settings `providers.<p>.model`); `undefined`: the CLI's own. */
  defaultModel: (provider: Provider) => string | undefined;
}

interface Layer {
  provider?: Provider | undefined;
  model?: string | undefined;
}

/**
 * Precedence: the follow-up's `followUpProvider`/`followUpModel` (when `followUp`) → the task →
 * the job → the project's `defaultProvider` → the Settings' `defaultProvider` → `claude`. The
 * first layer that names a provider decides; its model, else the provider's default model.
 */
export function resolveStewardChoice(input: StewardChoiceInput): StewardChoice {
  const { job } = input;
  const followUp: Layer | undefined =
    input.followUp && job && (job.followUpProvider || job.followUpModel)
      ? { provider: job.followUpProvider ?? job.provider, model: job.followUpModel }
      : undefined;
  const layers: Layer[] = [
    ...(followUp ? [followUp] : []),
    input.task ?? {},
    job ?? {},
    { provider: input.project?.defaultProvider },
    { provider: input.defaultProvider },
  ];
  const chosen = layers.find((l) => l.provider !== undefined);
  const provider = chosen?.provider ?? 'claude';
  const model = chosen?.model ?? input.defaultModel(provider);
  return { provider, runtime: PROVIDER_RUNTIME[provider], ...(model ? { model } : {}) };
}

/** The provider whose Stewards run on `runtime`; `undefined` for `fake`, `acp` and `pty`. */
export function providerOf(runtime: AgentRuntime): Provider | undefined {
  return (Object.keys(PROVIDER_RUNTIME) as Provider[]).find((p) => PROVIDER_RUNTIME[p] === runtime);
}

/** The settings the resolver reads at every spawn. */
export interface StewardDefaults {
  defaultProvider?: Provider | undefined;
  providers?: Partial<Record<Provider, { model?: string | undefined }>> | undefined;
}

export interface StewardChooserOptions {
  /** The Settings now (`defaultProvider`, `providers.<p>.model`); absent: none. */
  defaults?: () => StewardDefaults;
  /**
   * Development and tests only (`GALACTIC_STEWARD_RUNTIME`): the runtime of every new Steward,
   * whatever its provider — usually `fake`.
   */
  override?: () => AgentRuntime | undefined;
  /**
   * Runtimes the override never replaces (P11-10, the dev harness): fakes registered as `codex`
   * and `agy` stand in for ChatGPT's and Gemini's own runtimes, so a Steward on one of them keeps
   * it while every other Steward still goes to the override.
   */
  overrideKeeps?: () => readonly AgentRuntime[];
}

export type ChooseSteward = (
  input: Omit<StewardChoiceInput, 'defaultProvider' | 'defaultModel'> & {
    /** The runtime of the brain spawning it (a job run: its project's Waykeeper). */
    supervisorRuntime?: AgentRuntime | undefined;
  },
) => StewardChoice;

/**
 * The resolver over the live settings, as the spawn sites call it. Two development rules on top:
 * the override decides the runtime, and a brain on the fake runtime (the dev harness, tests) keeps
 * its `claude` Stewards on the fake runtime too — in production brains run on `claude-sdk`, so
 * that rule never changes anything there.
 */
export function stewardChooser(opts: StewardChooserOptions = {}): ChooseSteward {
  return ({ supervisorRuntime, ...input }) => {
    const settings = opts.defaults?.() ?? {};
    const choice = resolveStewardChoice({
      ...input,
      ...(settings.defaultProvider ? { defaultProvider: settings.defaultProvider } : {}),
      defaultModel: (p) => settings.providers?.[p]?.model,
    });
    const override = opts.override?.();
    if (override && !opts.overrideKeeps?.().includes(choice.runtime)) {
      return { ...choice, runtime: override };
    }
    if (supervisorRuntime === 'fake' && choice.provider === 'claude') {
      return { ...choice, runtime: 'fake' };
    }
    return choice;
  };
}
