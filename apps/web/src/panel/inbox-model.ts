import type { Proposal, Question } from '@galactic/protocol';
import type { WorldState } from '../state/reduce.js';

/**
 * The panel inbox's content (P25-06), as a pure model: every open question and every card the
 * user may act on, in the order the panel shows them. "Blocked on user" is the loudest state
 * (Phase 2.5 design notes), so what waits for the user comes first.
 */

export type InboxItem =
  | { kind: 'question'; question: Question }
  | { kind: 'proposal'; proposal: Proposal };

export interface InboxModel {
  /** Blocked on the user: open questions they hold, and cards waiting for their decision. */
  waiting: InboxItem[];
  /** Cards parked for want of a free body (decision 16): they resume by themselves, or the user downsizes. */
  parked: Proposal[];
  /** Open questions a supervisor holds (the user may still answer them). */
  heldBySupervisors: Question[];
  /** The latest questions a supervisor answered from context, newest first (decision 12). */
  answeredBySupervisors: Question[];
  /** Cards the user rejected; the Harmonizer may come back with a new one. */
  rejected: Proposal[];
}

/** How many supervisor-answered questions the inbox keeps visible. */
export const ANSWERED_SHOWN = 10;

const byCreated = <T extends { createdAt: string; id: string }>(a: T, b: T) =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/**
 * Within "waiting", permission questions come first (a Steward is stopped on a tool call), then
 * clarifications, then cards; each oldest first.
 */
function waitingRank(item: InboxItem): number {
  if (item.kind === 'proposal') return 2;
  return item.question.kind === 'permission' ? 0 : 1;
}

export function inboxModel(world: Pick<WorldState, 'questions' | 'proposals'>): InboxModel {
  const questions = Object.values(world.questions).sort(byCreated);
  const proposals = Object.values(world.proposals).sort(byCreated);
  const open = questions.filter((q) => q.status === 'open');
  const waiting: InboxItem[] = [
    ...open
      .filter((q) => q.holder.type === 'user')
      .map((question) => ({ kind: 'question' as const, question })),
    ...proposals
      .filter((p) => p.state === 'pending' || p.state === 'edited')
      .map((proposal) => ({ kind: 'proposal' as const, proposal })),
  ].sort((a, b) => {
    const rank = waitingRank(a) - waitingRank(b);
    if (rank !== 0) return rank;
    const x = a.kind === 'question' ? a.question : a.proposal;
    const y = b.kind === 'question' ? b.question : b.proposal;
    return byCreated(x, y);
  });
  return {
    waiting,
    parked: proposals.filter((p) => p.state === 'parked'),
    heldBySupervisors: open.filter((q) => q.holder.type !== 'user'),
    answeredBySupervisors: questions
      .filter((q) => q.status === 'answered' && q.answeredBy?.type === 'agent')
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(-ANSWERED_SHOWN)
      .reverse(),
    rejected: proposals.filter((p) => p.state === 'rejected'),
  };
}
