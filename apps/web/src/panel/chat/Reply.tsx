import {
  excerpt,
  proposalPlan,
  type Actor,
  type Id,
  type ReplyQuote,
  type ReplyRef,
} from '@galactic/protocol';
import { agentLabel } from '../../console/hierarchy/shared.js';
import { newAnswerId } from '../../client/answer-queue.js';
import type { ChatEntry, ReplyDraft, ThreadCardItem } from '../../state/conversation.js';
import type { WorldState } from '../../state/reduce.js';

/**
 * Replies in the chat (P8-17; SPEC decision 139), as in a messaging app: every line and card of
 * the thread offers **Reply**; the composer then shows what it quotes (who, an excerpt, ×; Esc
 * cancels) and the sent message shows the quote above its text. The quote is a button: it scrolls
 * to the original (paging back as needed) and highlights it, or says it is no longer in the
 * history. No sub-thread. The server resolves the quote from the log (`message.sent.replyTo`);
 * the draft's text here only fills the quote bar.
 */

/** How many characters of a quote the composer's bar and a sent message show (CSS clamps too). */
export const QUOTE_SHOWN = 240;

type Who = Pick<WorldState, 'agents' | 'projects' | 'tasks'>;

/** Who wrote a quoted line, as the chat names them. */
export function quoteSender(sender: Actor, agentId: Id, name: string, world: Who): string {
  if (sender.type === 'user') return 'You';
  if (sender.type === 'system') return 'System';
  if (!sender.id) return 'An agent';
  if (sender.id === agentId) return name;
  return agentLabel(world.agents[sender.id], world);
}

const KIND_LABEL: Record<ReplyQuote['kind'], string> = {
  message: '',
  reply: '',
  question: 'question',
  proposal: 'proposal',
};

/** "Harmonizer", "Steward · x · question"… */
export function quoteTitle(
  q: Pick<ReplyQuote, 'kind' | 'sender'>,
  agentId: Id,
  name: string,
  world: Who,
) {
  const who = quoteSender(q.sender, agentId, name, world);
  return KIND_LABEL[q.kind] ? `${who} · ${KIND_LABEL[q.kind]}` : who;
}

/** The reply draft for a line of the thread. */
export function draftOfEntry(e: ChatEntry): ReplyDraft {
  return {
    kind: e.kind === 'reply' ? 'reply' : 'message',
    id: e.kind === 'reply' ? e.id : (e.messageId ?? e.id.replace(/^m:/, '')),
    sender: e.sender,
    text: e.text,
    answerId: newAnswerId(),
  };
}

/** The reply draft for a card of the thread. */
export function draftOfCard(
  card: Exclude<ThreadCardItem, { kind: 'questionSet' }>,
  agentId: Id,
): ReplyDraft {
  if (card.kind === 'question') {
    return {
      kind: 'question',
      id: card.id,
      sender: { type: 'agent', id: card.question.originAgentId },
      text: card.question.context.text,
      answerId: newAnswerId(),
    };
  }
  return {
    kind: 'proposal',
    id: card.id,
    sender: { type: 'agent', id: proposalPlan(card.proposal)?.waykeeperId ?? agentId },
    text: card.proposal.requestText,
    answerId: newAnswerId(),
  };
}

/**
 * What the send carries: the target, and for a clarification still open the card's version and
 * the draft's idempotency key — the reply answers it, as the card's answer button would (P7-05).
 * A clarification this very draft answered already (its `answerId` is on the row: an earlier try
 * whose message was not acknowledged) is sent the same way, so the server returns that message or
 * completes it rather than logging a plain reply (P8-17 review).
 */
export function replyRef(draft: ReplyDraft, world: Pick<WorldState, 'questions'>): ReplyRef {
  const ref: ReplyRef = { kind: draft.kind, id: draft.id };
  if (draft.kind !== 'question') return ref;
  const q = world.questions[draft.id];
  if (
    q?.kind === 'clarification' &&
    (q.status === 'open' || (q.status === 'answered' && q.meta?.['answerId'] === draft.answerId))
  ) {
    ref.version = q.version;
    ref.answerId = draft.answerId;
  }
  return ref;
}

/** The thread's element for a quoted target: a line (`data-entry`) or a card (`data-card`). */
export function locate(root: HTMLElement | null, q: Pick<ReplyQuote, 'kind' | 'id'>) {
  if (!root) return undefined;
  if (q.kind === 'question' || q.kind === 'proposal') {
    for (const el of root.querySelectorAll<HTMLElement>('[data-card]')) {
      if (el.dataset['card'] === q.id) return el;
    }
    return undefined;
  }
  const entryId = q.kind === 'message' ? `m:${q.id}` : q.id;
  for (const el of root.querySelectorAll<HTMLElement>('[data-entry]')) {
    if (el.dataset['entry'] === entryId) return el;
  }
  return undefined;
}

/** The small Reply action of a line or card: revealed on hover/focus, always shown on touch. */
export function ReplyButton({ label, onReply }: { label: string; onReply: () => void }) {
  return (
    <button
      type="button"
      className="pnl-reply"
      aria-label={`Reply to ${label}`}
      title="Reply"
      onClick={onReply}
    >
      <span aria-hidden="true">↩</span>
      <span className="pnl-reply-label">Reply</span>
    </button>
  );
}

/**
 * The quote above a sent message: a coloured side bar, who wrote it, a few lines of it, and
 * "answered" when the reply answered that question. Activating it jumps to the original.
 */
export function QuoteBlock({
  quote,
  title,
  missing,
  onJump,
}: {
  quote: Pick<ReplyQuote, 'kind' | 'text' | 'answered'>;
  title: string;
  missing?: boolean;
  onJump?: () => void;
}) {
  const text = excerpt(quote.text, QUOTE_SHOWN);
  return (
    <>
      <button
        type="button"
        className="pnl-quote"
        onClick={onJump}
        aria-label={`Quoted ${title}: ${text}. Show the original`}
      >
        <span className="pnl-quote-who">
          {title}
          {quote.answered && <span className="pnl-quote-answered"> · answered</span>}
        </span>
        <span className="pnl-quote-text">{text}</span>
      </button>
      {missing && (
        <span className="pnl-quote-missing muted" role="status">
          The original is no longer in the history.
        </span>
      )}
    </>
  );
}

/** The composer's quote bar: what the message will reply to, with × to cancel (Esc too). */
export function ReplyBar({
  draft,
  title,
  note,
  onCancel,
}: {
  draft: ReplyDraft;
  title: string;
  note?: string | undefined;
  onCancel: () => void;
}) {
  return (
    <div className="pnl-replying" role="group" aria-label="replying to">
      <div className="pnl-replying-quote">
        <span className="pnl-quote-who">Replying to {title}</span>
        <span className="pnl-quote-text">{excerpt(draft.text, QUOTE_SHOWN)}</span>
        {note && <span className="pnl-replying-note muted">{note}</span>}
      </div>
      <button
        type="button"
        className="pnl-replying-cancel secondary"
        aria-label="Cancel the reply"
        title="Cancel the reply (Esc)"
        onClick={onCancel}
      >
        ×
      </button>
    </div>
  );
}
