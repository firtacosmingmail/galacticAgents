import type { Id, Proposal, Question } from '@galactic/protocol';
import type { WorldState } from '../state/reduce.js';

/**
 * The panel inbox's content (P25-06), as a pure model: every open question and every card the
 * user may act on, in the order the panel shows them. "Blocked on user" is the loudest state
 * (Phase 2.5 design notes), so what waits for the user comes first. A question set's rows
 * (P8-21, SPEC decision 141) are one item: one card, counted once.
 */

export type InboxItem =
  | { kind: 'question'; question: Question }
  | { kind: 'proposal'; proposal: Proposal }
  /** A question set: its open rows the user holds, in the asker's order. */
  | { kind: 'questionSet'; setId: Id; questions: Question[] };

export interface InboxModel {
  /** Blocked on the user: open questions they hold, and cards waiting for their decision. */
  waiting: InboxItem[];
  /** Cards parked for want of a free body (decision 16): they resume by themselves, or the user downsizes. */
  parked: Proposal[];
  /** Open questions a supervisor holds (the user may still answer them); not set rows. */
  heldBySupervisors: Question[];
  /** Question sets whose open rows a supervisor holds, one entry per set (P8-21). */
  setsHeldBySupervisors: Id[];
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
  if (item.kind === 'questionSet') return 1; // clarifications only
  return item.question.kind === 'permission' ? 0 : 1;
}

/** What orders an item among its rank: its (first) question or its card. */
const sortKeyOf = (item: InboxItem) =>
  item.kind === 'question'
    ? item.question
    : item.kind === 'proposal'
      ? item.proposal
      : item.questions[0]!;

/** Open questions, each set's rows gathered into one item at the place of its first row. */
function groupSets(open: Question[]): InboxItem[] {
  const items: InboxItem[] = [];
  const sets = new Map<Id, Question[]>();
  for (const question of open) {
    const set = question.context.set;
    if (!set) {
      items.push({ kind: 'question', question });
      continue;
    }
    const rows = sets.get(set.id);
    if (rows) rows.push(question);
    else {
      const first = [question];
      sets.set(set.id, first);
      items.push({ kind: 'questionSet', setId: set.id, questions: first });
    }
  }
  for (const rows of sets.values()) {
    rows.sort((a, b) => (a.context.set?.index ?? 0) - (b.context.set?.index ?? 0));
  }
  return items;
}

/** The ids of the sets among `questions`, once each, in order. */
const setIdsOf = (questions: Question[]): Id[] => [
  ...new Set(questions.flatMap((q) => (q.context.set ? [q.context.set.id] : []))),
];

export function inboxModel(world: Pick<WorldState, 'questions' | 'proposals'>): InboxModel {
  const questions = Object.values(world.questions).sort(byCreated);
  const proposals = Object.values(world.proposals).sort(byCreated);
  const open = questions.filter((q) => q.status === 'open');
  const supervisorHeld = open.filter((q) => q.holder.type !== 'user');
  const waiting: InboxItem[] = [
    ...groupSets(open.filter((q) => q.holder.type === 'user')),
    ...proposals
      .filter((p) => p.state === 'pending' || p.state === 'edited')
      .map((proposal) => ({ kind: 'proposal' as const, proposal })),
  ].sort((a, b) => {
    const rank = waitingRank(a) - waitingRank(b);
    if (rank !== 0) return rank;
    return byCreated(sortKeyOf(a), sortKeyOf(b));
  });
  return {
    waiting,
    parked: proposals.filter((p) => p.state === 'parked'),
    heldBySupervisors: supervisorHeld.filter((q) => !q.context.set),
    setsHeldBySupervisors: setIdsOf(supervisorHeld),
    answeredBySupervisors: questions
      .filter((q) => q.status === 'answered' && q.answeredBy?.type === 'agent')
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(-ANSWERED_SHOWN)
      .reverse(),
    rejected: proposals.filter((p) => p.state === 'rejected'),
  };
}

/**
 * How many things wait for the user: the open questions they hold and the cards waiting for
 * their decision (pending or edited) — the inbox's "Waiting for you" group. A question set counts
 * once (P8-21). The top bar and the inbox header both show this one number, so they always agree.
 */
export function waitingForUserCount(world: Pick<WorldState, 'questions' | 'proposals'>): number {
  let n = 0;
  const sets = new Set<Id>();
  for (const q of Object.values(world.questions)) {
    if (q.status !== 'open' || q.holder.type !== 'user') continue;
    if (!q.context.set) n++;
    else sets.add(q.context.set.id);
  }
  n += sets.size;
  for (const p of Object.values(world.proposals))
    if (p.state === 'pending' || p.state === 'edited') n++;
  return n;
}
