import { useRef, useState } from 'react';
import type { Id, Question } from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import type { WorldState } from '../../state/reduce.js';
import { ApiError } from '../../console/api.js';
import { actorLabel, ErrorLine, useAction, useApi } from '../../console/hierarchy/shared.js';
import { AgentRef } from './links.js';
import { submitAnswer } from '../../client/answer-queue.js';
import { AnswerNoticeFor, isPending, QueuedAnswerBox, useQueuedAnswer } from './QueuedAnswer.js';
import { DismissQuestion, withdrawnLabel } from './DismissQuestion.js';
import { AllowSimilar, useOffersSimilar } from './AllowSimilar.js';

/**
 * Question cards (P2-18, extracted for the panel in P25-06; SPEC §2.6): one open question with its
 * kind, holder and origin context, answered inline with the question's `version`, so a stale
 * answer is refused and the page says who was first ("already answered by …"). Permission cards
 * show the tool call and the action, with Allow / Refuse (decisions 7, 31) — and, for a request of a
 * project's agent on a client that may write settings, "Allow once" plus "Allow similar for
 * <project>…" (P9-17, decision 138; `AllowSimilar`). Clarifications a
 * supervisor holds can still be answered by the user (answering anywhere resolves everywhere);
 * the ones a supervisor answered from context are read-only, with an Override that tells that
 * supervisor (decisions 12, 48). Every open card has a × that dismisses it (P9-14, decision 135).
 *
 * The cards read nothing but the store: the same question renders the same everywhere (the
 * inbox, a chat thread, the Steward view), and an answer anywhere updates all of them when the
 * stream brings `question.answered`.
 */

/** "already answered by Waykeeper · CSV tool: "ISO 8601"" — from the folded world when it knows. */
export function staleLine(
  world: Pick<WorldState, 'questions' | 'agents' | 'projects' | 'tasks'>,
  questionId: Id,
  message: string,
): string {
  const q = world.questions[questionId];
  if (q?.status === 'answered') {
    return `already answered by ${actorLabel(q.answeredBy, world)}${q.answer ? `: "${q.answer}"` : ''}`;
  }
  if (q?.status === 'cancelled') return 'the question was withdrawn';
  if (q && q.holder.type !== 'user') {
    return `${message} — it is now held by ${actorLabel(q.holder, world)}`;
  }
  return message;
}

/** The "Not sent: already answered by …" banner of a stale answer, with a dismiss button. */
export function StaleBanner({
  questionId,
  message,
  onDismiss,
}: {
  questionId: Id;
  message: string;
  onDismiss?: () => void;
}) {
  const world = useAppStore((s) => s.world);
  return (
    <p className="error" role="alert">
      Not sent: {staleLine(world, questionId, message)}{' '}
      {onDismiss && (
        <button className="secondary" onClick={onDismiss}>
          dismiss
        </button>
      )}
    </p>
  );
}

/** Where a question comes from: the asking agent, its task, body and project, its last events. */
export function OriginContext({ question }: { question: Question }) {
  const world = useAppStore((s) => s.world);
  const origin = question.context.origin;
  const task = origin?.taskId ? world.tasks[origin.taskId] : undefined;
  const project = origin?.projectId ? world.projects[origin.projectId] : undefined;
  const body = origin?.bodyId ? world.bodies[origin.bodyId] : undefined;
  return (
    <div className="origin muted">
      from <AgentRef agentId={question.originAgentId} />
      {task ? ` · task "${task.description}"` : ''}
      {project ? ` · project ${project.name}` : ''}
      {body ? ` · on ${body.name}` : ''}
      {origin && origin.recent.length > 0 && (
        <details>
          <summary>last {origin.recent.length} events</summary>
          <ul className="items">
            {origin.recent.map((e) => (
              <li key={e.seq}>
                <code>{e.type}</code> {e.summary ?? ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/**
 * An open question's card. `onStale` receives a stale refusal (the inbox keeps the banner so it
 * outlives the card); without it the card shows the banner itself.
 */
export function QuestionCard({
  question: q,
  onStale,
}: {
  question: Question;
  onStale?: (questionId: Id, message: string) => void;
}) {
  const api = useApi();
  const world = useAppStore((s) => s.world);
  const { run, error, busy } = useAction();
  const [value, setValue] = useState('');
  const [ownStale, setOwnStale] = useState<string | undefined>();
  const queued = useQueuedAnswer(q.id);
  const article = useRef<HTMLElement>(null);
  const permission = q.kind === 'permission';
  const call = q.context.toolCall;
  const userHeld = q.holder.type === 'user';
  const similar = useOffersSimilar(q, world);
  const stale = (id: Id, message: string) =>
    onStale ? onStale(id, message) : setOwnStale(message);
  const answer = async (text: string) => {
    let stale: string | undefined;
    const ok = await run(async () => {
      try {
        // Sent now, or queued while offline and sent on reconnect (P7-05).
        await submitAnswer(api, q, text);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'stale') stale = e.message;
        throw e;
      }
    });
    if (ok) setValue('');
    else if (stale !== undefined) {
      if (onStale) onStale(q.id, stale);
      else setOwnStale(stale);
    }
  };
  return (
    <article
      ref={article}
      className={`card question question-${q.kind}`}
      aria-label={`${q.kind} question ${q.context.text}`}
      data-question-id={q.id}
    >
      <header>
        <span className={`pill kind-${q.kind}`}>{q.kind}</span>
        <span className="muted">held by {actorLabel(q.holder, world)}</span>
        {/* Dismiss (P9-14): not while an answer to it waits in the offline queue. */}
        {!(queued && isPending(queued)) && (
          <DismissQuestion question={q} onStale={stale} />
        )}
      </header>
      <p>{q.context.text}</p>
      <OriginContext question={q} />
      {permission && call && (
        <p className="tool-call">
          {q.context.permissionAction ? (
            <strong>{q.context.permissionAction.replace(/_/g, ' ')}: </strong>
          ) : null}
          <code>
            {call.toolName} {call.input !== undefined ? JSON.stringify(call.input) : ''}
          </code>
        </p>
      )}
      {!userHeld && (
        <p className="muted">
          Its supervisor may answer it from context; you can answer it yourself instead.
        </p>
      )}
      {queued && isPending(queued) ? (
        <QueuedAnswerBox
          entry={queued}
          // The controls come back: the focus goes to the first of them, not to the page.
          onCancelled={() =>
            requestAnimationFrame(() =>
              article.current?.querySelector<HTMLElement>('.controls button, form input')?.focus(),
            )
          }
        />
      ) : permission ? (
        <div className="controls">
          <button disabled={busy} onClick={() => void answer('allow')}>
            {similar ? 'Allow once' : 'Allow'}
          </button>
          <button disabled={busy} className="danger" onClick={() => void answer('no')}>
            Refuse
          </button>
          {similar && <AllowSimilar question={q} project={similar} busy={busy} onStale={stale} />}
        </div>
      ) : (
        <form
          className="send"
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) void answer(value.trim());
          }}
        >
          {q.context.options?.map((o) => (
            <button type="button" key={o} disabled={busy} onClick={() => void answer(o)}>
              {o}
            </button>
          ))}
          <input
            aria-label="answer"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="your answer"
          />
          <button type="submit" disabled={busy || !value.trim()}>
            Answer
          </button>
        </form>
      )}
      <AnswerNoticeFor questionId={q.id} />
      {ownStale !== undefined ? (
        <StaleBanner
          questionId={q.id}
          message={ownStale}
          onDismiss={() => setOwnStale(undefined)}
        />
      ) : (
        <ErrorLine error={error} />
      )}
    </article>
  );
}

/**
 * An answered question, read-only: who answered and what. When a supervisor answered it from
 * context (decision 12), an Override box tells that supervisor what the user wants instead — the
 * user talks to supervisors, never to the Steward (decisions 13, 48); the supervisor passes it on.
 */
export function AnsweredQuestionCard({ question: q }: { question: Question }) {
  const api = useApi();
  const world = useAppStore((s) => s.world);
  const { run, error, busy } = useAction();
  const [value, setValue] = useState('');
  const [sent, setSent] = useState(false);
  const supervisorId = q.answeredBy?.type === 'agent' ? q.answeredBy.id : undefined;
  return (
    <article className="card question answered" aria-label={`answered question ${q.context.text}`}>
      <p>{q.context.text}</p>
      <OriginContext question={q} />
      <p>
        <strong>{actorLabel(q.answeredBy, world)}</strong> answered: “{q.answer}”
      </p>
      {supervisorId && (
        <form
          className="send"
          onSubmit={async (e) => {
            e.preventDefault();
            const text = value.trim();
            if (!text) return;
            const ok = await run(() =>
              api.send(
                supervisorId,
                `Override of your answer to question ${q.id} ("${q.context.text}"): ${text}`,
                false,
              ),
            );
            if (ok) {
              setValue('');
              setSent(true);
            }
          }}
        >
          <input
            aria-label="override"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="override: what you want instead"
          />
          <button type="submit" disabled={busy || !value.trim()}>
            Override
          </button>
          {sent && <span className="muted">sent to {actorLabel(q.answeredBy, world)}</span>}
        </form>
      )}
      <ErrorLine error={error} />
    </article>
  );
}

/**
 * A question by id, in whatever state the store has it (for a chat thread, P25-03): the open
 * card, the answered card, or a "withdrawn" line. A stale refusal stays above it after the card
 * turns into the answered one, so "already answered by …" is still said.
 */
export function QuestionView({ questionId }: { questionId: Id }) {
  const q = useAppStore((s) => s.world.questions[questionId]);
  const world = useAppStore((s) => s.world);
  const [stale, setStale] = useState<string | undefined>();
  if (!q) return null;
  return (
    <div className="question-view" data-question={q.id}>
      {stale !== undefined && (
        <StaleBanner questionId={q.id} message={stale} onDismiss={() => setStale(undefined)} />
      )}
      {q.status !== 'open' && <AnswerNoticeFor questionId={q.id} />}
      {q.status === 'open' ? (
        <QuestionCard question={q} onStale={(_id, message) => setStale(message)} />
      ) : q.status === 'answered' ? (
        <AnsweredQuestionCard question={q} />
      ) : (
        <p className="muted" role="group" aria-label={`withdrawn question ${q.context.text}`}>
          {withdrawnLabel(q, world)}: {q.context.text}
        </p>
      )}
    </div>
  );
}
