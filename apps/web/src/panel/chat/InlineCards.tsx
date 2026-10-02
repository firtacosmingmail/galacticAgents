import { proposalPlan, type Proposal, type Question } from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import type { ThreadCard } from '../../state/conversation.js';
import { ProposalCard } from '../../console/hierarchy/ProposalCards.js';
import { QuestionCard } from '../../console/hierarchy/QuestionInbox.js';
import { actorLabel, StatePill } from '../../console/hierarchy/shared.js';

/**
 * The cards a brain posts in its thread (P25-03; decision 52), shown where they were created.
 * Deliberately thin: an open card is the shared card component itself — today P2-18's
 * `ProposalCard` (work and plan cards) and `QuestionCard`, which P25-06 owns and may replace —
 * so a card answered here or in the inbox is the same card, resolved in both places. A decided
 * card folds to one line in the thread; a rejected draft keeps the full card behind a toggle,
 * since it can still be edited and approved.
 */

const OPEN_PROPOSAL: ReadonlySet<Proposal['state']> = new Set(['pending', 'edited', 'parked']);

export function InlineCard({ card }: { card: ThreadCard }) {
  return card.kind === 'proposal' ? (
    <InlineProposal proposal={card.proposal} />
  ) : (
    <InlineQuestion question={card.question} />
  );
}

function proposalTitle(p: Proposal): string {
  return proposalPlan(p) ? 'Plan card' : 'Work card';
}

function InlineProposal({ proposal: p }: { proposal: Proposal }) {
  if (OPEN_PROPOSAL.has(p.state)) {
    return (
      <div className="thread-card" data-card={p.id}>
        <ProposalCard proposal={p} />
      </div>
    );
  }
  const outcome = p.meta?.['carriedOut'] as { ok?: boolean; error?: string } | undefined;
  const tail =
    outcome === undefined
      ? ''
      : outcome.ok
        ? ' · carried out'
        : ` · failed: ${outcome.error ?? 'unknown'}`;
  const line = (
    <>
      <StatePill state={p.state} /> <strong>{proposalTitle(p)}</strong> {p.requestText}
      <span className="muted">{tail}</span>
    </>
  );
  return (
    <div
      className={`thread-card thread-card-folded proposal-${p.state}`}
      data-card={p.id}
      aria-label={`${proposalTitle(p).toLowerCase()} ${p.requestText}`}
    >
      {p.state === 'rejected' ? (
        <details>
          <summary>{line}</summary>
          <ProposalCard proposal={p} />
        </details>
      ) : (
        <p>{line}</p>
      )}
    </div>
  );
}

function InlineQuestion({ question: q }: { question: Question }) {
  const world = useAppStore((s) => s.world);
  if (q.status === 'open') {
    return (
      <div className="thread-card" data-card={q.id}>
        <QuestionCard question={q} />
      </div>
    );
  }
  return (
    <div
      className="thread-card thread-card-folded"
      data-card={q.id}
      aria-label={`${q.kind} question ${q.context.text}`}
    >
      <p>
        <span className={`pill kind-${q.kind}`}>{q.kind}</span> {q.context.text}{' '}
        <span className="muted">
          {q.status === 'answered'
            ? `— answered by ${actorLabel(q.answeredBy, world)}${q.answer ? `: "${q.answer}"` : ''}`
            : `— ${q.status}`}
        </span>
      </p>
    </div>
  );
}
