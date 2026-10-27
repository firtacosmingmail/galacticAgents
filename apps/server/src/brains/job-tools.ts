import {
  jobIdOfTask,
  type Agent,
  type DomainCommands,
  type Id,
  type JobRunReport,
  type ToolDefinition,
} from '@galactic/protocol';
import type { Tables } from '../db/tables.js';
import { DomainError } from '../domain/errors.js';
import type { EventLog } from '../domain/event-log.js';
import { formatAmount } from '../domain/findings.js';
import type { AgentRuntime } from '../runtime/agent-runtime.js';
import { guarded } from './deliverable-tools.js';

/**
 * A Steward's job and spend tools (P10-05, plan Task 9; SPEC decisions 144, 145), handed to the
 * runtimes that serve the server's tools alongside the deliverable tools
 * (`AgentRuntime.setStewardTools`, registered by the composition):
 *
 * - every Steward: `request_spend` — real money is always the user's explicit approval. A task
 *   Steward hears the answer as one system message (`SpendRelay`); a job-run Steward's spend is
 *   job-owned and a later run carries it out once approved.
 * - a job-run Steward (its task is a job's hidden task and the job has a run going) also gets
 *   `report_finding` (a job-owned question with the finding's fixed actions) and `report_run`
 *   (kept on the run as `meta.report`, which the scheduler's turn-end handler ends the run with,
 *   ledger ruling R3).
 *
 * The brains never get `request_spend`: `requestSpend` accepts any agent, so this scoping is the
 * guard. Every refusal is the tool's result (`{error, message}`), never a crash.
 */

export const JOB_TOOL_NAMES = ['report_finding', 'report_run'] as const;
export const SPEND_TOOL_NAME = 'request_spend';

const asInput = (raw: unknown): Record<string, unknown> =>
  raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};

const optString = (raw: Record<string, unknown>, key: string): string | undefined => {
  const v = raw[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new DomainError('invalid', `${key} must be a string`);
  return v;
};

/** The job whose hidden task `agent` works on, when it has a run going. */
function runningJobOf(tables: Tables, agent: Pick<Agent, 'taskId'>) {
  const task = agent.taskId ? tables.tasks.get(agent.taskId) : undefined;
  const jobId = task ? jobIdOfTask(task) : undefined;
  const job = jobId ? tables.jobs.get(jobId) : undefined;
  return job?.runningRunId ? job : undefined;
}

/** The run the Steward reports on: its job's running run (the domain checks it is the Steward's). */
function currentRunId(tables: Tables, agent: Pick<Agent, 'taskId'>): Id {
  const runId = runningJobOf(tables, agent)?.runningRunId;
  if (!runId) throw new DomainError('invalid', 'your run has ended; nothing more is reported');
  return runId;
}

/**
 * The tools of a Steward: `request_spend` for every Steward, plus `report_finding` and
 * `report_run` for a job-run Steward (its task is a job task and the job has a run going).
 */
export function stewardJobTools(
  commands: DomainCommands,
  tables: Tables,
  agent: Pick<Agent, 'id' | 'taskId'>,
): ToolDefinition[] {
  const jobRun = runningJobOf(tables, agent) !== undefined;
  const spend: ToolDefinition = {
    name: SPEND_TOOL_NAME,
    description:
      'Asks Cosmin to approve spending real money (a paid API, a purchase, an ad, a ' +
      'subscription). Call it before anything that costs money and then end your turn: never ' +
      'spend without an approval. Only Cosmin answers it (Approve or Refuse). ' +
      (jobRun
        ? 'A later run carries out an approved spend; this run does not spend.'
        : 'The answer comes to you as a message.'),
    inputSchema: {
      type: 'object',
      properties: {
        amount: { type: 'number', exclusiveMinimum: 0, description: 'How much, e.g. 20.' },
        currency: {
          type: 'string',
          minLength: 3,
          maxLength: 3,
          description: 'Three-letter currency code (default USD).',
        },
        purpose: { type: 'string', description: 'What the money is for (plain text).' },
      },
      required: ['amount', 'purpose'],
      additionalProperties: false,
    },
    handler: (raw) =>
      guarded(async () => {
        const input = asInput(raw);
        const currency = optString(input, 'currency');
        const question = (
          await commands.requestSpend({
            originAgentId: agent.id,
            amount: typeof input['amount'] === 'number' ? input['amount'] : Number.NaN,
            purpose: optString(input, 'purpose') ?? '',
            ...(currency !== undefined ? { currency } : {}),
          })
        ).value;
        return {
          questionId: question.id,
          note: jobRun
            ? 'Asked Cosmin. End your turn now; a later run spends it if he approves. Do not spend it in this run.'
            : 'Asked Cosmin. End your turn now; his answer comes to you as a message. Do not spend before he approves.',
        };
      }),
  };
  if (!jobRun) return [spend];

  const reportFinding: ToolDefinition = {
    name: 'report_finding',
    description:
      'Reports one finding of this run to Cosmin: a suggestion (a feature or improvement worth ' +
      'building) or a reply (a drafted answer worth sending, with the draft). He decides what ' +
      'happens to it; nothing is sent or built by reporting it. At most 20 per run.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['suggestion', 'reply'] },
        title: { type: 'string', description: 'A short name for it (at most 200 characters).' },
        text: { type: 'string', description: 'What you found and why it matters (plain text).' },
        draft: { type: 'string', description: 'For a reply: the drafted reply, exactly.' },
      },
      required: ['kind', 'title', 'text'],
      additionalProperties: false,
    },
    handler: (raw) =>
      guarded(async () => {
        const input = asInput(raw);
        const kind = input['kind'];
        if (kind !== 'suggestion' && kind !== 'reply') {
          throw new DomainError('invalid', 'kind is suggestion or reply');
        }
        const draft = optString(input, 'draft');
        const question = (
          await commands.openFinding({
            runId: currentRunId(tables, agent),
            originAgentId: agent.id,
            kind,
            title: optString(input, 'title') ?? '',
            text: optString(input, 'text') ?? '',
            ...(draft !== undefined ? { draft } : {}),
          })
        ).value;
        return { questionId: question.id };
      }),
  };

  const reportRun: ToolDefinition = {
    name: 'report_run',
    description:
      "Ends this run's report: the outcome (quiet: nothing worth bringing up; findings: you " +
      'reported findings with report_finding; failed: the run could not do its job, with the ' +
      'reason), a short summary the next run reads, and any numbers worth keeping (at most 30, ' +
      'names up to 60 characters). Call it last, then end your turn. A later call replaces it.',
    inputSchema: {
      type: 'object',
      properties: {
        outcome: { type: 'string', enum: ['quiet', 'findings', 'failed'] },
        summary: { type: 'string', description: 'What this run did and found (plain text).' },
        numbers: {
          type: 'object',
          additionalProperties: { type: 'number' },
          description: 'Named numbers, e.g. {"new reviews": 4}.',
        },
        failureReason: { type: 'string', description: 'For failed: why it failed.' },
      },
      required: ['outcome', 'summary'],
      additionalProperties: false,
    },
    handler: (raw) =>
      guarded(async () => {
        const input = asInput(raw);
        const failureReason = optString(input, 'failureReason');
        const numbers = input['numbers'];
        if (
          numbers !== undefined &&
          (numbers === null || typeof numbers !== 'object' || Array.isArray(numbers))
        ) {
          throw new DomainError('invalid', 'numbers maps names to numbers');
        }
        const report = {
          outcome: input['outcome'] as JobRunReport['outcome'],
          summary: optString(input, 'summary') ?? '',
          ...(numbers !== undefined ? { numbers: numbers as Record<string, number> } : {}),
          ...(failureReason !== undefined ? { failureReason } : {}),
        };
        const run = (
          await commands.reportJobRun({
            runId: currentRunId(tables, agent),
            agentId: agent.id,
            report,
          })
        ).value;
        return {
          runId: run.id,
          outcome: report.outcome,
          note: 'Report kept. End your turn now: the run ends with it.',
        };
      }),
  };

  return [spend, reportFinding, reportRun];
}

/** What `SpendRelay` needs of the runtime. */
export type SpendRelayRuntime = Pick<AgentRuntime, 'send' | 'liveAgents'>;

/**
 * Sends a task Steward the answer to its spend (SPEC decision 145): on `question.answered` for a
 * `spend` question that is not a job's, one system message to the asker — "Spend approval for
 * <amount> (<purpose>): approved" or "…: refused". A job spend sends nothing (a later run carries
 * an approved one out); a Steward that has ended is skipped silently.
 */
export class SpendRelay {
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly opts: {
      log: Pick<EventLog, 'subscribe' | 'tables'>;
      runtime: SpendRelayRuntime;
      onError?: (e: unknown, context: string) => void;
    },
  ) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.opts.log.subscribe(({ event }) => {
      if (event.type !== 'question.answered') return;
      try {
        this.relay(event.questionId);
      } catch (error) {
        this.opts.onError?.(error, 'spend relay');
      }
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private relay(questionId: Id): void {
    const q = this.opts.log.tables.questions.get(questionId);
    const spend = q?.context.spend;
    if (!q || q.kind !== 'spend' || !spend || spend.jobId !== undefined) return;
    if (q.status !== 'answered') return;
    const { runtime } = this.opts;
    if (!runtime.liveAgents().some((a) => a.id === q.originAgentId)) return;
    const verdict = q.answer === 'Approve' ? 'approved' : 'refused';
    runtime.send(
      q.originAgentId,
      `Spend approval for ${formatAmount(spend.amount, spend.currency)} (${spend.purpose}): ${verdict}`,
      { sender: { type: 'system' } },
    );
  }
}
