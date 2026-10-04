import type { Actor, Agent, AgentRuntime, Id, Question } from '@galactic/protocol';
import { closureRequestOf } from '../../domain/closure.js';
import { DomainError } from '../../domain/errors.js';
import { COMMAND_SOURCE } from '../../domain/questions.js';
import type { BrainQueries } from '../definition.js';
import {
  isRealHarmonizer,
  startHarmonizerLocked,
  withHarmonizerLock,
  type HarmonizerHost,
  type StartHarmonizerOptions,
} from './index.js';

/**
 * The panel's "Restart Harmonizer" (P5-06; SPEC decision 82): the running Harmonizer is stopped
 * as the user's stop and a fresh one starts on the same runtime through `startHarmonizer`, seeded
 * from the database like a brain whose session was lost (decision 44). Its questions follow
 * decision 45: the stop ends the user questions the old one asked through a tool (`ask_user`,
 * `ask_confirmation`) and the new one is told what was asked, so it asks again if it still
 * matters; a closure question ("Anything else?") ends with the stop too and the new one relays
 * the closure request again (`closureNotes`). The questions it held (a Waykeeper's, escalated to
 * it) move on as on any stop (P2-03); an interrupted one's move on once the new one runs
 * (`releaseInterruptedHarmonizers`). Its first turn says the user restarted it.
 *
 * One Harmonizer at a time: the whole sequence holds the Harmonizer lock (`withHarmonizerLock`,
 * shared with boot and `keepHarmonizer`); a second restart while one is under way, or while an
 * interrupted Harmonizer is on its way back, is refused. At most `maxRestarts` per `windowMs`
 * (default 3 in 10 min, as `keepHarmonizer`): each restart pays a fresh seeded turn.
 *
 * Failures (P5-06 review): the old one is stopped first and nothing else happens unless it ended,
 * so a failed stop leaves it running and driven; a failed start after the stop falls back once to
 * the boot runtime (what `keepHarmonizer` would start), logged, so the user is not left without a
 * Harmonizer.
 */

const USER: Actor = { type: 'user' };
const DEFAULT_MAX_RESTARTS = 3;
const DEFAULT_WINDOW_MS = 10 * 60_000;

export interface RestartHarmonizerHost extends HarmonizerHost {
  commands: {
    withdrawQuestion(questionId: Id, reason: string, by: Actor): Promise<unknown>;
  };
  queries: Pick<BrainQueries, 'agents' | 'allOpenQuestions' | 'projects' | 'question'>;
}

export interface RestartHarmonizerOptions extends Omit<StartHarmonizerOptions, 'runtime'> {
  /** The runtime when no Harmonizer ever ran (the boot setting); else the last one's. */
  defaultRuntime?: AgentRuntime;
  /** Restarts allowed in `windowMs` (default 3 in 10 min). */
  maxRestarts?: number;
  windowMs?: number;
  now?: () => number;
  /** Where a failed start that was retried is reported (the server's log). */
  onError?: (error: unknown, context: string) => void;
}

export interface RestartHarmonizerResult {
  agentId: Id;
  /** The Harmonizer that was stopped (absent when none ran). */
  replaced?: Id;
}

/** Too many restarts in the window: the reply says when the next one is allowed (HTTP 429). */
export class RestartLimitError extends DomainError {
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super('conflict', message);
  }
}

/** Restarts the Harmonizer; see the module comment. Throws `DomainError` when it refuses. */
export function harmonizerRestarter(
  host: RestartHarmonizerHost,
  opts: RestartHarmonizerOptions,
): () => Promise<RestartHarmonizerResult> {
  let underWay = false;
  const maxRestarts = opts.maxRestarts ?? DEFAULT_MAX_RESTARTS;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const now = opts.now ?? Date.now;
  const restarts: number[] = [];
  return async () => {
    if (underWay) throw new DomainError('conflict', 'a restart of the Harmonizer is under way');
    const at = now();
    while (restarts.length > 0 && at - restarts[0]! >= windowMs) restarts.shift();
    if (restarts.length >= maxRestarts) {
      const wait = restarts[0]! + windowMs - at;
      throw new RestartLimitError(
        `the Harmonizer was restarted ${restarts.length} times in the last ` +
          `${formatMs(windowMs)}; try again in ${formatMs(wait)}`,
        wait,
      );
    }
    const comingBack = host.queries
      .agents()
      .find((a) => isRealHarmonizer(a) && host.runtime.isReserved?.(a.id) === true);
    if (comingBack) {
      throw new DomainError(
        'conflict',
        `the Harmonizer ${comingBack.id} is being resumed; try again when it is back`,
      );
    }
    underWay = true;
    try {
      restarts.push(at);
      return await withHarmonizerLock(host, () => restart(host, opts));
    } finally {
      underWay = false;
    }
  };
}

async function restart(
  host: RestartHarmonizerHost,
  opts: RestartHarmonizerOptions,
): Promise<RestartHarmonizerResult> {
  const live = host.runtime.liveAgents().find(isRealHarmonizer);
  const last = live ?? newest(host.queries.agents().filter(isRealHarmonizer));
  const runtime = last?.runtime ?? opts.defaultRuntime;
  if (!runtime) {
    throw new DomainError('invalid', 'no Harmonizer runtime is configured (GALACTIC_HARMONIZER)');
  }
  const cwd = (last?.meta as { cwd?: unknown } | undefined)?.cwd;
  const notes: string[] = [];
  if (live) {
    // Stop first, nothing else before: a stop that fails leaves it running and driven by its
    // runner. The stop ends the questions it asked (decision 45); the new one is told about them.
    const asked = askedBy(host, live.id);
    await host.runtime.stop(live.id, USER);
    if (host.runtime.liveAgents().some((a) => a.id === live.id)) {
      throw new Error(`the Harmonizer ${live.id} did not stop; it keeps running`);
    }
    notes.push(...(await toldAgain(host, asked)));
  }
  // None running: the last one ended (interrupted, failed, stopped from the ops console).
  const ended = live ? undefined : last;
  const intro =
    'the user restarted the Harmonizer from the panel' +
    (live ? `: the previous one (${live.id}) was stopped` : '') +
    (ended ? `: the previous one (${ended.id}) had ended` : '') +
    ' and you are a fresh one, seeded from the database. Tell the user in one line that the ' +
    'Harmonizer was restarted and is ready' +
    (notes.length > 0 ? ', then ask again what still matters (below).' : '.');
  const start = (on: AgentRuntime, lines: string[]) =>
    startHarmonizerLocked(host, {
      ...opts,
      runtime: on,
      cwd: typeof cwd === 'string' ? cwd : opts.cwd,
      notes: [...lines, ...notes, ...(opts.notes ?? [])],
    });
  let started;
  try {
    started = await start(runtime, [intro]);
  } catch (error) {
    // Once, as `keepHarmonizer` would: the boot runtime, so the user keeps a Harmonizer.
    opts.onError?.(error, 'restart harmonizer: start (falling back to the boot runtime)');
    const fallback = opts.defaultRuntime ?? runtime;
    started = await start(fallback, [
      intro.replace(
        'the user restarted the Harmonizer from the panel',
        `the user restarted the Harmonizer from the panel; the start on ${runtime} failed ` +
          `(${(error as Error).message}) and you were started on ${fallback} instead`,
      ),
    ]);
  }
  return { agentId: started.agentId, ...(live ? { replaced: live.id } : {}) };
}

/**
 * The user questions `harmonizerId` asked through a tool, except closure questions (relayed again
 * by `closureNotes`).
 */
function askedBy(host: RestartHarmonizerHost, harmonizerId: Id): Question[] {
  const closure = new Set(
    host.queries
      .projects()
      .map((p) => closureRequestOf(p)?.questionId)
      .filter((id): id is Id => id !== undefined),
  );
  return host.queries
    .allOpenQuestions()
    .filter(
      (q: Question) =>
        q.originAgentId === harmonizerId &&
        q.kind === 'clarification' &&
        q.meta?.['source'] === COMMAND_SOURCE &&
        !closure.has(q.id),
    );
}

/**
 * After the stop: a question still open (the stop normally ends them) is withdrawn as the user —
 * the user's restart is what ends it; one answered meanwhile is left alone. Returns a line per
 * question that ended unanswered, for the new Harmonizer.
 */
async function toldAgain(host: RestartHarmonizerHost, asked: Question[]): Promise<string[]> {
  const lines: string[] = [];
  for (const q of asked) {
    if (host.queries.question(q.id)?.status === 'open') {
      try {
        await host.commands.withdrawQuestion(
          q.id,
          'the user restarted the Harmonizer; the new one asks again if it still matters',
          USER,
        );
      } catch {
        // answered or withdrawn meanwhile: looked at below
      }
    }
    const now = host.queries.question(q.id)?.status;
    if (now === 'answered' || now === 'open') continue;
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

function formatMs(ms: number): string {
  if (ms >= 60_000) return `${Math.ceil(ms / 60_000)} min`;
  return `${Math.max(Math.ceil(ms / 1_000), 1)} s`;
}
