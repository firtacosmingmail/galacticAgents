import type { Id, Question } from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import {
  cancelQueuedAnswer,
  dismissAnswerNotice,
  notSentLine,
  streamDown,
  submitAnswer,
  useAnswerQueue,
  type QueuedAnswer,
} from '../../client/answer-queue.js';
import { ErrorLine, useAction, useApi } from '../../console/hierarchy/shared.js';

/**
 * The offline-answer states on the cards (P7-05): a queued answer in place of the card's answer
 * controls ("will send when reconnected", with Cancel), and the outcome once the stream is back
 * ("sent", or "not sent: already answered by …"). Static: nothing here moves (reduced motion).
 * Screen readers hear the transitions through `AnswerQueueAnnouncer`, once, politely.
 */

/** The queue's entry for a question, if the user answered it on this device and it is pending. */
export function useQueuedAnswer(questionId: Id): QueuedAnswer | undefined {
  return useAnswerQueue((s) => s.entries[questionId]);
}

/** Whether the entry stands in for the answer controls (queued or on its way). */
export function isPending(entry: QueuedAnswer | undefined): boolean {
  return entry?.state === 'queued' || (entry?.state === 'sending' && entry.wasQueued === true);
}

/**
 * A queued answer in a card: what was answered, that it goes when the connection is back, and a
 * Cancel that gives the controls back (`onCancelled` puts the focus on them).
 */
export function QueuedAnswerBox({
  entry,
  onCancelled,
}: {
  entry: QueuedAnswer;
  onCancelled?: () => void;
}) {
  const sending = entry.state === 'sending';
  return (
    <div className="queued-answer" role="group" aria-label="queued answer">
      <p>
        <span className="pill queued-pill">{sending ? 'sending' : 'queued'}</span> Your answer “
        {entry.answer}” {sending ? <>is being sent…</> : <>will send when reconnected.</>}
      </p>
      {!sending && (
        <button
          type="button"
          className="secondary"
          onClick={() => {
            if (cancelQueuedAnswer(entry.questionId)) onCancelled?.();
          }}
        >
          Cancel queued answer
        </button>
      )}
    </div>
  );
}

/**
 * The outcome of an answer queued offline: "Sent" or "Not sent: …" with who answered first, a
 * Dismiss and — when the question is still open (it changed while offline) — "Send again" with
 * the question's current version.
 */
export function AnswerNotice({ entry }: { entry: QueuedAnswer }) {
  const world = useAppStore((s) => s.world);
  const api = useApi();
  const { run, error, busy } = useAction();
  const question: Question | undefined = world.questions[entry.questionId];
  if (entry.state === 'sent') {
    return (
      <p className="answer-notice is-sent">
        Sent: your answer “{entry.answer}” to “{entry.text}”.{' '}
        <button
          type="button"
          className="secondary"
          onClick={() => dismissAnswerNotice(entry.questionId)}
        >
          dismiss
        </button>
      </p>
    );
  }
  if (entry.state !== 'not_sent') return null;
  const open = question?.status === 'open';
  return (
    <div className="answer-notice is-not-sent">
      <p className="error">
        Not sent: your answer “{entry.answer}” to “{entry.text}” — {notSentLine(world, entry)}.
      </p>
      <div className="controls">
        {open && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                dismissAnswerNotice(entry.questionId);
                await submitAnswer(api, question, entry.answer);
              })
            }
          >
            Send again
          </button>
        )}
        <button
          type="button"
          className="secondary"
          onClick={() => dismissAnswerNotice(entry.questionId)}
        >
          dismiss
        </button>
      </div>
      <ErrorLine error={error} />
    </div>
  );
}

/** The notice of one question's queued answer, if it has an outcome to show. */
export function AnswerNoticeFor({ questionId }: { questionId: Id }) {
  const entry = useQueuedAnswer(questionId);
  return entry && !isPending(entry) ? <AnswerNotice entry={entry} /> : null;
}

/**
 * The queue's items no card shows (the inbox, P7-05): outcomes of questions that left the "open"
 * lists, and queued answers to questions the page does not hold yet (a reload while offline: the
 * world comes with the snapshot). `filter` narrows them (the Steward view: its own questions).
 */
export function OfflineAnswers({ filter }: { filter?: (e: QueuedAnswer) => boolean }) {
  const entries = useAnswerQueue((s) => s.entries);
  const questions = useAppStore((s) => s.world.questions);
  const shown = Object.values(entries)
    .filter((e) => questions[e.questionId]?.status !== 'open')
    .filter((e) => e.state !== 'sending' || e.wasQueued)
    .filter((e) => !filter || filter(e))
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
  if (shown.length === 0) return null;
  return (
    <section className="offline-answers" aria-label="answers given offline">
      {shown.map((e) =>
        isPending(e) ? (
          <QueuedAnswerBox key={e.answerId} entry={e} />
        ) : (
          <AnswerNotice key={e.answerId} entry={e} />
        ),
      )}
    </section>
  );
}

/**
 * Says the queue's transitions to screen readers (queued, cancelled, sent, not sent and why):
 * visually hidden, polite, once per change. One per page, next to the waiting-count announcer.
 */
export function AnswerQueueAnnouncer() {
  const announcement = useAnswerQueue((s) => s.announcement);
  return (
    <div className="pnl-visually-hidden" role="status" aria-live="polite" aria-atomic="true">
      {announcement ? <span key={announcement.n}>{announcement.text}</span> : null}
    </div>
  );
}

/** Whether the stream is down: card decisions are not queued (P7-05), so they wait for it. */
export function useStreamDown(): boolean {
  return useAppStore((s) => streamDown(s.status));
}

/** Said on a card while the stream is down: its decisions need the connection. */
export function OfflineDecisionNote() {
  return (
    <p className="muted offline-decision">
      Offline: decisions on cards are not queued — they wait for the connection. Answers to
      questions are queued.
    </p>
  );
}
