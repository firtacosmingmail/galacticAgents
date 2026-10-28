import {
  PermissionAction,
  PermissionRuleScope,
  proposalJobOf,
  scheduleText,
  type Area,
  type Id,
  type Job,
  type JobDraft,
  type JobRun,
  type Proposal,
} from '@galactic/protocol';
import { DomainError } from '../../domain/errors.js';
import type { BrainTool, BrainToolContext } from '../definition.js';
import { projectOf } from './tools.js';

/**
 * The Waykeeper's recurring-job tools (P10-06; SPEC decision 144): it sets up, changes and stops
 * the jobs of its long-term project's areas through ONE card each (`proposeJob`, checked like the
 * command its approval runs, before the card exists), and reads their state and history. Jobs on
 * an ordinary project are refused by the domain.
 */

/** The most runs `read_job_runs` returns. */
export const MAX_RUNS_READ = 50;
const DEFAULT_RUNS_READ = 10;

type Input = Record<string, unknown>;
const asInput = (input: unknown): Input =>
  input && typeof input === 'object' ? (input as Input) : {};

function str(input: Input, key: string): string {
  const v = input[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new DomainError('invalid', `${key} must be a non-empty string`);
  }
  return v;
}
function optStr(input: Input, key: string): string | undefined {
  const v = input[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new DomainError('invalid', `${key} must be a string`);
  return v;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const CLOCK = {
  type: 'string',
  pattern: '^([01]\\d|2[0-3]):[0-5]\\d$',
  description: 'HH:MM, 24-hour, local time.',
};

const SCHEDULE_SCHEMA = {
  description:
    'When it runs, in the Mac’s local time: {kind:"daily",at}, {kind:"weekdays",at} (Mon–Fri), ' +
    '{kind:"weekly",days:[1–7, 1=Monday],at} or {kind:"monthly",day:1–31,at} (past the month’s end: its last day).',
  oneOf: [
    obj({ kind: { const: 'daily' }, at: CLOCK }, ['kind', 'at']),
    obj({ kind: { const: 'weekdays' }, at: CLOCK }, ['kind', 'at']),
    obj(
      {
        kind: { const: 'weekly' },
        days: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 7 }, minItems: 1 },
        at: CLOCK,
      },
      ['kind', 'days', 'at'],
    ),
    obj(
      { kind: { const: 'monthly' }, day: { type: 'integer', minimum: 1, maximum: 31 }, at: CLOCK },
      ['kind', 'day', 'at'],
    ),
  ],
};

const RULES_SCHEMA = {
  type: 'array',
  maxItems: 10,
  description:
    'What every run may do without asking, on top of the project’s rules. Shaped like an ' +
    '"Allow similar" rule: exact {scope:"exact", match:{kind:"text"}}; a command prefix ' +
    '{scope:"prefix", tool:"Bash", match:{kind:"words"}} (never a shell or interpreter); a ' +
    'folder {scope:"prefix", tool:"Read" or "Write", match:{kind:"folder"}} (an absolute path, ' +
    'never / or the home folder); whole categories {scope:"category", tool:"*"}. Never a push, ' +
    'never a spend, never a prefix or category outside the workspace. The card shows each rule ' +
    'in the server’s words, computed from what it matches.',
  items: obj(
    {
      tool: {
        type: 'string',
        description: 'The tool (Bash, WebFetch, Read, …), or * for categories.',
      },
      scope: { enum: PermissionRuleScope.options },
      match: {
        description:
          '{kind:"text",text} exact subject, {kind:"words",words} command prefix, ' +
          '{kind:"folder",folder} files under a path, or {kind:"categories"}.',
        type: 'object',
      },
      categories: { type: 'array', items: { enum: PermissionAction.options } },
    },
    ['tool', 'scope', 'match', 'categories'],
  ),
};

const DRAFT_PROPERTIES = {
  name: { type: 'string', description: 'A short name (1–80 characters).' },
  instructions: {
    type: 'string',
    description:
      'What each run does: what to look at, where the data lives, what to report. Never a key or ' +
      'password: those stay in the project’s environment.',
  },
  schedule: SCHEDULE_SCHEMA,
  provider: { type: 'string', description: 'The AI provider (default claude).' },
  unattendedRules: RULES_SCHEMA,
};

/** A job of the brain's project, or the refusal. */
function jobOfProject(ctx: BrainToolContext, jobId: Id): Job {
  const project = projectOf(ctx);
  const job = ctx.queries.jobs(project.id).find((j) => j.id === jobId);
  if (!job) throw new DomainError('not_found', `no job ${jobId} in your project ${project.id}`);
  return job;
}

/** The card as the model reads it back: what the user is asked to approve. */
function cardResult(p: Proposal) {
  const card = proposalJobOf(p);
  const brief = (d: JobDraft | undefined) =>
    d && {
      name: d.name,
      schedule: scheduleText(d.schedule),
      provider: d.provider,
      instructions: d.instructions,
      unattendedRules: d.unattendedRules.map((r) => r.label),
    };
  return {
    proposalId: p.id,
    state: p.state,
    ...(card?.before ? { before: brief(card.before.draft) } : {}),
    ...(card?.draft ? { after: brief(card.draft) } : {}),
    note: 'The card is with Cosmin. End your turn now; his decision arrives as an event.',
  };
}

const rationaleOf = (input: Input) => {
  const rationale = optStr(input, 'rationale');
  return rationale ? { rationale } : {};
};

// -- propose_job -----------------------------------------------------------------------------------

export const proposeJobTool: BrainTool = {
  name: 'propose_job',
  description:
    'Proposes ONE recurring job for an area of your long-term project, as one card Cosmin ' +
    'approves or rejects (name, area moon, schedule, instructions, provider, what it may do ' +
    'unattended). Checked before the card exists: refused on an ordinary project, for a push ' +
    'rule, for anything that looks like a secret, or for a full area. Ends your turn.',
  inputSchema: obj(
    {
      area: {
        type: 'string',
        description: 'An existing area’s id or name, or the name of a new area (1–60 characters).',
      },
      ...DRAFT_PROPERTIES,
      rationale: { type: 'string', description: 'Why, in a sentence.' },
    },
    ['area', 'name', 'instructions', 'schedule'],
  ),
  endsTurn: true,
  handler: async (raw, ctx) => {
    const input = asInput(raw);
    const project = projectOf(ctx);
    const areaText = str(input, 'area').trim();
    const known = ctx.queries.areas(project.id).find((a: Area) => a.id === areaText);
    const provider = optStr(input, 'provider');
    const { value } = await ctx.commands.proposeJob({
      projectId: project.id,
      waykeeperId: ctx.brainId,
      action: 'create',
      area: known ? { areaId: known.id } : { name: areaText },
      draft: {
        name: str(input, 'name'),
        instructions: str(input, 'instructions'),
        schedule: input['schedule'] as JobDraft['schedule'],
        provider: provider ?? 'claude',
        unattendedRules: (input['unattendedRules'] ?? []) as JobDraft['unattendedRules'],
      },
      ...rationaleOf(input),
    });
    return cardResult(value);
  },
};

// -- propose_job_change ----------------------------------------------------------------------------

export const proposeJobChangeTool: BrainTool = {
  name: 'propose_job_change',
  description:
    'Proposes a change to one recurring job as one card showing it before → after: its name, ' +
    'instructions, schedule, provider, unattended rules (the whole new list), or its area ' +
    '(areaId of another existing area). Checked like a new job. Ends your turn.',
  inputSchema: obj(
    {
      jobId: { type: 'string' },
      changes: obj({ ...DRAFT_PROPERTIES, areaId: { type: 'string' } }),
      rationale: { type: 'string', description: 'Why, in a sentence.' },
    },
    ['jobId', 'changes'],
  ),
  endsTurn: true,
  handler: async (raw, ctx) => {
    const input = asInput(raw);
    const job = jobOfProject(ctx, str(input, 'jobId'));
    const changes = input['changes'];
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
      throw new DomainError('invalid', 'changes must be an object of the fields to change');
    }
    const { value } = await ctx.commands.proposeJob({
      projectId: job.projectId,
      waykeeperId: ctx.brainId,
      action: 'change',
      jobId: job.id,
      changes: changes as Partial<JobDraft> & { areaId?: Id },
      ...rationaleOf(input),
    });
    return cardResult(value);
  },
};

// -- propose_job_stop ------------------------------------------------------------------------------

export const proposeJobStopTool: BrainTool = {
  name: 'propose_job_stop',
  description:
    'Proposes stopping one recurring job for good, as one card. A stopped job runs no more and ' +
    'its waiting follow-ups are dropped. Ends your turn.',
  inputSchema: obj(
    { jobId: { type: 'string' }, rationale: { type: 'string', description: 'Why.' } },
    ['jobId'],
  ),
  endsTurn: true,
  handler: async (raw, ctx) => {
    const input = asInput(raw);
    const job = jobOfProject(ctx, str(input, 'jobId'));
    const { value } = await ctx.commands.proposeJob({
      projectId: job.projectId,
      waykeeperId: ctx.brainId,
      action: 'stop',
      jobId: job.id,
      ...rationaleOf(input),
    });
    return cardResult(value);
  },
};

// -- list_jobs -------------------------------------------------------------------------------------

export const listJobsTool: BrainTool = {
  name: 'list_jobs',
  description:
    "Your project's recurring jobs: area, name, schedule, state, next run, last run and the " +
    'findings still waiting for Cosmin.',
  inputSchema: obj({}),
  handler: async (_raw, ctx) => {
    const project = projectOf(ctx);
    const areas = new Map(ctx.queries.areas(project.id).map((a) => [a.id, a]));
    const open = ctx.queries.allOpenQuestions();
    return {
      jobs: ctx.queries.jobs(project.id).map((job) => ({
        id: job.id,
        areaId: job.areaId,
        area: areas.get(job.areaId)?.name ?? job.areaId,
        name: job.name,
        schedule: scheduleText(job.schedule),
        state: job.state,
        ...(job.pausedReason ? { pausedReason: job.pausedReason } : {}),
        nextRunAt: job.nextRunAt ?? null,
        lastRun: job.lastRun ?? null,
        openFindings: open.filter((q) => q.context.finding?.jobId === job.id).length,
      })),
    };
  },
};

// -- read_job_runs ---------------------------------------------------------------------------------

const runBrief = (r: JobRun) => ({
  id: r.id,
  purpose: r.purpose,
  outcome: r.outcome,
  startedAt: r.startedAt,
  ...(r.endedAt ? { endedAt: r.endedAt } : {}),
  ...(r.coversFrom ? { coversFrom: r.coversFrom } : {}),
  ...(r.summary ? { summary: r.summary } : {}),
  ...(r.numbers ? { numbers: r.numbers } : {}),
  ...(r.note ? { note: r.note } : {}),
});

export const readJobRunsTool: BrainTool = {
  name: 'read_job_runs',
  description:
    `One job's runs, newest first (default ${DEFAULT_RUNS_READ}, at most ${MAX_RUNS_READ}). ` +
    'Read them when Cosmin asks or when you change the job.',
  inputSchema: obj(
    {
      jobId: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_RUNS_READ },
    },
    ['jobId'],
  ),
  handler: async (raw, ctx) => {
    const input = asInput(raw);
    const job = jobOfProject(ctx, str(input, 'jobId'));
    const given = input['limit'];
    if (
      given !== undefined &&
      (typeof given !== 'number' || !Number.isInteger(given) || given < 1)
    ) {
      throw new DomainError('invalid', `limit must be a whole number from 1 to ${MAX_RUNS_READ}`);
    }
    const limit = Math.min(given ?? DEFAULT_RUNS_READ, MAX_RUNS_READ);
    return { runs: ctx.queries.jobRuns(job.id, limit).map(runBrief) };
  },
};

export const WAYKEEPER_JOB_TOOLS: readonly BrainTool[] = [
  proposeJobTool,
  proposeJobChangeTool,
  proposeJobStopTool,
  listJobsTool,
  readJobRunsTool,
];
