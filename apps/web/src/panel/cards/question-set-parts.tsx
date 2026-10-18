import type { ReactNode, RefObject } from 'react';
import { renderSetAnswer, type Question, type SetAnswer } from '@galactic/protocol';
import { actorLabel } from '../../console/hierarchy/shared.js';
import type { WorldState } from '../../state/reduce.js';
import { isAnswered, normalised, type SetDrafts } from './question-set-model.js';

/**
 * The question-set card's presentational pieces (P8-21): progress dots, one question's page and
 * the review list. The state lives in `QuestionSetCard`; these only render it and call back.
 */

type World = Pick<WorldState, 'agents' | 'projects' | 'tasks'>;

const numberOf = (q: Question) => (q.context.set?.index ?? 0) + 1;

/** One dot per question to answer: answered, skipped, the current one, or still to do. */
export function ProgressDots({
  asking,
  drafts,
  current,
}: {
  asking: Question[];
  drafts: SetDrafts;
  current: number;
}) {
  return (
    <ol className="qset-dots" aria-label="progress">
      {asking.map((q, i) => {
        const d = drafts[q.id];
        const state =
          i === current
            ? 'current'
            : d?.skipped
              ? 'skipped'
              : isAnswered(d)
                ? 'answered'
                : undefined;
        return (
          <li key={q.id} className={`qset-dot${state ? ` is-${state}` : ''}`}>
            <span className="pnl-visually-hidden">
              Question {i + 1}: {state === 'current' ? 'shown' : (state ?? 'not answered yet')}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** One question: its options (pressed or not) and the write-in box, with Back / Skip / Next. */
export function QuestionPage({
  question: q,
  draft,
  first,
  canNext,
  busy,
  pageRef,
  onChoose,
  onWrite,
  onBack,
  onSkip,
  onNext,
}: {
  question: Question;
  draft: SetAnswer | undefined;
  first: boolean;
  canNext: boolean;
  busy: boolean;
  pageRef: RefObject<HTMLDivElement | null>;
  onChoose: (option: string) => void;
  onWrite: (text: string) => void;
  onBack: () => void;
  onSkip: () => void;
  onNext: () => void;
}) {
  const textId = `qset-text-${q.id}`;
  return (
    <div className="qset-page" ref={pageRef} tabIndex={-1} role="group" aria-labelledby={textId}>
      <p className="qset-text" id={textId}>
        {q.context.text}
      </p>
      {q.context.multiSelect && <p className="muted qset-hint">Choose any that apply.</p>}
      {(q.context.options?.length ?? 0) > 0 && (
        <div className="qset-options" role="group" aria-labelledby={textId}>
          {q.context.options!.map((o) => (
            <button
              type="button"
              key={o}
              className="qset-option"
              aria-pressed={draft?.choices.includes(o) === true}
              disabled={busy}
              onClick={() => onChoose(o)}
            >
              {o}
            </button>
          ))}
        </div>
      )}
      <input
        className="qset-write"
        aria-label="Or write your own answer"
        placeholder="Or write your own answer…"
        value={draft?.text ?? ''}
        disabled={busy}
        onChange={(e) => onWrite(e.target.value)}
      />
      <div className="qset-nav">
        <button type="button" className="secondary" disabled={first || busy} onClick={onBack}>
          <span aria-hidden="true">← </span>Back
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={onSkip}>
          Skip
        </button>
        <button type="button" disabled={!canNext || busy} onClick={onNext}>
          Next<span aria-hidden="true"> →</span>
        </button>
      </div>
    </div>
  );
}

/** What a row says on the review: the user's draft, or who answered it and what. */
function rowAnswer(q: Question, d: SetAnswer | undefined, world: World): ReactNode {
  if (q.status === 'open') {
    if (!isAnswered(d)) return <span className="muted">no answer yet</span>;
    if (d.skipped) return <span className="qset-skipped">skipped</span>;
    return <>→ {renderSetAnswer(normalised(d))}</>;
  }
  if (q.status === 'cancelled') return <span className="muted">withdrawn</span>;
  return (
    <span className="muted">
      answered by {actorLabel(q.answeredBy, world)}
      {q.answer ? `: “${q.answer}”` : ''}
    </span>
  );
}

/**
 * Every row of the set with its answer. Open rows jump back to their page when `onJump` is
 * given; the rows a supervisor (or anyone) answered already are read-only: delivered.
 */
export function ReviewList({
  rows,
  drafts,
  world,
  onJump,
}: {
  rows: Question[];
  drafts: SetDrafts;
  world: World;
  onJump?: (q: Question) => void;
}) {
  return (
    <ol className="qset-review" aria-label="your answers" tabIndex={-1}>
      {rows.map((q) => {
        const body = (
          <>
            <span className="qset-review-q">
              {numberOf(q)}. {q.context.text}
            </span>{' '}
            <span className="qset-review-a">{rowAnswer(q, drafts[q.id], world)}</span>
          </>
        );
        return (
          <li key={q.id} className={`qset-review-row${q.status === 'open' ? '' : ' is-done'}`}>
            {q.status === 'open' && onJump ? (
              <button type="button" className="qset-review-jump" onClick={() => onJump(q)}>
                {body}
              </button>
            ) : (
              body
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** "Send 2 answers" — skips not counted. */
export function sendLabel(n: number): string {
  if (n === 0) return 'Send (every question skipped)';
  return `Send ${n} answer${n === 1 ? '' : 's'}`;
}
