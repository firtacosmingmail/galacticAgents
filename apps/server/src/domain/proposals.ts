import { randomUUID } from 'node:crypto';
import type {
  CreateProposalInput,
  Id,
  Proposal,
  ProposalDecision,
  ProposalState,
} from '@galactic/protocol';
import { DomainError, must } from './errors.js';
import type { CommandContext } from './event-log.js';

/**
 * Proposal commands (P2-01; SPEC §3.3, decisions 3 and 16). A proposal is the one card a work
 * request produces. The user approves it, edits it inline (size, body, workspace), or rejects it —
 * a rejected proposal stays as a draft that can still be edited, and an edited one can be decided
 * again; a proposal with no free planet is parked until it is edited or a planet frees. Approval
 * is final. What approval sets in motion (bodies, spawns) and un-parking are P2-09.
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

export function createProposal(ctx: CommandContext, input: CreateProposalInput): Proposal {
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
    ...(input.meta ? { meta: input.meta } : {}),
  };
  ctx.tables.proposals.insert(proposal);
  ctx.emit({ type: 'proposal.created', proposal });
  return proposal;
}

export function decideProposal(
  ctx: CommandContext,
  proposalId: Id,
  decision: ProposalDecision,
): Proposal {
  const current = must(ctx.tables.proposals.get(proposalId), 'proposal', proposalId);
  if (!ALLOWED[decision.decision].includes(current.state)) {
    throw new DomainError(
      'invalid_transition',
      `proposal ${proposalId} is ${current.state}; it cannot be ${DONE[decision.decision]}`,
    );
  }
  const save = (changes: Partial<Proposal>) =>
    ctx.tables.proposals.upsert({ ...current, ...changes, updatedAt: ctx.now });
  switch (decision.decision) {
    case 'approve': {
      const proposal = save({ state: 'approved' });
      ctx.emit({ type: 'proposal.approved', proposalId });
      return proposal;
    }
    case 'edit': {
      const changes = Object.fromEntries(
        Object.entries(decision.changes).filter(([, v]) => v !== undefined),
      ) as typeof decision.changes;
      if (Object.keys(changes).length === 0)
        throw new DomainError('invalid', 'an edit changes something');
      checkShape(ctx, { ...current, ...changes });
      const proposal = save({ ...changes, state: 'edited' });
      ctx.emit({ type: 'proposal.edited', proposalId, changes });
      return proposal;
    }
    case 'reject': {
      const proposal = save({ state: 'rejected' });
      ctx.emit({
        type: 'proposal.rejected',
        proposalId,
        ...(decision.reason ? { reason: decision.reason } : {}),
      });
      return proposal;
    }
    case 'park': {
      const proposal = save({ state: 'parked' });
      ctx.emit({ type: 'proposal.parked', proposalId, reason: decision.reason });
      return proposal;
    }
  }
}
