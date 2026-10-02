import { randomUUID } from 'node:crypto';
import {
  foldProposalMeta,
  proposalPlan,
  type Actor,
  type CreateProposalInput,
  type Id,
  type Proposal,
  type ProposalDecision,
  type ProposalState,
  type ProposePlanInput,
  type Task,
} from '@galactic/protocol';
import { carryOut, type ProposalOptions } from './approval.js';
import { describeRefusal } from './catalogue.js';
import { DomainError, must } from './errors.js';
import type { CommandContext } from './event-log.js';
import {
  bodyRequestOf,
  park,
  parkIfNoRoom,
  parkingFor,
  roomFor,
  unparkWaiting,
} from './parking.js';
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

export function createProposal(
  ctx: CommandContext,
  input: CreateProposalInput,
  opts: ProposalOptions = {},
): Proposal {
  checkShape(ctx, input);
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
    ...(input.meta && Object.keys(input.meta).length > 0 ? { meta: input.meta } : {}),
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

export function decideProposal(
  ctx: CommandContext,
  proposalId: Id,
  decision: ProposalDecision,
  by?: Actor,
  opts: ProposalOptions = {},
): Proposal {
  const current = must(ctx.tables.proposals.get(proposalId), 'proposal', proposalId);
  const plan = proposalPlan(current);
  if (plan) {
    // The user decides on a plan (decision 3), as one; it is edited through its tasks.
    if (by?.type === 'agent') {
      throw new DomainError('invalid', `plan ${proposalId} is the user's to decide`);
    }
    if (decision.decision === 'edit' || decision.decision === 'park') {
      throw new DomainError(
        'invalid',
        `plan ${proposalId} is not ${DONE[decision.decision]}: edit its tasks, or reject it with a reason`,
      );
    }
  }
  if (!ALLOWED[decision.decision].includes(current.state)) {
    throw new DomainError(
      'invalid_transition',
      `proposal ${proposalId} is ${current.state}; it cannot be ${DONE[decision.decision]}`,
    );
  }
  // Any decision but a park drops the card's parking (P2-09; `foldProposalMeta`, as clients fold).
  const save = (changes: Partial<Proposal>, initGit?: boolean) => {
    const meta = foldProposalMeta(current.meta, {
      parked: null,
      ...(initGit !== undefined ? { initGit } : {}),
    });
    const next: Proposal = { ...current, ...changes, updatedAt: ctx.now };
    if (meta) next.meta = meta;
    else delete next.meta;
    return ctx.tables.proposals.upsert(next);
  };
  switch (decision.decision) {
    case 'approve': {
      // A work card needs its body now (P2-09): without one it is parked instead (decision 16).
      const request = plan ? undefined : bodyRequestOf(ctx, current);
      const room = request ? roomFor(ctx, current, opts) : undefined;
      if (request && room && !room.ok) {
        if (current.state === 'parked') {
          throw new DomainError('conflict', `${describeRefusal(room)}: the card stays parked`);
        }
        return park(ctx, current, parkingFor(request, room));
      }
      const workspace = plan
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
      // What the card asks for is created in the approval's transaction (P2-09, `approval.ts`).
      if (!plan) carryOut(ctx, proposal, room?.ok ? room.body : undefined, workspace, opts);
      return proposal;
    }
    case 'edit': {
      const { initGit, ...changes } = Object.fromEntries(
        Object.entries(decision.changes).filter(([, v]) => v !== undefined),
      ) as typeof decision.changes;
      if (Object.keys(changes).length === 0 && initGit === undefined)
        throw new DomainError('invalid', 'an edit changes something');
      if (initGit !== undefined && by?.type !== 'user') {
        // Decision 27: only the user agrees to turn their folder into a repository.
        throw new DomainError('invalid', 'only the user agrees to git init a workspace');
      }
      if (changes.workspace !== undefined && opts.checkWorkspace) {
        changes.workspace = opts.checkWorkspace(changes.workspace);
      }
      checkShape(ctx, { ...current, ...changes });
      const proposal = save({ ...changes, state: 'edited' }, initGit);
      ctx.emit({
        type: 'proposal.edited',
        proposalId,
        changes: { ...changes, ...(initGit !== undefined ? { initGit } : {}) },
      });
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
      if (!plan) unparkWaiting(ctx, opts);
      return proposal;
    }
    case 'park':
      // Parked by hand: no `waitingFor`, so it waits for the user's next decision.
      return park(ctx, current, { reason: decision.reason });
  }
}
