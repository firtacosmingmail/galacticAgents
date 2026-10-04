import {
  isHarnessMeta,
  type Actor,
  type Agent,
  type AgentRuntime,
  type Id,
  type Question,
} from '@galactic/protocol';
import { closureRequestOf } from '../../domain/closure.js';
import { DomainError } from '../../domain/errors.js';
import { COMMAND_SOURCE } from '../../domain/questions.js';
import type { BrainQueries } from '../definition.js';
import { startHarmonizer, type HarmonizerHost, type StartHarmonizerOptions } from './index.js';

/**
 * The panel's "Restart Harmonizer" (P5-06; SPEC decision 82): the running Harmonizer is stopped
 * as the user's stop and a fresh one starts on the same runtime through `startHarmonizer`, seeded
 * from the database like a brain whose session was lost (decision 44). Its questions follow
 * decision 45: the user questions the old one asked through a tool (`ask_user`,
 * `ask_confirmation`) are withdrawn and the new one is told what was asked, so it asks again if
 * it still matters; a closure question ("Anything else?") is cancelled with the stop and the new
 * one relays the closure request again (`closureNotes`). The questions it held (a Waykeeper's,
 * escalated to it) move on as on any stop (P2-03). Its first turn says the user restarted it.
 * One Harmonizer at a time: a second restart while one is under way is refused.
 */

const USER: Actor = { type: 'user' };

export interface RestartHarmonizerHost extends HarmonizerHost {
  commands: {
    withdrawQuestion(questionId: Id, reason: string, by: Actor): Promise<unknown>;
  };
  queries: Pick<BrainQueries, 'agents' | 'allOpenQuestions' | 'projects'>;
}

export interface RestartHarmonizerOptions extends Omit<StartHarmonizerOptions, 'runtime'> {
  /** The runtime when no Harmonizer ever ran (the boot setting); else the last one's. */
  defaultRuntime?: AgentRuntime;
}

export interface RestartHarmonizerResult {
  agentId: Id;
  /** The Harmonizer that was stopped (absent when none ran). */
  replaced?: Id;
}

/** Restarts the Harmonizer; see the module comment. Throws `DomainError` when it cannot. */
export function harmonizerRestarter(
  host: RestartHarmonizerHost,
  opts: RestartHarmonizerOptions,
): () => Promise<RestartHarmonizerResult> {
  let underWay = false;
  return async () => {
    if (underWay) throw new DomainError('conflict', 'a restart of the Harmonizer is under way');
    underWay = true;
    try {
      return await restart(host, opts);
    } finally {
      underWay = false;
    }
  };
}

async function restart(
  host: RestartHarmonizerHost,
  opts: RestartHarmonizerOptions,
): Promise<RestartHarmonizerResult> {
  // The scene harness's dormant stand-in (decision 79) is never the Harmonizer.
  const real = (a: Agent) => a.role === 'harmonizer' && !isHarnessMeta(a.meta);
  const live = host.runtime.liveAgents().find(real);
  const last = live ?? newest(host.queries.agents().filter(real));
  const runtime = last?.runtime ?? opts.defaultRuntime;
  if (!runtime) {
    throw new DomainError('invalid', 'no Harmonizer runtime is configured (GALACTIC_HARMONIZER)');
  }
  const cwd = (last?.meta as { cwd?: unknown } | undefined)?.cwd;
  const notes: string[] = [];
  if (live) {
    // Its runner stops driving it first: the withdrawals below must not wake it for a turn.
    host.runnerOf?.(live.id)?.dispose();
    notes.push(...(await withdrawAsked(host, live.id)));
    await host.runtime.stop(live.id, USER);
  }
  const intro =
    'the user restarted the Harmonizer from the panel' +
    (live ? `: the previous one (${live.id}) was stopped` : '') +
    ' and you are a fresh one, seeded from the database. Tell the user in one line that the ' +
    'Harmonizer was restarted and is ready' +
    (notes.length > 0 ? ', then ask again what still matters (below).' : '.');
  const started = await startHarmonizer(host, {
    ...opts,
    runtime,
    cwd: typeof cwd === 'string' ? cwd : opts.cwd,
    notes: [intro, ...notes, ...(opts.notes ?? [])],
  });
  return { agentId: started.agentId, ...(live ? { replaced: live.id } : {}) };
}

/**
 * Withdraws the user questions `harmonizerId` asked through a tool, except closure questions
 * (relayed again by `closureNotes`); returns a line per question for the new Harmonizer.
 */
async function withdrawAsked(host: RestartHarmonizerHost, harmonizerId: Id): Promise<string[]> {
  const closure = new Set(
    host.queries
      .projects()
      .map((p) => closureRequestOf(p)?.questionId)
      .filter((id): id is Id => id !== undefined),
  );
  const asked = host.queries
    .allOpenQuestions()
    .filter(
      (q: Question) =>
        q.originAgentId === harmonizerId &&
        q.kind === 'clarification' &&
        q.meta?.['source'] === COMMAND_SOURCE &&
        !closure.has(q.id),
    );
  const lines: string[] = [];
  for (const q of asked) {
    try {
      await host.commands.withdrawQuestion(
        q.id,
        'the user restarted the Harmonizer; the new one asks again if it still matters',
        { type: 'system' },
      );
    } catch {
      continue; // answered or withdrawn meanwhile
    }
    lines.push(
      `the previous Harmonizer had asked the user ${JSON.stringify(q.context.text)} (${q.id}); ` +
        'the question was withdrawn with the restart — ask again (ask_user, ask_confirmation) ' +
        'if it still matters.',
    );
  }
  return lines;
}

function newest(agents: Agent[]): Agent | undefined {
  return [...agents].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).at(0);
}
