import { useState } from 'react';
import type { Id } from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import { AnsweredQuestionCard, QuestionCard, StaleBanner } from '../../panel/cards/index.js';

// The cards moved to `panel/cards` (P25-06); re-exported for the console's other pieces.
export { OriginContext, QuestionCard } from '../../panel/cards/index.js';

/**
 * The ops console's question inbox (P2-18; SPEC §2.6): questions for the user first, then the
 * open questions supervisors hold, then up to 10 a supervisor answered from context. A stale
 * refusal is kept here, worded from the folded world, so the message outlives the card.
 */

/** A refused answer, kept so the inbox can say who answered first even after the card left. */
interface Refusal {
  questionId: Id;
  message: string;
}

export function QuestionInbox() {
  const world = useAppStore((s) => s.world);
  const [refusals, setRefusals] = useState<Refusal[]>([]);
  const all = Object.values(world.questions).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const open = all.filter((q) => q.status === 'open');
  const mine = open.filter((q) => q.holder.type === 'user');
  const theirs = open.filter((q) => q.holder.type !== 'user');
  const bySupervisors = all
    .filter((q) => q.status === 'answered' && q.answeredBy?.type === 'agent')
    .slice(-10);
  const onStale = (questionId: Id, message: string) =>
    setRefusals((r) => [...r.filter((x) => x.questionId !== questionId), { questionId, message }]);

  return (
    <section className="inbox" aria-label="question inbox">
      <h3>Questions for you ({mine.length})</h3>
      {refusals.map((r) => (
        <StaleBanner
          key={r.questionId}
          questionId={r.questionId}
          message={r.message}
          onDismiss={() => setRefusals((all) => all.filter((x) => x !== r))}
        />
      ))}
      {mine.length === 0 && <p className="muted">Nothing waits for you.</p>}
      {mine.map((q) => (
        <QuestionCard key={q.id} question={q} onStale={onStale} />
      ))}
      {theirs.length > 0 && (
        <>
          <h4>Held by supervisors ({theirs.length})</h4>
          {theirs.map((q) => (
            <QuestionCard key={q.id} question={q} onStale={onStale} />
          ))}
        </>
      )}
      {bySupervisors.length > 0 && (
        <>
          <h4>Answered by supervisors</h4>
          {bySupervisors.map((q) => (
            <AnsweredQuestionCard key={q.id} question={q} />
          ))}
        </>
      )}
    </section>
  );
}
