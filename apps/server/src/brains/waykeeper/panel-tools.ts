import {
  LONG_TERM_LIMITS,
  PanelType,
  proposalPanelOf,
  unchangedSince,
  type Id,
  type JobDraft,
  type Panel,
  type PanelDraft,
  type ProposalJob,
  type Proposal,
  type ProposePanelInput,
} from '@galactic/protocol';
import { evaluateDashboard } from '../../domain/dashboard.js';
import { DomainError } from '../../domain/errors.js';
import type { BrainTool, BrainToolContext } from '../definition.js';
import { asInput, changeJobInput, createJobInput, obj, optStr, str } from './job-tools.js';
import { projectOf } from './tools.js';

/**
 * The Waykeeper's dashboard tools (P15-05; SPEC decision 156), given only to the Waykeeper of a
 * long-term project. It changes panels ONLY through cards — `propose_panel` (add or change one) and
 * `propose_panel_remove` — each checked like the command its approval runs; it never arranges a
 * dashboard (only Cosmin does) and never removes a panel without his card. `list_panels` reads
 * what each panel shows now.
 */

const JOB_PART_SCHEMA = {
  description:
    'Where the panel’s data comes from. {use: jobId}: an existing job that already collects the ' +
    'value (its dataMap.collects). {create: <propose_job input>}: a new job, in the same card ' +
    '(the draft’s source.jobId is "$new"). {change: <propose_job_change input>}: a change to an ' +
    'existing job that adds the missing value (the draft’s source.jobId is that job’s id). A ' +
    'panel on the project’s own tasks has no job part. The job part may widen what a job may do; ' +
    'the panel never does.',
  type: 'object',
};

const SOURCE_SCHEMA = {
  description:
    '{kind:"job", jobId, values:[collected value names]} or {kind:"tasks"} (a status panel only).',
  type: 'object',
};

const DRAFT_SCHEMA = obj(
  {
    type: { enum: PanelType.options },
    title: { type: 'string' },
    source: SOURCE_SCHEMA,
    display: {
      type: 'object',
      description:
        'How it looks: compare "week"|"month" (tile), rangeDays (charts), columns (table), …',
    },
    limits: {
      type: 'array',
      description:
        'When a value is very bad or very good: {value, better:"higher"|"lower", veryBad?, ' +
        'veryGood?} with a threshold {op:"above"|"below",value} or {op:"rise"|"fall",percent,' +
        'vs:"week"|"month"}.',
      items: { type: 'object' },
    },
  },
  ['type', 'title', 'source', 'display', 'limits'],
);

function cardResult(p: Proposal) {
  const card = proposalPanelOf(p);
  return {
    proposalId: p.id,
    state: p.state,
    action: card?.action,
    ...(card?.draft ? { panel: card.draft.title } : {}),
    note: 'The card is with Cosmin. End your turn now; his decision arrives as an event.',
  };
}

/** The job part of a panel card, from the tool's `job` input. */
async function jobPartOf(
  raw: unknown,
  ctx: BrainToolContext,
): Promise<ProposePanelInput['job'] | undefined> {
  if (raw === undefined || raw === null) return undefined;
  const job = asInput(raw);
  const given = ['use', 'create', 'change'].filter((k) => job[k] !== undefined);
  if (given.length !== 1) {
    throw new DomainError('invalid', 'job names exactly one of use, create or change');
  }
  if (given[0] === 'use') return { use: str(job, 'use') };
  if (given[0] === 'create') {
    const input = await createJobInput(asInput(job['create']), ctx);
    const part: ProposalJob = {
      projectId: input.projectId,
      waykeeperId: input.waykeeperId,
      action: 'create',
      draft: input.draft,
      area: input.area,
    };
    return { propose: part };
  }
  const input = await changeJobInput(asInput(job['change']), ctx);
  const { areaId, ...changes } = input.changes;
  const part: ProposalJob = {
    projectId: input.projectId,
    waykeeperId: input.waykeeperId,
    action: 'change',
    jobId: input.jobId,
    draft: changes as JobDraft,
    ...(areaId ? { area: { areaId } } : {}),
  };
  return { propose: part };
}

export const proposePanelTool: BrainTool = {
  name: 'propose_panel',
  description:
    'Proposes ONE dashboard panel as one card Cosmin approves or rejects: a new panel (no ' +
    'panelId) or a change to one (panelId; its type never changes). Its data comes from a job ' +
    '(see job) or, for a status panel, from the project’s tasks. Checked before the card exists. ' +
    'Ends your turn.',
  inputSchema: obj(
    {
      panelId: { type: 'string', description: 'The panel to change; absent for a new panel.' },
      draft: DRAFT_SCHEMA,
      job: JOB_PART_SCHEMA,
      rationale: { type: 'string', description: 'Why, in a sentence.' },
    },
    ['draft'],
  ),
  longTermOnly: true,
  endsTurn: true,
  handler: async (raw, ctx) => {
    const input = asInput(raw);
    const project = projectOf(ctx);
    const panelId = optStr(input, 'panelId');
    const draft = input['draft'];
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
      throw new DomainError('invalid', 'draft must be the panel');
    }
    const job = await jobPartOf(input['job'], ctx);
    const rationale = optStr(input, 'rationale');
    const { value } = await ctx.commands.proposePanel({
      projectId: project.id,
      waykeeperId: ctx.brainId,
      action: panelId ? 'change' : 'create',
      ...(panelId ? { panelId } : {}),
      draft: draft as PanelDraft,
      ...(job ? { job } : {}),
      ...(rationale ? { rationale } : {}),
    });
    return cardResult(value);
  },
};

export const proposePanelRemoveTool: BrainTool = {
  name: 'propose_panel_remove',
  description:
    'Proposes removing one dashboard panel, as one card with your reason. Nothing is removed ' +
    'until Cosmin approves it. Ends your turn.',
  inputSchema: obj({ panelId: { type: 'string' }, reason: { type: 'string' } }, [
    'panelId',
    'reason',
  ]),
  longTermOnly: true,
  endsTurn: true,
  handler: async (raw, ctx) => {
    const input = asInput(raw);
    const project = projectOf(ctx);
    const { value } = await ctx.commands.proposePanel({
      projectId: project.id,
      waykeeperId: ctx.brainId,
      action: 'remove',
      panelId: str(input, 'panelId'),
      rationale: str(input, 'reason'),
    });
    return cardResult(value);
  },
};

const panelBrief = (panel: Panel) => ({
  id: panel.id,
  type: panel.type,
  title: panel.title,
  source: panel.source,
  display: panel.display,
  limits: panel.limits,
  ...(panel.historyFrom ? { historyFrom: panel.historyFrom } : {}),
  ...(panel.removalSuggestedAt ? { removalSuggestedAt: panel.removalSuggestedAt } : {}),
});

export const listPanelsTool: BrainTool = {
  name: 'list_panels',
  description:
    'Your dashboard’s panels in Cosmin’s order: each one’s definition, what it shows now ' +
    '(status, value, verdict), since when its value has not changed (unchangedSince), and the ' +
    'values its job collects (collects).',
  inputSchema: obj({}),
  longTermOnly: true,
  handler: async (_raw: unknown, ctx) => {
    const project = projectOf(ctx);
    const panels = ctx.queries.panels(project.id);
    const jobs = new Map(ctx.queries.jobs(project.id).map((j) => [j.id, j]));
    const runs = (jobId: Id) => ctx.queries.jobRuns(jobId, LONG_TERM_LIMITS.runsKept);
    const data = evaluateDashboard(
      panels,
      {
        job: (jobId) => jobs.get(jobId),
        runs,
        tasks: ctx.queries.projectTasks(project.id),
      },
      new Date().toISOString(),
    );
    return {
      panels: panels.map((panel, i) => {
        const jobId = panel.source.kind === 'job' ? panel.source.jobId : undefined;
        const job = jobId ? jobs.get(jobId) : undefined;
        return {
          ...panelBrief(panel),
          data: data[i],
          unchangedSince: unchangedSince(panel, jobId ? runs(jobId) : []) ?? null,
          ...(jobId ? { job: job?.name ?? null } : {}),
          collects: job?.dataMap?.collects.map((c) => c.name) ?? [],
        };
      }),
    };
  },
};

export const WAYKEEPER_PANEL_TOOLS: readonly BrainTool[] = [
  proposePanelTool,
  proposePanelRemoveTool,
  listPanelsTool,
];
