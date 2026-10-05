import { useState, type ReactNode } from 'react';
import type { Id } from '@galactic/protocol';
import { useAppStore } from '../state/store.js';
import { AnsweredQuestionCard, ProposalCard, QuestionCard, StaleBanner } from './cards/index.js';
import { inboxModel, waitingForUserCount, type InboxItem } from './inbox-model.js';
import { Beacon } from './Navigation.js';
import { OfflineAnswers } from './cards/QueuedAnswer.js';
import './inbox.css';

/**
 * The panel's inbox (P25-06, SPEC §4.2): what waits for the user first — open questions they hold
 * (permissions, then clarifications) and the cards waiting for a decision — then parked cards,
 * questions supervisors hold, and the questions supervisors answered from context (read-only,
 * with Override). Everything is the store's (TECHNOLOGY §6.3): an answer or a decision made here,
 * in a chat thread or on the Steward view resolves the item everywhere once the stream says so.
 */

/** A refused answer, kept so the inbox can say who answered first even after the card left. */
interface Refusal {
  questionId: Id;
  message: string;
}

export function Inbox({ onHide }: { onHide?: () => void } = {}) {
  const world = useAppStore((s) => s.world);
  const [refusals, setRefusals] = useState<Refusal[]>([]);
  const model = inboxModel(world);
  const onStale = (questionId: Id, message: string) =>
    setRefusals((r) => [...r.filter((x) => x.questionId !== questionId), { questionId, message }]);
  const count = waitingForUserCount(world);

  return (
    <section className="pnl-inbox-list" aria-label="question inbox">
      <div className="pnl-side-head">
        <h2 className="pnl-eyebrow pnl-inbox-head">
          Inbox {count > 0 ? <Beacon>{count} waiting for you</Beacon> : null}
        </h2>
        {onHide && (
          // P4-12: hidden per browser; the top bar's "Show inbox" or "N waiting" brings it back.
          <button
            type="button"
            className="pnl-side-hide"
            aria-label="Hide inbox"
            title="Hide the inbox (bring it back from the top bar)"
            onClick={onHide}
          >
            Hide
          </button>
        )}
      </div>
      {/* Answers given offline whose card is gone or not loaded yet (P7-05). */}
      <OfflineAnswers />
      {refusals.map((r) => (
        <StaleBanner
          key={r.questionId}
          questionId={r.questionId}
          message={r.message}
          onDismiss={() => setRefusals((all) => all.filter((x) => x !== r))}
        />
      ))}
      <Group label="Waiting for you" items={model.waiting.length} blocked>
        {count === 0 ? (
          <p className="pnl-empty">Nothing waits for you.</p>
        ) : (
          model.waiting.map((item) => <Item key={itemKey(item)} item={item} onStale={onStale} />)
        )}
      </Group>
      {model.parked.length > 0 && (
        <Group label="Parked — no free body" items={model.parked.length}>
          {model.parked.map((p) => (
            <ProposalCard key={p.id} proposal={p} />
          ))}
        </Group>
      )}
      {model.heldBySupervisors.length > 0 && (
        <Group label="Held by supervisors" items={model.heldBySupervisors.length}>
          {model.heldBySupervisors.map((q) => (
            <QuestionCard key={q.id} question={q} onStale={onStale} />
          ))}
        </Group>
      )}
      {model.answeredBySupervisors.length > 0 && (
        <Group label="Answered by supervisors" items={model.answeredBySupervisors.length}>
          {model.answeredBySupervisors.map((q) => (
            <AnsweredQuestionCard key={q.id} question={q} />
          ))}
        </Group>
      )}
      {model.rejected.length > 0 && (
        <details className="pnl-inbox-drafts">
          <summary>Rejected cards ({model.rejected.length})</summary>
          {model.rejected.map((p) => (
            <ProposalCard key={p.id} proposal={p} />
          ))}
        </details>
      )}
    </section>
  );
}

const itemKey = (item: InboxItem) =>
  item.kind === 'question' ? `q:${item.question.id}` : `p:${item.proposal.id}`;

function Item({
  item,
  onStale,
}: {
  item: InboxItem;
  onStale: (questionId: Id, message: string) => void;
}) {
  return item.kind === 'question' ? (
    <QuestionCard question={item.question} onStale={onStale} />
  ) : (
    <ProposalCard proposal={item.proposal} />
  );
}

function Group({
  label,
  items,
  blocked = false,
  children,
}: {
  label: string;
  items: number;
  blocked?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className={`pnl-inbox-group${blocked && items > 0 ? ' is-blocked' : ''}`}
      aria-label={label}
    >
      <h3>
        {label} ({items})
      </h3>
      {children}
    </section>
  );
}
