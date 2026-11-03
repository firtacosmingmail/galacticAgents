import type { z } from 'zod';
import type {
  Agent,
  DomainCommands,
  HarnessJobRunBody,
  HarnessJobRunResponse,
  HarnessJobTickResponse,
  Id,
  SpawnOptions,
} from '@galactic/protocol';
import type { FakeScenario, FakeTurnIO } from '../adapters/fake/scenario.js';
import type { Tables } from '../db/tables.js';
import { DomainError, must } from '../domain/errors.js';
import type { EventLog } from '../domain/event-log.js';
import { jobOf, writeJob } from '../domain/jobs.js';
import type { JobScheduler } from './job-scheduler.js';

/**
 * The scene harness's recurring-job hooks (P10-08, development only; `/dev/harness/jobs/*`). A job
 * runs on its schedule, at most once a minute (`JOB_TICK_MS`), and its run's Steward decides by
 * itself what it reports: neither can be watched in a browser test. Here a test makes a job's next
 * run start **now**, through the real scheduler (the same run row, prompt, Steward spawn and end
 * as a scheduled run), with the run's Steward on the fake runtime following a script — its
 * findings through `report_finding`, its spend through `request_spend`, then `report_run` — and
 * can tick the scheduler once (a follow-up run after an approved send starts on the next tick).
 *
 * The script reaches the fake runtime through `FakeAdapter`'s `scenarioFor`, which the server sets
 * only in development mode; a run started without one echoes its prompt and ends `quiet`.
 */
/** A run's script, as the route parsed it. */
export type JobRunScript = z.output<typeof HarnessJobRunBody>;

export interface HarnessJobs {
  run(jobId: Id, script: JobRunScript): Promise<HarnessJobRunResponse>;
  tick(): Promise<HarnessJobTickResponse>;
}

/** The run scripts waiting for their Steward's spawn, by the job's hidden task. */
export class HarnessJobScripts {
  private tables: Tables | undefined;
  private readonly scripts = new Map<Id, FakeScenario>();

  /** The tables the spawned agent is looked up in (they exist only once the runtime is composed). */
  attach(tables: Tables): void {
    this.tables = tables;
  }

  set(taskId: Id, scenario: FakeScenario): void {
    this.scripts.set(taskId, scenario);
  }

  has(taskId: Id): boolean {
    return this.scripts.has(taskId);
  }

  delete(taskId: Id): void {
    this.scripts.delete(taskId);
  }

  /** `FakeAdapter`'s `scenarioFor`: a Steward of a task with a waiting script takes it, once. */
  scenarioFor(opts: SpawnOptions): { name: string; scenario: FakeScenario } | undefined {
    if (opts.role !== 'steward' || !this.tables) return undefined;
    const taskId = this.tables.agents.get(opts.agentId)?.taskId;
    const scenario = taskId ? this.scripts.get(taskId) : undefined;
    if (!taskId || !scenario) return undefined;
    this.scripts.delete(taskId);
    return { name: 'harness-job-run', scenario };
  }
}

/** A reply finding of a script (Phase 10's kind, which `report_finding` no longer offers). */
type ReplyFinding = JobRunScript['findings'][number];

/**
 * The run Steward's one turn: each finding, the spend, then the run's report. A `reply` finding is
 * Phase 10's kind, which `report_finding` no longer offers (P11-06: replies are publish requests);
 * the harness still opens one through `openReply` — a "Send" finding already waiting, which the
 * user answers the old way — or, without it, reports it like any finding (and is refused).
 */
export function jobRunScript(
  body: JobRunScript,
  openReply?: (finding: ReplyFinding) => Promise<void>,
): FakeScenario {
  const findings = body.findings;
  const summary =
    body.summary ??
    (findings.length > 0
      ? `Found ${findings.length} thing${findings.length === 1 ? '' : 's'} worth a look.`
      : 'Nothing new.');
  const call = async (io: FakeTurnIO, name: string, input: unknown) => {
    const result = await io.toolCall(name, input);
    if (result.status === 'denied') io.output(`${name} was denied: ${result.reason}`);
  };
  return {
    steps: [
      {
        kind: 'script',
        run: async (io) => {
          for (const finding of findings) {
            if (finding.kind === 'reply' && openReply) await openReply(finding);
            else await call(io, 'report_finding', finding);
          }
          if (body.spend) await call(io, 'request_spend', body.spend);
          await call(io, 'report_run', {
            outcome: findings.length > 0 ? 'findings' : 'quiet',
            summary,
          });
        },
      },
      { kind: 'output', text: summary },
    ],
  };
}

export function harnessJobs(opts: {
  log: EventLog;
  scheduler: JobScheduler;
  scripts: HarnessJobScripts;
  /** Opens a script's legacy reply findings (P11-06); absent: they go through `report_finding`. */
  commands?: Pick<DomainCommands, 'openFinding'>;
}): HarnessJobs {
  const { log, scheduler, scripts, commands } = opts;
  /** A legacy reply finding of the job's running run, from its Steward (the newest on its task). */
  const openReply =
    (jobId: Id) =>
    async (finding: ReplyFinding): Promise<void> => {
      const job = must(log.tables.jobs.get(jobId), 'job', jobId);
      const steward = log.tables.agents
        .all()
        .filter((a) => a.role === 'steward' && a.taskId === job.taskId)
        .reduce<Agent | undefined>((b, a) => (!b || a.createdAt >= b.createdAt ? a : b), undefined);
      if (!commands || !job.runningRunId || !steward) return;
      await commands.openFinding({
        runId: job.runningRunId,
        originAgentId: steward.id,
        kind: 'reply',
        title: finding.title,
        text: finding.text,
        ...(finding.draft !== undefined ? { draft: finding.draft } : {}),
      });
    };
  return {
    async run(jobId, body) {
      const job = must(log.tables.jobs.get(jobId), 'job', jobId);
      if (job.state !== 'active') {
        throw new DomainError('conflict', `job ${job.name} is ${job.state}: it does not run`);
      }
      if (job.runningRunId) {
        throw new DomainError('conflict', `job ${job.name} has a run going on`);
      }
      const before = job.lastRun?.runId;
      scripts.set(job.taskId, jobRunScript(body, commands ? openReply(jobId) : undefined));
      // Due now: the scheduler starts it as it would a run whose time has come.
      log.runCommand((ctx) =>
        writeJob(ctx, jobOf(ctx, jobId), { nextRunAt: new Date(log.clock()).toISOString() }),
      );
      await scheduler.tick();
      // The spawn happened inside the tick: a Steward took the script then. Any script left (no
      // run, or a run the caps cut short before its Steward) is dropped, so a later catch-up
      // Steward of the job never picks it up.
      scripts.delete(job.taskId);
      const after = log.tables.jobs.get(jobId);
      const runId = after?.runningRunId ?? after?.lastRun?.runId;
      if (!runId || runId === before) {
        throw new DomainError('conflict', `job ${job.name} did not start a run (a cap is full?)`);
      }
      return { seq: log.currentSeq(), runId };
    },

    async tick() {
      const report = await scheduler.tick();
      return { seq: log.currentSeq(), ...report };
    },
  };
}
