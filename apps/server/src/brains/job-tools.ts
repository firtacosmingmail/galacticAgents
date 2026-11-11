import {
  answerDetailOf,
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
import type { PublishAllowanceStore } from '../runtime/publish-allowance.js';
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
 * - every Steward: `request_publish` (P11-06, decision 147) — nothing goes out without the user's
 *   approval of that exact content. A task Steward asks only on a publishing step and hears the
 *   answer as one system message (`PublishRelay`, which also arms its one-shot allowance); a
 *   job-run Steward's publish is job-owned and a later run carries it out once approved. Phase
 *   10's reply findings are publish requests now: `report_finding` offers suggestions only.
 *
 * The brains never get `request_spend`: `requestSpend` accepts any agent, so this scoping is the
 * guard (`requestPublish` refuses any asker but a Steward). Every refusal is the tool's result
 * (`{error, message}`), never a crash.
 */

export const JOB_TOOL_NAMES = ['report_finding', 'report_run'] as const;
export const SPEND_TOOL_NAME = 'request_spend';
export const PUBLISH_TOOL_NAME = 'request_publish';

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

/** The `report_run` fields that make up a run's `data`. */
const RUN_DATA_FIELDS = [
  'tables',
  'lists',
  'calendars',
  'statuses',
  'texts',
  'sourceProblems',
] as const;

/**
 * The tools of a Steward: `request_spend` for every Steward, plus `report_finding` and
 * `report_run` for a job-run Steward (its task is a job task and the job has a run going).
 */
export function stewardJobTools(
  commands: DomainCommands,
  tables: Tables,
  agent: Pick<Agent, 'id' | 'taskId'>,
): ToolDefinition[] {
  const running = runningJobOf(tables, agent);
  const jobRun = running !== undefined;
  // A follow-up run that carries out an approved spend must not ask for it again (final review I4).
  const approvedSpend =
    running?.runningRunId !== undefined &&
    tables.jobRuns.get(running.runningRunId)?.followUp?.kind === 'spend';
  const spend: ToolDefinition = {
    name: SPEND_TOOL_NAME,
    description:
      'Asks Cosmin to approve spending real money (a paid API, a purchase, an ad, a ' +
      'subscription). Call it before anything that costs money and then end your turn: never ' +
      'spend without an approval. Only Cosmin answers it (Approve or Refuse). ' +
      (approvedSpend
        ? 'The spend this run was started for is already approved: never ask for it again. Use ' +
          'this only for any other spend, which a later run carries out once approved.'
        : jobRun
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
  // A follow-up run that publishes an approved request must not ask for it again.
  const approvedPublish =
    running?.runningRunId !== undefined &&
    tables.jobRuns.get(running.runningRunId)?.followUp?.kind === 'publish';
  const publish: ToolDefinition = {
    name: PUBLISH_TOOL_NAME,
    description:
      'Asks Cosmin to approve publishing something in his name: a post, a reply, a review answer, ' +
      'a message, an upload — anything that goes out to a platform. Give the platform, the account ' +
      'and the exact text, and the files (paths in your working directory) that go with it. Call ' +
      'it before publishing and then end your turn: never publish without an approval. Only ' +
      'Cosmin answers it (Approve, possibly after editing the text, or Refuse); the approval is ' +
      'for exactly that content. ' +
      (approvedPublish
        ? 'The publish this run was started for is already approved: never ask for it again.'
        : jobRun
          ? 'A later run publishes an approved request; this run publishes nothing.'
          : 'The answer comes to you as a message; then publish exactly what was approved.'),
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', description: 'Where it goes, e.g. "Instagram", "App Store".' },
        account: { type: 'string', description: 'The account it goes out as, e.g. "@myshop".' },
        text: { type: 'string', description: 'The exact text to publish.' },
        files: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 10,
          description: 'Files that go with it (images…), as paths in your working directory.',
        },
      },
      required: ['platform', 'account', 'text'],
      additionalProperties: false,
    },
    handler: (raw) =>
      guarded(async () => {
        const input = asInput(raw);
        const files = input['files'];
        if (
          files !== undefined &&
          (!Array.isArray(files) || files.some((f) => typeof f !== 'string'))
        ) {
          throw new DomainError('invalid', 'files is a list of paths');
        }
        const { questionId } = (
          await commands.requestPublish({
            originAgentId: agent.id,
            platform: optString(input, 'platform') ?? '',
            account: optString(input, 'account') ?? '',
            text: optString(input, 'text') ?? '',
            ...(files !== undefined ? { files: files as string[] } : {}),
          })
        ).value;
        return {
          questionId,
          note: jobRun
            ? 'Asked Cosmin. End your turn now; a later run publishes it if he approves. Do not publish it in this run.'
            : 'Asked Cosmin. End your turn now; his answer comes to you as a message. Do not publish before he approves.',
        };
      }),
  };
  if (!jobRun) return [spend, publish];

  const reportFinding: ToolDefinition = {
    name: 'report_finding',
    description:
      'Reports one finding of this run to Cosmin: a suggestion (a feature or improvement worth ' +
      'building). He decides what happens to it; nothing is built by reporting it. A reply worth ' +
      'sending is not a finding: ask with request_publish. At most 20 per run.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['suggestion'] },
        title: { type: 'string', description: 'A short name for it (at most 200 characters).' },
        text: { type: 'string', description: 'What you found and why it matters (plain text).' },
      },
      required: ['kind', 'title', 'text'],
      additionalProperties: false,
    },
    handler: (raw) =>
      guarded(async () => {
        const input = asInput(raw);
        const kind = input['kind'];
        // Phase 10's reply findings became publish approvals (P11-06, decision 147).
        if (kind === 'reply') {
          throw new DomainError(
            'invalid',
            'a reply is not a finding: ask to publish it with request_publish (platform, account, text)',
          );
        }
        if (kind !== 'suggestion') throw new DomainError('invalid', 'kind is suggestion');
        const question = (
          await commands.openFinding({
            runId: currentRunId(tables, agent),
            originAgentId: agent.id,
            kind,
            title: optString(input, 'title') ?? '',
            text: optString(input, 'text') ?? '',
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
      'names up to 60 characters). It also carries the data the dashboard shows: tables ' +
      '(at most 10, 12 columns, 200 rows), lists (10 of 100 items), calendars (5 of 200 entries), ' +
      'statuses (5 boards of 200 items) and texts (5 of 4000 characters), each under a name of ' +
      'lowercase letters, digits and underscores, plus sourceProblems for a source you could not ' +
      'read. All of it together stays under 256 KiB; a report over a limit is refused and you can ' +
      'report again. Call it last, then end your turn. A later call replaces it.',
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
        tables: {
          type: 'object',
          description:
            'Named tables: {"experiments": {"columns": ["Test", "Result"], "rows": [["Short video", "+18%"]]}}. ' +
            'Every row has one cell per column; a cell is text, a number or null.',
          additionalProperties: {
            type: 'object',
            properties: {
              columns: { type: 'array', items: { type: 'string' } },
              rows: { type: 'array', items: { type: 'array' } },
            },
            required: ['columns', 'rows'],
          },
        },
        lists: {
          type: 'object',
          description:
            'Named lists of {title, detail?, tag?, at?}: {"to_reply": [{"title": "Ana asked about prices"}]}.',
          additionalProperties: { type: 'array', items: { type: 'object' } },
        },
        calendars: {
          type: 'object',
          description:
            'Named calendars of {date: "YYYY-MM-DD", title, detail?}: {"deadlines": [{"date": "2026-11-20", "title": "Invoice"}]}.',
          additionalProperties: { type: 'array', items: { type: 'object' } },
        },
        statuses: {
          type: 'object',
          description:
            'Named status boards of {column, title, detail?}: {"pipeline": [{"column": "open", "title": "Fix the cart"}]}.',
          additionalProperties: { type: 'array', items: { type: 'object' } },
        },
        texts: {
          type: 'object',
          description: 'Named texts: {"summary": "…"}.',
          additionalProperties: { type: 'string' },
        },
        sourceProblems: {
          type: 'array',
          description: 'Sources you could not read: [{"sourceId": "crm", "problem": "timed out"}].',
          items: { type: 'object' },
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
        // The run data's fields sit next to `numbers` in the call and are kept together as `data`
        // (checked against the protocol's `RunData` by `reportJobRun`).
        const dataEntries = RUN_DATA_FIELDS.filter((f) => input[f] !== undefined).map(
          (f) => [f, input[f]] as const,
        );
        const report = {
          outcome: input['outcome'] as JobRunReport['outcome'],
          summary: optString(input, 'summary') ?? '',
          ...(numbers !== undefined ? { numbers: numbers as Record<string, number> } : {}),
          ...(dataEntries.length > 0
            ? { data: Object.fromEntries(dataEntries) as NonNullable<JobRunReport['data']> }
            : {}),
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

  return [spend, publish, reportFinding, reportRun];
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

/** What `PublishRelay` needs of the runtime. */
export type PublishRelayRuntime = Pick<AgentRuntime, 'send' | 'liveAgents'>;

/**
 * Sends a task Steward the answer to its publish request (P11-06, SPEC decision 147): on
 * `question.answered` for a `publish` question that is not a job's, one system message to the
 * asker — "Publish approval for <platform>: approved" (followed by the approved text when the
 * answer carried one: Cosmin may have edited it) or "…: refused" — and, on "Approve", arms the asker's one-shot allowance first, so its next
 * network call goes through once while the approved files are unchanged. A job publish sends
 * nothing (a later run carries an approved one out); a Steward that has ended is skipped silently.
 */
export class PublishRelay {
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly opts: {
      log: Pick<EventLog, 'subscribe' | 'tables'>;
      runtime: PublishRelayRuntime;
      allowances: Pick<PublishAllowanceStore, 'arm'>;
      /** The asker's folder, which the approved files are read from. */
      worktreeOf: (agentId: Id) => string;
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
        this.opts.onError?.(error, 'publish relay');
      }
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private relay(questionId: Id): void {
    const q = this.opts.log.tables.questions.get(questionId);
    const publish = q?.context.publish;
    if (!q || q.kind !== 'publish' || !publish || publish.jobId !== undefined) return;
    if (q.status !== 'answered') return;
    const { runtime } = this.opts;
    if (!runtime.liveAgents().some((a) => a.id === q.originAgentId)) return;
    const approved = q.answer === 'Approve';
    if (approved) {
      this.opts.allowances.arm(q.originAgentId, publish, this.opts.worktreeOf(q.originAgentId));
    }
    // Approved through the card's text box (possibly edited): the text to publish, verbatim.
    const withText = approved && answerDetailOf(q)?.text !== undefined;
    runtime.send(
      q.originAgentId,
      `Publish approval for ${publish.platform}: ${approved ? 'approved' : 'refused'}` +
        (withText ? `. Publish exactly this text:\n${publish.text}` : ''),
      { sender: { type: 'system' } },
    );
  }
}
