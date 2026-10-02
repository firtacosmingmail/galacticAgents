import type { Id } from '@galactic/protocol';
import { ProposalView, QuestionView } from '../cards/index.js';

/**
 * The cards a brain posts in its thread (P25-03; decision 52), shown where they were created.
 * An inline card is the shared card itself (P25-06's `ProposalView` / `QuestionView`), so a card
 * answered here or in the inbox is the same card, resolved in both places; a decided card shows
 * its compact form (approved, answered, withdrawn) from the same components.
 */
export function ThreadCard({ kind, id }: { kind: 'proposal' | 'question'; id: Id }) {
  return (
    <div className="thread-card" data-card={id}>
      {kind === 'proposal' ? <ProposalView proposalId={id} /> : <QuestionView questionId={id} />}
    </div>
  );
}
