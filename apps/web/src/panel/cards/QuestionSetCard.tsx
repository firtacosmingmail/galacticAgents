import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  draftOf,
  questionSetRows,
  type Id,
  type Question,
  type SetAnswer,
} from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import { ApiError } from '../../console/api.js';
import { agentLabel, ErrorLine, useAction, useApi } from '../../console/hierarchy/shared.js';
import { submitSetAnswer } from '../../client/answer-queue.js';
import { StaleBanner } from './QuestionCard.js';
import {
  AnswerNoticeFor,
  isPending,
  QueuedAnswerBox,
  useQueuedAnswer,
  useStreamDown,
} from './QueuedAnswer.js';
import {
  canSend,
  draftKey,
  forDraft,
  isAnswered,
  isValid,
  pagesOf,
  resumeIndex,
  sendCount,
  serverDrafts,
  skipped,
  toAnswers,
  toggleChoice,
  viaAgentIds,
  type SetDrafts,
} from './question-set-model.js';
import { ProgressDots, QuestionPage, ReviewList, sendLabel } from './question-set-parts.js';

/**
 * The question-set card (P8-21, SPEC decision 141): several clarifications an agent asked at
 * once, one question per page — options (`aria-pressed`; several on a multi-select question) and
 * a write-in box, Back / Skip / Next — then a review page listing every answer, where a row jumps
 * back to its page, and one "Send N answers". The asker gets nothing until that send, then every
 * answer at once (one wake). Rows a supervisor answered from context are read-only on the review.
 *
 * Drafts live on the server (`meta.draft`) so a set started on the phone is finished on the
 * laptop: saved on Back / Skip / Next and 600 ms after typing stops; another device's saved draft
 * replaces a row's local value unless that row is the one shown. The send goes through the
 * answer queue (P7-05: offline it waits and is retried with the same key); a `stale` refusal says
 * who answered which row first, and the card keeps the other answers. × dismisses the whole set.
 * A chat reply never answers a set: the thread shows no Reply on this card.
 */

/** How long typing must pause before the draft is saved. */
export const DRAFT_SAVE_MS = 600;

const REVIEW = 'review';
type Page = Id | typeof REVIEW;

/** The server's draft of each row, as comparable keys. */
const keysOf = (rows: Question[]): Record<Id, string> =>
  Object.fromEntries(rows.map((q) => [q.id, draftKey(draftOf(q))]));

/** The row a refusal names ("question q-2 was already answered by …"). */
const namedRow = (rows: Question[], message: string): Question | undefined => {
  const id = /question (\S+)/.exec(message)?.[1];
  return rows.find((q) => q.id === id);
};

export function QuestionSetCard({ setId }: { setId: Id }) {
  const api = useApi();
  const world = useAppStore((s) => s.world);
  const offline = useStreamDown();
  const questions = world.questions;
  const rows = useMemo(() => questionSetRows({ questions }, setId), [questions, setId]);
  const { asking } = pagesOf(rows);
  const [drafts, setDrafts] = useState<SetDrafts>(() => serverDrafts(rows));
  const [page, setPage] = useState<Page>(() => {
    const i = resumeIndex(rows, serverDrafts(rows));
    return pagesOf(rows).asking[i]?.id ?? REVIEW;
  });
  const [stale, setStale] = useState<{ questionId: Id; message: string } | undefined>();
  /** Rows the user changed here: only those are saved (viewing a row overwrites nothing). */
  const [dirty, setDirty] = useState<Record<Id, true>>({});
  const [confirming, setConfirming] = useState(false);
  const { run, error, busy, clear } = useAction();
  const dismissal = useAction();
  const queued = useQueuedAnswer(setId);
  const article = useRef<HTMLElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);

  // The page shown: a row that left meanwhile (answered elsewhere) gives way to the next one.
  let index = page === REVIEW ? asking.length : asking.findIndex((q) => q.id === page);
  if (index === -1) {
    const gone = rows.find((q) => q.id === page)?.context.set?.index ?? -1;
    index = asking.findIndex((q) => (q.context.set?.index ?? 0) > gone);
    if (index === -1) index = asking.length;
  }
  const current: Question | undefined = asking[index];

  // Another device saved a draft (the stream brings `meta.draft`): it replaces the local value,
  // except on the row being edited here right now. Adjusted while rendering, as the rows change.
  const [seenRows, setSeenRows] = useState(rows);
  const [seen, setSeen] = useState<Record<Id, string>>(() => keysOf(rows));
  if (rows !== seenRows) {
    setSeenRows(rows);
    const server = serverDrafts(rows);
    const nextSeen = { ...seen };
    const updates: SetDrafts = {};
    for (const q of rows) {
      if (q.status !== 'open') continue;
      const key = draftKey(server[q.id]);
      if (seen[q.id] === key) continue;
      nextSeen[q.id] = key;
      if (!(q.id === current?.id && dirty[q.id])) updates[q.id] = server[q.id];
    }
    setSeen(nextSeen);
    const replaced = Object.keys(updates);
    if (replaced.length > 0) {
      setDrafts((d) => ({ ...d, ...updates }));
      // Taken from the server: no longer this device's edit to save.
      setDirty((d) =>
        Object.fromEntries(Object.entries(d).filter(([id]) => !replaced.includes(id))),
      );
    }
  }

  // Saving drafts: only rows the user edited here and holds, and only a value the server does
  // not have yet (nor was just sent). Offline nothing is saved; when the stream is back, every
  // edited row the server does not have is saved (answers typed offline outlive the tab).
  const latest = useRef({ rows, offline, api, drafts, dirty });
  useLayoutEffect(() => {
    latest.current = { rows, offline, api, drafts, dirty };
  });
  const sent = useRef<Record<Id, { key: string; server: string }>>({});
  const save = (rowId: Id, value: SetAnswer | undefined) => {
    const { rows, offline, api } = latest.current;
    const q = rows.find((r) => r.id === rowId);
    if (!q || q.status !== 'open' || q.holder.type !== 'user' || offline) return;
    const key = draftKey(value);
    const server = draftKey(draftOf(q));
    const last = sent.current[rowId];
    // A send the server has not echoed yet still counts; once the server changed, it is the truth.
    if (key === (last && last.server === server ? last.key : server)) return;
    const mine = { key, server };
    sent.current[rowId] = mine;
    api.draftQuestion(rowId, isAnswered(value) ? forDraft(value) : null).then(
      () => {
        // Saved: unless it was changed again since, the row is no longer this device's edit, so
        // another device's later draft replaces it and navigating away re-saves nothing.
        if (draftKey(latest.current.drafts[rowId]) !== key) return;
        setDirty((d) => {
          if (!d[rowId]) return d;
          const { [rowId]: _saved, ...rest } = d;
          return rest;
        });
      },
      () => {
        // Not kept: the next change (or navigation) tries again.
        if (sent.current[rowId] === mine) delete sent.current[rowId];
      },
    );
  };
  const wasOffline = useRef(offline);
  useEffect(() => {
    const back = wasOffline.current && !offline;
    wasOffline.current = offline;
    if (!back) return;
    const { rows, drafts, dirty } = latest.current;
    for (const q of rows) if (dirty[q.id]) save(q.id, drafts[q.id]);
  }, [offline]);
  const timer = useRef<{ rowId: Id; value: SetAnswer; t: ReturnType<typeof setTimeout> }>(
    undefined,
  );
  const cancelTimer = () => {
    if (timer.current) clearTimeout(timer.current.t);
    timer.current = undefined;
  };
  useEffect(
    () => () => {
      // Leaving with a change not saved yet: save it now.
      const pending = timer.current;
      cancelTimer();
      if (pending) save(pending.rowId, pending.value);
    },
    [],
  );

  const change = (q: Question, value: SetAnswer) => {
    setDrafts((d) => ({ ...d, [q.id]: value }));
    setDirty((d) => ({ ...d, [q.id]: true }));
    cancelTimer();
    timer.current = { rowId: q.id, value, t: setTimeout(() => save(q.id, value), DRAFT_SAVE_MS) };
  };
  const go = (to: Page, from?: Question, value?: SetAnswer) => {
    cancelTimer();
    if (from && (value !== undefined || dirty[from.id])) save(from.id, value ?? drafts[from.id]);
    setPage(to);
    requestAnimationFrame(() =>
      (to === REVIEW
        ? article.current?.querySelector<HTMLElement>('.qset-review')
        : pageRef.current
      )?.focus(),
    );
  };
  const pageAfter = (i: number): Page => asking[i + 1]?.id ?? REVIEW;

  const send = async () => {
    setStale(undefined);
    let refused: string | undefined;
    const answers = toAnswers(asking, drafts);
    const ok = await run(async () => {
      try {
        await submitSetAnswer(api, setId, rows[0]?.context.set?.title ?? '', answers);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'stale') refused = e.message;
        throw e;
      }
    });
    if (!ok && refused !== undefined) {
      clear();
      const row = namedRow(latest.current.rows, refused) ?? asking[0];
      if (row) setStale({ questionId: row.id, message: refused });
    }
  };
  const dismiss = () => {
    setConfirming(false);
    void dismissal.run(() => api.dismissSet(setId));
  };
  const askDismiss = () => {
    setConfirming(true);
    requestAnimationFrame(() =>
      article.current?.querySelector<HTMLElement>('.qset-confirm button')?.focus(),
    );
  };

  const first = rows[0];
  if (!first) return null;
  const title = first.context.set?.title ?? '';
  const asker = agentLabel(world.agents[first.originAgentId], world);
  const via = viaAgentIds(rows, world.agents).map((id) => agentLabel(world.agents[id], world));
  const pending = queued !== undefined && isPending(queued);
  const done = asking.length === 0;
  const count = done ? rows.length : asking.length;
  const pill = done
    ? rows.every((q) => q.status === 'cancelled')
      ? 'Withdrawn'
      : 'Answered'
    : current
      ? `${index + 1} of ${asking.length}`
      : 'Review';
  const supervisorHeld = !done && asking.every((q) => q.holder.type !== 'user');

  return (
    <article
      ref={article}
      className="card question question-set"
      aria-label={`question set ${title}, ${count} questions`}
      data-set-id={setId}
      // Its rows' ids, so a beacon of the set finds this card (P8-22, `inboxCard`).
      data-question-ids={rows.map((r) => r.id).join(' ')}
    >
      <header>
        <span className="qset-asker">
          {asker} · {title}
        </span>
        {via.length > 0 && <span className="muted qset-via">via {via.join(', ')}</span>}
        <span className="muted qset-count">{count} questions</span>
        <span className="pill qset-pill">{pill}</span>
        {!done && !pending && (
          <button
            type="button"
            className="secondary card-dismiss"
            aria-label={`Dismiss the question set, no reply: ${title}`}
            title={
              offline
                ? 'Dismissing needs the connection'
                : 'Dismiss every question of the set: the agent is told you will not answer'
            }
            disabled={dismissal.busy || offline}
            onClick={askDismiss}
          >
            <span aria-hidden="true">×</span>
          </button>
        )}
        {dismissal.error && (
          <span className="error card-dismiss-error" role="alert">
            {dismissal.error}
          </span>
        )}
      </header>
      {confirming && !done && (
        // Up to ten rows and their saved drafts go: one confirmation (P8-21 review).
        <div className="qset-confirm" role="group" aria-label="confirm dismissal">
          <p>Dismiss these {asking.length} questions? Your answers so far are discarded.</p>
          <div className="qset-nav">
            <button type="button" className="danger" disabled={offline} onClick={dismiss}>
              Dismiss {asking.length} questions
            </button>
            <button type="button" className="secondary" onClick={() => setConfirming(false)}>
              Keep them
            </button>
          </div>
        </div>
      )}
      {supervisorHeld && (
        <p className="muted">
          Its supervisor may answer these from context; you can answer them yourself instead.
        </p>
      )}
      {!done && <ProgressDots asking={asking} drafts={drafts} current={index} />}
      {done ? (
        <ReviewList rows={rows} drafts={drafts} world={world} />
      ) : pending ? (
        <QueuedAnswerBox
          entry={queued}
          onCancelled={() =>
            requestAnimationFrame(() =>
              article.current?.querySelector<HTMLElement>('.qset-send')?.focus(),
            )
          }
        />
      ) : current ? (
        <QuestionPage
          question={current}
          draft={drafts[current.id]}
          first={index === 0}
          canNext={isValid(current, drafts[current.id])}
          busy={busy}
          pageRef={pageRef}
          onChoose={(o) => change(current, toggleChoice(current, drafts[current.id], o))}
          onWrite={(text) => change(current, { choices: drafts[current.id]?.choices ?? [], text })}
          onBack={() => go(asking[index - 1]!.id, current)}
          onSkip={() => {
            // The typed answer stays in the draft, marked skipped: the skip wins on send.
            const value = skipped(drafts[current.id]);
            setDrafts((d) => ({ ...d, [current.id]: value }));
            setDirty((d) => ({ ...d, [current.id]: true }));
            go(pageAfter(index), current, value);
          }}
          onNext={() => go(pageAfter(index), current)}
        />
      ) : (
        <>
          <ReviewList rows={rows} drafts={drafts} world={world} onJump={(q) => go(q.id)} />
          <div className="qset-nav">
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => go(asking[asking.length - 1]!.id)}
            >
              <span aria-hidden="true">← </span>Back
            </button>
            <button
              type="button"
              className="qset-send"
              disabled={busy || !canSend(asking, drafts)}
              onClick={() => void send()}
            >
              {sendLabel(sendCount(asking, drafts))}
            </button>
          </div>
        </>
      )}
      <AnswerNoticeFor questionId={setId} />
      {stale !== undefined ? (
        <StaleBanner
          questionId={stale.questionId}
          message={stale.message}
          onDismiss={() => setStale(undefined)}
        />
      ) : (
        <ErrorLine error={error} />
      )}
    </article>
  );
}
