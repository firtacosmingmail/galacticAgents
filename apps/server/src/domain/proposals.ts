import { randomUUID } from 'node:crypto';
import {
  BudgetUsd,
  NEW_JOB_ID,
  affectedPanels,
  foldProposalMeta,
  proposalBudget,
  proposalJobOf,
  proposalLongTermOf,
  proposalPanelOf,
  proposalPlan,
  TrustLevel,
  type Actor,
  type CreateProposalInput,
  type Id,
  type Job,
  type Project,
  type Proposal,
  type ProposalDecision,
  type PanelDraft,
  type ProposalJob,
  type ProposalPanel,
  type ProposalState,
  type ProposeJobInput,
  type ProposePanelInput,
  type ProposePlanInput,
  type RequestOrigin,
  type Task,
  type UpdateJobInput,
} from '@galactic/protocol';
import { carryOut, type ProposalOptions } from './approval.js';
import { setBudget } from './budgets.js';
import { describeRefusal, hasMoons, type Reader } from './catalogue.js';
import { DomainError, must } from './errors.js';
import type { CommandContext } from './event-log.js';
import {
  checkJobCreate,
  createJob,
  grantsNewRules,
  draftOf,
  jobOf,
  planJobUpdate,
  previewJobArea,
  setJobState,
  updateJob,
} from './jobs.js';
import {
  bodyRequestOf,
  park,
  parkIfNoRoom,
  parkingFor,
  requestOf,
  roomFor,
  unparkWaiting,
} from './parking.js';
import {
  checkPanelRoom,
  checkPanelSource,
  checkedPanelDraft,
  createPanel,
  dashboardProject,
  panelOf,
  panelsOf,
  removePanel,
  updatePanel,
} from './panels.js';
import { checkPurposeAndGoals, checkSetLongTerm } from './projects.js';
import type { PolicyWrite } from './permissions.js';
import { setTaskState } from './states.js';
import { createTask } from './tasks.js';

/**
 * Proposal commands (P2-01; SPEC §3.3, decisions 3 and 16). A proposal is the one card a work
 * request produces. The user approves it, edits it inline (size, body, workspace), or rejects it —
 * a rejected proposal stays as a draft that can still be edited, and an edited one can be decided
 * again; a proposal with no free planet is parked until it is edited or a planet frees. Approval
 * is final. P2-09: a work card that needs a body none is free of is parked by the server
 * (`parking.ts`) and un-parks when one frees; approval creates what the card asks for
 * (`approval.ts`).
 */

/** From which states each decision may be taken. */
const ALLOWED: Record<ProposalDecision['decision'], readonly ProposalState[]> = {
  approve: ['pending', 'edited', 'parked'],
  edit: ['pending', 'edited', 'parked', 'rejected'],
  reject: ['pending', 'edited', 'parked'],
  park: ['pending', 'edited'],
};

const DONE: Record<ProposalDecision['decision'], string> = {
  approve: 'approved',
  edit: 'edited',
  reject: 'rejected',
  park: 'parked',
};

function checkShape(ctx: CommandContext, p: Pick<Proposal, 'kind' | 'proposedBody' | 'workspace'>) {
  if (p.proposedBody.kind !== p.kind) {
    throw new DomainError(
      'invalid',
      `the proposed body is a ${p.proposedBody.kind}, the proposal a ${p.kind}`,
    );
  }
  if (!p.workspace.trim()) throw new DomainError('invalid', 'a proposal needs a workspace');
  if (p.proposedBody.bodyId) {
    must(ctx.tables.bodies.get(p.proposedBody.bodyId), 'body', p.proposedBody.bodyId);
  }
  if (p.proposedBody.parentId) {
    must(ctx.tables.bodies.get(p.proposedBody.parentId), 'body', p.proposedBody.parentId);
  }
}

/**
 * A long-term card (`meta.longTerm`, P10-06) checked before it exists. A new long-term project is
 * an independent planet project, on a planet with moons when the card names one. A conversion card
 * (`projectId`) is checked like `setLongTerm` — refused when no planet with moons is free for a
 * project that must move — and proposes where the approval puts the project.
 */
function checkLongTermCard(ctx: Reader, input: CreateProposalInput): CreateProposalInput {
  if (input.meta?.['longTerm'] === undefined) return input;
  const raw = input.meta['longTerm'] as { purpose?: unknown; goals?: unknown } | null;
  if (
    typeof raw?.purpose !== 'string' ||
    !Array.isArray(raw.goals) ||
    raw.goals.some((g) => typeof g !== 'string')
  ) {
    throw new DomainError('invalid', 'a long-term card needs a purpose and a list of goals');
  }
  checkPurposeAndGoals(raw.purpose, raw.goals as string[]);
  const longTerm = proposalLongTermOf(input);
  if (!longTerm) throw new DomainError('invalid', 'invalid long-term card');
  if (longTerm.projectId) {
    if (input.meta['request'] !== undefined) {
      throw new DomainError('invalid', 'a conversion card asks for nothing else');
    }
    const { project, to } = checkSetLongTerm(ctx, { ...longTerm, projectId: longTerm.projectId });
    const body = to ?? must(ctx.tables.bodies.get(project.bodyId), 'body', project.bodyId);
    return {
      ...input,
      kind: 'planet',
      proposedBody: { kind: 'planet', bodyId: body.id, name: body.name },
      workspace: project.workspace,
    };
  }
  const request = requestOf(input);
  if (request?.type !== 'new_project' || request.parentProjectId || input.kind !== 'planet') {
    throw new DomainError('invalid', 'a long-term project is a new project on a planet of its own');
  }
  checkLongTermBody(ctx, input.proposedBody.bodyId);
  return input;
}

/** A long-term project's named planet has moons (its areas live on them). */
function checkLongTermBody(ctx: Reader, bodyId: Id | undefined): void {
  if (!bodyId) return;
  const body = must(ctx.tables.bodies.get(bodyId), 'body', bodyId);
  if (!hasMoons(ctx, body)) {
    throw new DomainError(
      'invalid',
      `a long-term project lives on a planet with moons; ${body.name} has none`,
    );
  }
}

export function createProposal(
  ctx: CommandContext,
  given: CreateProposalInput,
  opts: ProposalOptions = {},
): Proposal {
  if (given.meta?.['job'] !== undefined) {
    throw new DomainError(
      'invalid',
      "a job card is made by proposeJob, from the project's Waykeeper",
    );
  }
  if (given.meta?.['panel'] !== undefined) {
    throw new DomainError(
      'invalid',
      "a panel card is made by proposePanel, from the project's Waykeeper",
    );
  }
  const input = checkLongTermCard(ctx, given);
  checkShape(ctx, input);
  // A card's trust level is the user's alone (decision 49): whoever proposes cannot preset it.
  const { trust: _trust, ...meta } = input.meta ?? {};
  const proposal: Proposal = {
    id: `pr-${randomUUID()}`,
    requestText: input.requestText,
    kind: input.kind,
    proposedBody: input.proposedBody,
    workspace: input.workspace,
    rationale: input.rationale,
    state: 'pending',
    createdAt: ctx.now,
    updatedAt: ctx.now,
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
  };
  if (proposalPlan(proposal)) {
    throw new DomainError('invalid', 'a plan card is made by proposePlan, with its tasks');
  }
  ctx.tables.proposals.insert(proposal);
  ctx.emit({ type: 'proposal.created', proposal });
  // Decision 16: no free planet (or moon) — the card is parked at once, by the server (P2-09).
  return parkIfNoRoom(ctx, proposal, opts);
}

/** Plan states in which a project takes no new plan: one is waiting for the user, or was approved. */
const LIVE_PLAN: readonly ProposalState[] = ['pending', 'edited', 'parked', 'approved'];

/** The project's plan cards, oldest first. */
export function plansOf(ctx: Pick<CommandContext, 'tables'>, projectId: Id): Proposal[] {
  return ctx.tables.proposals
    .all()
    .filter((p) => proposalPlan(p)?.projectId === projectId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * A Waykeeper's task plan as one card (P2-10; SPEC §3.3, decision 3). The tasks are created
 * `proposed` on the project's body and the card is a proposal whose `meta.plan` lists them; its
 * size, body and workspace are the project's. One plan per project: refused while another plan
 * card waits for the user or after one was approved (later tasks are added one by one). A new plan
 * after a rejection replaces the rejected draft: its tasks still `proposed` are archived.
 */
export function proposePlan(
  ctx: CommandContext,
  input: ProposePlanInput,
): { proposal: Proposal; tasks: Task[] } {
  const project = must(ctx.tables.projects.get(input.projectId), 'project', input.projectId);
  const waykeeper = must(ctx.tables.agents.get(input.waykeeperId), 'agent', input.waykeeperId);
  if (waykeeper.role !== 'waykeeper' || waykeeper.projectId !== project.id) {
    throw new DomainError('invalid', `${waykeeper.id} is not the Waykeeper of ${project.id}`);
  }
  if (!input.summary.trim()) throw new DomainError('invalid', 'a plan needs a summary');
  if (input.tasks.length === 0) throw new DomainError('invalid', 'a plan needs at least one task');
  const plans = plansOf(ctx, project.id);
  const live = plans.find((p) => LIVE_PLAN.includes(p.state));
  if (live) {
    throw new DomainError(
      live.state === 'approved' ? 'invalid_transition' : 'conflict',
      live.state === 'approved'
        ? `the plan of project ${project.id} was approved (${live.id}); add tasks one by one`
        : `plan ${live.id} of project ${project.id} is waiting for the user`,
    );
  }
  // The rejected drafts this plan replaces: their tasks that never started go to the archive.
  for (const old of plans) {
    for (const taskId of proposalPlan(old)!.taskIds) {
      if (ctx.tables.tasks.get(taskId)?.state === 'proposed') {
        setTaskState(ctx, taskId, 'archived', { type: 'agent', id: waykeeper.id });
      }
    }
  }
  const tasks: Task[] = [];
  input.tasks.forEach((t, i) => {
    const blockedBy = (t.blockedBy ?? []).map((b) => {
      if (typeof b === 'string') return b;
      if (!Number.isInteger(b) || b < 0 || b >= i) {
        throw new DomainError('invalid', `task ${i} of the plan can only wait for earlier tasks`);
      }
      return tasks[b]!.id;
    });
    tasks.push(
      createTask(ctx, {
        description: t.description,
        projectId: project.id,
        state: 'proposed',
        ...(t.priority ? { priority: t.priority } : {}),
        ...(blockedBy.length > 0 ? { blockedBy } : {}),
        ...(t.provider ? { provider: t.provider } : {}),
        ...(t.model ? { model: t.model } : {}),
        ...(t.publishes ? { publishes: true } : {}),
        ...(t.makesImages ? { makesImages: true } : {}),
      }),
    );
  });
  const body = must(ctx.tables.bodies.get(project.bodyId), 'body', project.bodyId);
  const kind = body.kind === 'moon' ? 'moon' : 'planet';
  const proposal: Proposal = {
    id: `pr-${randomUUID()}`,
    requestText: input.summary,
    kind,
    proposedBody: { kind, bodyId: body.id, name: body.name },
    workspace: project.workspace,
    rationale: input.rationale ?? '',
    state: 'pending',
    createdAt: ctx.now,
    updatedAt: ctx.now,
    meta: {
      plan: { projectId: project.id, waykeeperId: waykeeper.id, taskIds: tasks.map((t) => t.id) },
    },
  };
  ctx.tables.proposals.insert(proposal);
  ctx.emit({ type: 'proposal.created', proposal });
  return { proposal, tasks };
}

/** The project's Waykeeper `waykeeperId`, or the refusal. */
function waykeeperOf(ctx: Reader, project: Project, waykeeperId: Id) {
  const waykeeper = must(ctx.tables.agents.get(waykeeperId), 'agent', waykeeperId);
  if (waykeeper.role !== 'waykeeper' || waykeeper.projectId !== project.id) {
    throw new DomainError('invalid', `${waykeeper.id} is not the Waykeeper of ${project.id}`);
  }
  return waykeeper;
}

/** The moon a job's area lives on. */
const areaMoonOf = (ctx: Reader, job: Job): Id =>
  must(ctx.tables.areas.get(job.areaId), 'area', job.areaId).bodyId;

/** Job-card states that still wait for the user. */
const WAITING: readonly ProposalState[] = ['pending', 'edited', 'parked'];

/** A job of the project with no other card waiting about it, or the refusal. */
function proposableJob(ctx: Reader, project: Project, jobId: Id): Job {
  const job = jobOf(ctx, jobId);
  if (job.projectId !== project.id) {
    throw new DomainError('invalid', `job ${jobId} is not a job of project ${project.id}`);
  }
  const waiting = ctx.tables.proposals
    .all()
    .find((p) => WAITING.includes(p.state) && cardJobIdOf(p) === jobId);
  if (waiting) {
    throw new DomainError(
      'conflict',
      `card ${waiting.id} about job ${job.name} is waiting for the user`,
    );
  }
  return job;
}

/** The job a waiting card would change or stop: a job card's, or a panel card's job part's. */
function cardJobIdOf(p: Proposal): Id | undefined {
  const job = proposalPanelOf(p)?.job;
  if (job && 'propose' in job) return job.propose.jobId;
  return proposalJobOf(p)?.jobId;
}

const JOB_CARD_TITLE = { create: 'New recurring job', change: 'Change job', stop: 'Stop job' };

/**
 * A Waykeeper's job card (P10-06; SPEC decision 144): one card to create, change or stop a
 * recurring job of its long-term project, checked by the same rules as the command its approval
 * runs (`checkJobCreate`, `planJobUpdate`) before it exists — a push rule, a secret, a full area
 * or a short-term project is refused here, not at approval. A change or stop card keeps the job as
 * it was (`before`) and the job as it will be (`draft`), so it shows before → after; one card per
 * job waits at a time. Like a plan card, it lives on the project's body and the Waykeeper that
 * proposed (or its successor) is told the decision.
 */
export function proposeJob(ctx: CommandContext, input: ProposeJobInput): Proposal {
  const project = must(ctx.tables.projects.get(input.projectId), 'project', input.projectId);
  const waykeeper = waykeeperOf(ctx, project, input.waykeeperId);
  const { card, name } = jobCardFor(ctx, project, waykeeper.id, input);
  return insertCard(ctx, project, `${JOB_CARD_TITLE[card.action]}: ${name}`, input.rationale, {
    job: card,
  });
}

/**
 * A job card's content (`meta.job`), checked by the rules of the command its approval runs: what
 * `proposeJob` makes, and a panel card's job part.
 */
function jobCardFor(
  ctx: CommandContext,
  project: Project,
  waykeeperId: Id,
  input: ProposeJobInput,
): { card: ProposalJob; name: string } {
  const waykeeper = { id: waykeeperId };
  let card: ProposalJob;
  let name: string;
  switch (input.action) {
    case 'create': {
      const { area, moonId } = previewJobArea(ctx, project.id, input.area);
      const draft = checkJobCreate(ctx, { projectId: project.id, area, draft: input.draft });
      card = {
        projectId: project.id,
        waykeeperId: waykeeper.id,
        action: 'create',
        draft,
        area,
        moonId,
      };
      name = draft.name;
      break;
    }
    case 'change': {
      const job = proposableJob(ctx, project, input.jobId);
      const given = Object.entries(input.changes).filter(([, v]) => v !== undefined);
      if (given.length === 0) throw new DomainError('invalid', 'a job change changes something');
      const { merged, changes, area } = planJobUpdate(ctx, {
        jobId: job.id,
        changes: input.changes,
      });
      if (Object.keys(changes).length === 0) {
        throw new DomainError('invalid', `the change leaves job ${job.name} as it is`);
      }
      card = {
        projectId: project.id,
        waykeeperId: waykeeper.id,
        action: 'change',
        jobId: job.id,
        draft: merged,
        ...(changes.areaId ? { area: { areaId: changes.areaId } } : {}),
        moonId: area?.bodyId ?? areaMoonOf(ctx, job),
        before: { draft: draftOf(job), areaId: job.areaId },
      };
      name = job.name;
      break;
    }
    case 'stop': {
      const job = proposableJob(ctx, project, input.jobId);
      if (job.state === 'stopped') {
        throw new DomainError('invalid_transition', `job ${job.name} is already stopped`);
      }
      card = {
        projectId: project.id,
        waykeeperId: waykeeper.id,
        action: 'stop',
        jobId: job.id,
        moonId: areaMoonOf(ctx, job),
        before: { draft: draftOf(job), areaId: job.areaId },
      };
      name = job.name;
      break;
    }
  }
  return { card, name };
}

/** A Waykeeper's card on its project's body (`proposal.created`), like a plan card. */
function insertCard(
  ctx: CommandContext,
  project: Project,
  requestText: string,
  rationale: string | undefined,
  meta: Proposal['meta'],
): Proposal {
  const body = must(ctx.tables.bodies.get(project.bodyId), 'body', project.bodyId);
  const kind = body.kind === 'moon' ? 'moon' : 'planet';
  const proposal: Proposal = {
    id: `pr-${randomUUID()}`,
    requestText,
    kind,
    proposedBody: { kind, bodyId: body.id, name: body.name },
    workspace: project.workspace,
    rationale: rationale ?? '',
    state: 'pending',
    createdAt: ctx.now,
    updatedAt: ctx.now,
    ...(meta ? { meta } : {}),
  };
  ctx.tables.proposals.insert(proposal);
  ctx.emit({ type: 'proposal.created', proposal });
  return proposal;
}

const PANEL_CARD_TITLE = { create: 'New panel', change: 'Change panel', remove: 'Remove panel' };

/** A panel's editable part, as a draft (what a change or removal card shows as "before"). */
const panelDraftOf = (p: PanelDraft): PanelDraft => ({
  type: p.type,
  title: p.title,
  source: p.source,
  display: p.display,
  limits: p.limits,
});

const sameTitle = (a: string, b: string): boolean =>
  a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

/** A job card's part of a panel card, as `proposeJob` takes it. */
function jobPartInput(project: Project, waykeeperId: Id, job: ProposalJob): ProposeJobInput {
  const base = { projectId: project.id, waykeeperId };
  if (job.action === 'create') {
    if (!job.draft || !job.area) {
      throw new DomainError('invalid', "a panel card's new job needs a job and its area");
    }
    return { ...base, action: 'create', area: job.area, draft: job.draft };
  }
  if (job.action === 'change') {
    if (!job.jobId || !job.draft) {
      throw new DomainError('invalid', "a panel card's job change needs the job and its change");
    }
    const changes: Extract<ProposeJobInput, { action: 'change' }>['changes'] = {
      ...Object.fromEntries(Object.entries(job.draft).filter(([, v]) => v !== undefined)),
      ...(job.area && 'areaId' in job.area ? { areaId: job.area.areaId } : {}),
    };
    return { ...base, action: 'change', jobId: job.jobId, changes };
  }
  throw new DomainError('invalid', 'a panel card creates or changes a job, never stops one');
}

/** A job a panel card's `use` names: of the project, and not stopped. */
function usableJob(ctx: Reader, projectId: Id, jobId: Id): Job {
  const job = jobOf(ctx, jobId);
  if (job.projectId !== projectId) {
    throw new DomainError('invalid', `job ${jobId} is not a job of project ${projectId}`);
  }
  if (job.state === 'stopped') {
    throw new DomainError('invalid', `job ${job.name} is stopped: a panel cannot read it`);
  }
  return job;
}

/**
 * A Waykeeper's panel card (P15-03; SPEC decision 156): add, change or remove one panel of its
 * long-term project's dashboard, filled by an existing job (`job.use`) or by a job the same card
 * creates or changes (`job.propose`, checked like `proposeJob`; a new job's panel reads `$new`).
 * The card keeps the panel as it was (`before`). A new card from the same Waykeeper about the same
 * panel, or with the same title, supersedes its earlier waiting card (rejected as `superseded`).
 */
export function proposePanel(ctx: CommandContext, input: ProposePanelInput): Proposal {
  const project = dashboardProject(ctx, input.projectId);
  const waykeeper = waykeeperOf(ctx, project, input.waykeeperId);
  const draft = input.draft === undefined ? undefined : checkedPanelDraft(input.draft);
  // The earlier waiting card this one replaces goes first: its job part no longer blocks this one.
  const title = draft?.title;
  for (const p of ctx.tables.proposals.all()) {
    const other = proposalPanelOf(p);
    if (!other || !WAITING.includes(p.state) || other.waykeeperId !== waykeeper.id) continue;
    const samePanel = input.panelId !== undefined && other.panelId === input.panelId;
    const sameDraft =
      title !== undefined && other.draft !== undefined && sameTitle(other.draft.title, title);
    if (samePanel || sameDraft) {
      ctx.tables.proposals.upsert({ ...p, state: 'rejected', updatedAt: ctx.now });
      ctx.emit({ type: 'proposal.rejected', proposalId: p.id, reason: 'superseded' });
    }
  }
  let before: PanelDraft | undefined;
  if (input.action === 'create') {
    if (input.panelId !== undefined) throw new DomainError('invalid', 'a new panel has no id yet');
    checkPanelRoom(ctx, project.id);
  } else {
    if (input.panelId === undefined) {
      throw new DomainError('invalid', `a ${input.action} card names its panel`);
    }
    const panel = panelOf(ctx, input.panelId);
    if (panel.projectId !== project.id) {
      throw new DomainError(
        'invalid',
        `panel ${panel.id} is not on the dashboard of ${project.id}`,
      );
    }
    before = panelDraftOf(panel);
  }
  let job: ProposalPanel['job'];
  if (input.action === 'remove') {
    if (draft || input.job)
      throw new DomainError('invalid', 'a removal card removes, nothing else');
  } else {
    if (!draft) throw new DomainError('invalid', `a ${input.action} card needs the panel`);
    if (before && draft.type !== before.type) {
      throw new DomainError(
        'invalid',
        "a panel's type does not change: propose removing it and adding a new one",
      );
    }
    const reads = draft.source.kind === 'job' ? draft.source.jobId : undefined;
    if (input.job && 'use' in input.job) {
      usableJob(ctx, project.id, input.job.use);
      if (reads !== input.job.use) {
        throw new DomainError(
          'invalid',
          `the panel reads job ${reads ?? 'none'}, not the one it uses`,
        );
      }
      job = { use: input.job.use };
    } else if (input.job && 'propose' in input.job) {
      const part = jobCardFor(
        ctx,
        project,
        waykeeper.id,
        jobPartInput(project, waykeeper.id, input.job.propose),
      ).card;
      const expected = part.action === 'create' ? NEW_JOB_ID : part.jobId;
      if (reads !== expected) {
        throw new DomainError(
          'invalid',
          part.action === 'create'
            ? `the panel reads the job the card creates: its source job is "${NEW_JOB_ID}"`
            : `the panel reads job ${reads ?? 'none'}, not the one the card changes`,
        );
      }
      job = { propose: part };
    } else if (reads !== undefined) {
      throw new DomainError(
        'invalid',
        'a panel reading a job says which: `use` it or `propose` it',
      );
    }
    if (reads !== undefined && reads !== NEW_JOB_ID)
      checkPanelSource(ctx, project.id, draft.source);
  }
  const card: ProposalPanel = {
    projectId: project.id,
    waykeeperId: waykeeper.id,
    action: input.action,
    ...(input.panelId !== undefined ? { panelId: input.panelId } : {}),
    ...(draft ? { draft } : {}),
    ...(before ? { before } : {}),
    ...(job ? { job } : {}),
  };
  const name = draft?.title ?? before?.title ?? '';
  return insertCard(ctx, project, `${PANEL_CARD_TITLE[card.action]}: ${name}`, input.rationale, {
    panel: card,
  });
}

const DRAFT_FIELDS = [
  'name',
  'instructions',
  'schedule',
  'provider',
  'model',
  'followUpProvider',
  'followUpModel',
  'unattendedRules',
  'dataMap',
] as const;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * What an approved job card does, in the approval's transaction: create the job (and a new area),
 * apply the fields the change card changed — to the job as it is now, so an edit made meanwhile to
 * another field stands — or stop the job. A refusal (the area filled up meanwhile, the project is
 * no longer open) undoes the approval with it.
 */
function carryOutJobCard(
  ctx: CommandContext,
  card: ProposalJob,
  by: Actor,
  origin: RequestOrigin | undefined,
): Job {
  const from = origin ? { origin } : {};
  switch (card.action) {
    case 'create':
      if (!card.draft || !card.area) throw new DomainError('invalid', 'a new job card needs a job');
      return createJob(ctx, {
        projectId: card.projectId,
        area: card.area,
        draft: card.draft,
        by,
        ...from,
      }).job;
    case 'change': {
      if (!card.jobId || !card.draft || !card.before) {
        throw new DomainError('invalid', 'a job change card needs the job and its change');
      }
      const changes: UpdateJobInput['changes'] = {};
      for (const field of DRAFT_FIELDS) {
        if (!same(card.draft[field], card.before.draft[field])) {
          (changes as Record<string, unknown>)[field] = card.draft[field];
        }
      }
      if (card.area && 'areaId' in card.area && card.area.areaId !== card.before.areaId) {
        changes.areaId = card.area.areaId;
      }
      return updateJob(ctx, { jobId: card.jobId, changes, by, ...from });
    }
    case 'stop':
      if (!card.jobId) throw new DomainError('invalid', 'a job stop card needs the job');
      return setJobState(ctx, { jobId: card.jobId, state: 'stopped', by });
  }
}

/**
 * What an approved panel card does, in the approval's transaction (P15-03). A job part that would
 * grant unattended rules is checked first (`checkRemoteGrant`, before anything is written), then
 * carried out like a job card; a `use` job must still be a running job of the project. Then the
 * placeholder `$new` becomes the new job's id and the panel is created, changed or removed. Any
 * refusal undoes the whole approval: the card is never half-applied. The panel itself grants
 * nothing.
 */
function carryOutPanelCard(
  ctx: CommandContext,
  card: ProposalPanel,
  by: Actor,
  write: PolicyWrite | undefined,
): void {
  let created: Job | undefined;
  if (card.job && 'propose' in card.job) {
    checkRemoteGrant(ctx, card.job.propose, write);
    const job = carryOutJobCard(ctx, card.job.propose, by, write?.origin);
    if (card.job.propose.action === 'create') created = job;
  } else if (card.job) {
    usableJob(ctx, card.projectId, card.job.use);
  }
  if (card.action === 'remove') {
    if (!card.panelId) throw new DomainError('invalid', 'a removal card needs its panel');
    removePanel(ctx, card.panelId, by, 'removed with its card');
    return;
  }
  if (!card.draft) throw new DomainError('invalid', `a ${card.action} card needs the panel`);
  const source =
    card.draft.source.kind === 'job' && card.draft.source.jobId === NEW_JOB_ID
      ? { ...card.draft.source, jobId: must(created, 'job', NEW_JOB_ID).id }
      : card.draft.source;
  const draft = { ...card.draft, source };
  if (card.action === 'create') {
    createPanel(ctx, card.projectId, draft, by);
    return;
  }
  if (!card.panelId) throw new DomainError('invalid', 'a change card needs its panel');
  const { type: _type, ...changes } = draft;
  updatePanel(ctx, card.panelId, changes, by);
}

/**
 * The panels an approved job stop or change card also removes when the user ticked "also remove
 * these panels" (`removePanels`): a stop's every panel reading the job ("job stopped"), a change's
 * those reading a value the job no longer collects ("no longer reported").
 */
function removeJobPanels(ctx: CommandContext, card: ProposalJob, by: Actor): void {
  if (!card.jobId || (card.action !== 'stop' && card.action !== 'change')) {
    throw new DomainError('invalid', 'only a job stop or change card removes panels');
  }
  const job = jobOf(ctx, card.jobId);
  const panels = panelsOf(ctx, job.projectId);
  const affected =
    card.action === 'stop'
      ? affectedPanels(panels, job.id)
      : job.dataMap
        ? affectedPanels(panels, job.id, job.dataMap)
        : [];
  const reason = card.action === 'stop' ? 'job stopped' : 'no longer reported';
  for (const panel of affected) removePanel(ctx, panel.id, by, reason);
}

/**
 * A job card whose approval would add or widen unattended rules is a lasting permission grant, so
 * it follows decision 138's "Allow similar" rule: from this machine, or a remote client only with
 * `autoApproveRemote` (an unknown origin counts as remote). A card that grants nothing new — no
 * rule, rules the job already has, fewer rules, a stop — may be approved from anywhere.
 */
function checkRemoteGrant(ctx: Reader, card: ProposalJob, write: PolicyWrite | undefined): void {
  if (write?.origin === 'local' || write?.autoApproveRemote) return;
  if (card.action === 'stop' || !card.draft) return;
  const current =
    card.action === 'change' && card.jobId ? ctx.tables.jobs.get(card.jobId)?.unattendedRules : [];
  if (!grantsNewRules(card.draft.unattendedRules, current)) return;
  throw new DomainError(
    'remote_control',
    'approve this job on the Mac: it grants what its runs may do unattended (a remote client may reject it)',
  );
}

export function decideProposal(
  ctx: CommandContext,
  proposalId: Id,
  decision: ProposalDecision,
  by?: Actor,
  opts: ProposalOptions = {},
): Proposal {
  const current = must(ctx.tables.proposals.get(proposalId), 'proposal', proposalId);
  const plan = proposalPlan(current);
  const jobCard = proposalJobOf(current);
  const panelCard = proposalPanelOf(current);
  const longTerm = proposalLongTermOf(current);
  if (jobCard || panelCard) {
    // A job or panel card is the user's (decisions 144, 156), decided as the Waykeeper made it.
    const what = jobCard ? 'job' : 'panel';
    if (by?.type === 'agent') {
      throw new DomainError('invalid', `${what} card ${proposalId} is the user's to decide`);
    }
    if (decision.decision === 'edit' || decision.decision === 'park') {
      throw new DomainError(
        'invalid',
        `${what} card ${proposalId} is not ${DONE[decision.decision]}: reject it with a reason and the Waykeeper proposes another`,
      );
    }
  }
  if (decision.decision === 'approve' && decision.removePanels && !jobCard) {
    throw new DomainError('invalid', 'only a job stop or change card removes panels');
  }
  if (longTerm?.projectId && (decision.decision === 'edit' || decision.decision === 'park')) {
    throw new DomainError(
      'invalid',
      `long-term card ${proposalId} is not ${DONE[decision.decision]}: approve or reject it as it is`,
    );
  }
  if (longTerm && !longTerm.projectId && decision.decision === 'edit') {
    // A long-term project lives on a planet with moons (P10-02): it is never downsized on its card.
    const kind = decision.changes.kind ?? decision.changes.proposedBody?.kind;
    if (kind !== undefined && kind !== 'planet') {
      throw new DomainError(
        'invalid',
        `a long-term project lives on a planet with moons, not on a ${kind}: reject the card and ask for an ordinary project instead`,
      );
    }
    checkLongTermBody(ctx, decision.changes.proposedBody?.bodyId);
  }
  if (plan) {
    // The user decides on a plan (decision 3), as one; it is edited through its tasks.
    if (by?.type === 'agent') {
      throw new DomainError('invalid', `plan ${proposalId} is the user's to decide`);
    }
    // Its budget (P8-01) is the one thing a plan card's edit may set: the project's budget.
    const budgetOnly =
      decision.decision === 'edit' &&
      Object.entries(decision.changes).every(([k, v]) => k === 'budgetUsd' || v === undefined) &&
      (current.state === 'pending' || current.state === 'edited');
    if ((decision.decision === 'edit' && !budgetOnly) || decision.decision === 'park') {
      throw new DomainError(
        'invalid',
        `plan ${proposalId} is not ${DONE[decision.decision]}: edit its tasks, or reject it with a reason`,
      );
    }
  }
  if (jobCard && decision.decision === 'approve') checkRemoteGrant(ctx, jobCard, opts.policyWrite);
  // A panel card's job part is checked the same way, before anything is written (P15-03).
  const panelJob = panelCard?.job && 'propose' in panelCard.job ? panelCard.job.propose : undefined;
  if (panelJob && decision.decision === 'approve') {
    checkRemoteGrant(ctx, panelJob, opts.policyWrite);
  }
  if (!ALLOWED[decision.decision].includes(current.state)) {
    throw new DomainError(
      'invalid_transition',
      `proposal ${proposalId} is ${current.state}; it cannot be ${DONE[decision.decision]}`,
    );
  }
  // Any decision but a park drops the card's parking (P2-09; `foldProposalMeta`, as clients fold).
  const save = (
    changes: Partial<Proposal>,
    user: { initGit?: boolean; trust?: TrustLevel; budgetUsd?: number | null } = {},
  ) => {
    const meta = foldProposalMeta(current.meta, { parked: null, ...user });
    const next: Proposal = { ...current, ...changes, updatedAt: ctx.now };
    if (meta) next.meta = meta;
    else delete next.meta;
    return ctx.tables.proposals.upsert(next);
  };
  switch (decision.decision) {
    case 'approve': {
      // A work card needs its body now (P2-09): without one it is parked instead (decision 16).
      const request = plan || jobCard || panelCard ? undefined : bodyRequestOf(ctx, current);
      const room = request ? roomFor(ctx, current, opts) : undefined;
      if (request && room && !room.ok) {
        if (current.state === 'parked') {
          throw new DomainError('conflict', `${describeRefusal(room)}: the card stays parked`);
        }
        return park(ctx, current, parkingFor(request, room));
      }
      const workspace =
        plan || jobCard || panelCard
          ? current.workspace
          : (opts.checkWorkspace?.(current.workspace) ?? current.workspace);
      const proposal = save({ state: 'approved' });
      ctx.emit({ type: 'proposal.approved', proposalId });
      // A plan's tasks are approved with it (the ones the user archived meanwhile stay archived).
      for (const taskId of plan?.taskIds ?? []) {
        if (ctx.tables.tasks.get(taskId)?.state === 'proposed') {
          setTaskState(ctx, taskId, 'approved', by);
        }
      }
      // A job card's job is created, changed or stopped with the approval (P10-06).
      if (jobCard) {
        carryOutJobCard(ctx, jobCard, by ?? { type: 'system' }, opts.policyWrite?.origin);
        // P15-03: the user ticked "also remove these panels" on a stop or change card.
        if (decision.removePanels) removeJobPanels(ctx, jobCard, by ?? { type: 'system' });
      }
      // A panel card's panel (and its job part) is written with the approval (P15-03).
      if (panelCard) carryOutPanelCard(ctx, panelCard, by ?? { type: 'system' }, opts.policyWrite);
      // What the card asks for is created in the approval's transaction (P2-09, `approval.ts`).
      const made =
        plan || jobCard || panelCard
          ? undefined
          : carryOut(ctx, proposal, room?.ok ? room.body : undefined, workspace, opts, by);
      // The budget the user gave the card (P8-01): the new project's or task's, a plan's project's.
      const budget = proposalBudget(proposal);
      const target = plan
        ? { kind: 'project' as const, id: plan.projectId }
        : made?.kind === 'project'
          ? { kind: 'project' as const, id: made.project.id }
          : made?.kind === 'task'
            ? { kind: 'task' as const, id: made.task.id }
            : undefined;
      if (budget !== undefined && target) {
        setBudget(ctx, target, budget, by ?? { type: 'system' }, opts.policyWrite ?? {});
      }
      return proposal;
    }
    case 'edit': {
      const { initGit, trust, budgetUsd, ...changes } = Object.fromEntries(
        Object.entries(decision.changes).filter(([, v]) => v !== undefined),
      ) as typeof decision.changes;
      if (
        Object.keys(changes).length === 0 &&
        initGit === undefined &&
        trust === undefined &&
        budgetUsd === undefined
      )
        throw new DomainError('invalid', 'an edit changes something');
      if (budgetUsd !== undefined) {
        // P8-01: the work's budget is the user's to give on the card, like its trust level.
        if (by?.type !== 'user') {
          throw new DomainError('invalid', "only the user sets a card's budget");
        }
        if (budgetUsd !== null && !BudgetUsd.safeParse(budgetUsd).success) {
          throw new DomainError(
            'invalid',
            `a budget is a positive amount of dollars, not ${budgetUsd}`,
          );
        }
      }
      if (initGit !== undefined && by?.type !== 'user') {
        // Decision 27: only the user agrees to turn their folder into a repository.
        throw new DomainError('invalid', 'only the user agrees to git init a workspace');
      }
      if (trust !== undefined) {
        // Decision 49: only the user sets how far a project is trusted — a brain cannot raise
        // the trust of the work it proposes.
        if (by?.type !== 'user') {
          throw new DomainError('invalid', "only the user sets a project's trust level");
        }
        if (!TrustLevel.safeParse(trust).success) {
          throw new DomainError('invalid', `unknown trust level ${String(trust)}`);
        }
      }
      const user = {
        ...(initGit !== undefined ? { initGit } : {}),
        ...(trust !== undefined ? { trust } : {}),
        ...(budgetUsd !== undefined ? { budgetUsd } : {}),
      };
      if (changes.workspace !== undefined && opts.checkWorkspace) {
        changes.workspace = opts.checkWorkspace(changes.workspace);
      }
      checkShape(ctx, { ...current, ...changes });
      const proposal = save({ ...changes, state: 'edited' }, user);
      ctx.emit({ type: 'proposal.edited', proposalId, changes: { ...changes, ...user } });
      // Still no room for what the card now asks: it stays parked (decision 16). A body this
      // card no longer proposes may let a parked card in.
      const after = parkIfNoRoom(ctx, proposal, opts);
      unparkWaiting(ctx, opts);
      return after;
    }
    case 'reject': {
      const proposal = save({ state: 'rejected' });
      ctx.emit({
        type: 'proposal.rejected',
        proposalId,
        ...(decision.reason ? { reason: decision.reason } : {}),
      });
      if (!plan && !jobCard && !panelCard) unparkWaiting(ctx, opts);
      return proposal;
    }
    case 'park':
      // Parked by hand: no `waitingFor`, so it waits for the user's next decision.
      return park(ctx, current, { reason: decision.reason });
  }
}
