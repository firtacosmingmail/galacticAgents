import type { ReactNode } from 'react';
import { proposalPlan, type Id, type Proposal, type Question } from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import { ProposalCard } from '../../console/hierarchy/ProposalCards.js';
import { QuestionCard } from '../../console/hierarchy/QuestionInbox.js';
import { actorLabel, StatePill } from '../../console/hierarchy/shared.js';

/**
 * The cards a brain posts in its thread (P25-03; decision 52), shown where they were created.
 * Deliberately thin: an open card is the shared card component itself — today P2-18's
 * `ProposalCard` (work and plan cards) and `QuestionCard`; P25-06 owns the cards — so a card
 * answered here or in the inbox is the same card, resolved in both places. A decided card folds
 * to one line in the thread; a rejected draft keeps the full card behind a toggle, since it can
 * still be edited and approved.
 */

const OPEN_PROPOSAL: ReadonlySet<Proposal['state']> = new Set(['pending', 'edited', 'parked']);

/**
 * A card in a thread, by id, read from the store as the stream updates it. `ThreadBody` is the
 * one place to swap the card implementation: P25-06's `ProposalView({proposalId})` /
 * `QuestionView({questionId})` (`panel/cards/`) take exactly these ids. The wrapper (its
 * `data-card`, which places the card in the thread) stays.
 */
export function ThreadCard({ kind, id }: { kind: 'proposal' | 'question'; id: Id }) {
  return (
    <div className="thread-card" data-card={id}>
      <ThreadBody kind={kind} id={id} />
    </div>
  );
}

function ThreadBody({ kind, id }: { kind: 'proposal' | 'question'; id: Id }): ReactNode {
  const proposal = useAppStore((s) => (kind === 'proposal' ? s.world.proposals[id] : undefined));
  const question = useAppStore((s) => (kind === 'question' ? s.world.questions[id] : undefined));
  if (proposal) return <InlineProposal proposal={proposal} />;
  if (question) return <InlineQuestion question={question} />;
  return null;
}

function proposalTitle(p: Proposal): string {
  return proposalPlan(p) ? 'Plan card' : 'Work card';
}

function InlineProposal({ proposal: p }: { proposal: Proposal }) {
  if (OPEN_PROPOSAL.has(p.state)) return <ProposalCard proposal={p} />;
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
      className={`thread-card-folded proposal-${p.state}`}
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
  if (q.status === 'open') return <QuestionCard question={q} />;
  return (
    <div className="thread-card-folded" aria-label={`${q.kind} question ${q.context.text}`}>
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
