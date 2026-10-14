import type { Id } from '@galactic/protocol';
import { ProposalView, QuestionView } from '../cards/index.js';
import { ReplyButton } from './Reply.js';

/**
 * The cards a brain posts in its thread (P25-03; decisions 52, 55), shown where they were created.
 * An inline card is the shared card itself (P25-06's `ProposalView` / `QuestionView`), so a card
 * answered here or in the inbox is the same card, resolved in both places; a decided card shows
 * its compact form (approved, answered, withdrawn) from the same components.
 */
export function ThreadCard({
  kind,
  id,
  onReply,
  replyLabel,
}: {
  kind: 'proposal' | 'question';
  id: Id;
  /** The card's Reply action (P8-17): the composer quotes it. */
  onReply?: () => void;
  replyLabel?: string;
}) {
  return (
    <div className="thread-card" data-card={id} tabIndex={-1}>
      {kind === 'proposal' ? <ProposalView proposalId={id} /> : <QuestionView questionId={id} />}
      {onReply && <ReplyButton label={replyLabel ?? `the ${kind}`} onReply={onReply} />}
    </div>
  );
}
