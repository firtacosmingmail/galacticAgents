import { useMemo, useRef, useState, type FormEvent } from 'react';
import type { Question, SlashCommand } from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import { ApiError } from '../../console/api.js';
import { actorLabel, ErrorLine, useAction, useApi } from '../../console/hierarchy/shared.js';
import { submitAnswer } from '../../client/answer-queue.js';
import {
  AnswerNoticeFor,
  isPending,
  QueuedAnswerBox,
  useQueuedAnswer,
} from '../cards/QueuedAnswer.js';
import { useComposerAssist } from '../composer/ComposerAssist.js';
import { composing } from '../composer/assist-model.js';

/**
 * An answer reaches the agent as text inside its question's tool result, not as a message its
 * CLI reads: a runtime's own commands (`/compact`…) do not run from there, a skill or a plugin's
 * command may (the agent can invoke it). Only those are offered (P8-13).
 */
const answerable = (c: SlashCommand) => c.builtin !== true;

/**
 * The Steward view's only message box (decision 13): the answer to its open clarification
 * question, sent through the question service with the question's `version`
 * (`POST /api/questions/:id/answer`). The view renders it only while the question is open, so it
 * disappears once the answer resolves it (`question.answered` on the stream).
 */
export function ClarificationComposer({
  question: q,
  onStale,
  onSent,
}: {
  question: Question;
  /** A stale refusal; the view shows the shared `StaleBanner` (it says who answered first). */
  onStale: (questionId: string, message: string) => void;
  onSent: () => void;
}) {
  const api = useApi();
  const world = useAppStore((s) => s.world);
  const { run, error, busy } = useAction();
  const [value, setValue] = useState('');
  const queued = useQueuedAnswer(q.id);
  const field = useRef<HTMLTextAreaElement>(null);
  // What ↑ recalls (P8-14): the user's earlier answers to this agent's clarification questions,
  // oldest first — not permission verdicts ("allow"/"deny" are not something to type again;
  // review N1). Answers still queued offline (P7-05) are not sent yet: they are not history.
  const history = useMemo(
    () =>
      Object.values(world.questions)
        .filter(
          (x) =>
            x.originAgentId === q.originAgentId &&
            x.id !== q.id &&
            x.kind === 'clarification' &&
            x.answeredBy?.type === 'user' &&
            x.answer !== undefined,
        )
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
        .map((x) => ({ id: x.id, text: x.answer! })),
    [world.questions, q.originAgentId, q.id],
  );
  const assist = useComposerAssist({
    agentId: q.originAgentId,
    text: value,
    setText: setValue,
    textarea: field,
    history,
    commands: true,
    commandFilter: answerable,
  });

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
    if (ok) {
      setValue('');
      assist.reset();
      onSent();
    } else if (stale !== undefined) onStale(q.id, stale);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = value.trim();
    if (text) void answer(text);
  };

  if (queued && isPending(queued)) {
    return (
      <div className="stw-composer" role="group" aria-label="answer the clarification">
        <p className="stw-composer-label">
          Answer {actorLabel({ type: 'agent', id: q.originAgentId }, world)}: “{q.context.text}”
        </p>
        <QueuedAnswerBox
          entry={queued}
          // The box comes back: the focus goes to it, not to the page.
          onCancelled={() => requestAnimationFrame(() => field.current?.focus())}
        />
      </div>
    );
  }

  return (
    <form className="stw-composer" aria-label="answer the clarification" onSubmit={submit}>
      <label className="stw-composer-label" htmlFor={`stw-answer-${q.id}`}>
        Answer {actorLabel({ type: 'agent', id: q.originAgentId }, world)}: “{q.context.text}”
      </label>
      {q.context.options && q.context.options.length > 0 && (
        <div className="stw-options">
          {q.context.options.map((o) => (
            <button
              type="button"
              key={o}
              className="secondary"
              disabled={busy}
              onClick={() => void answer(o)}
            >
              {o}
            </button>
          ))}
        </div>
      )}
      <div className="stw-composer-row">
        <div className="cmp-field">
          <textarea
            ref={field}
            id={`stw-answer-${q.id}`}
            value={value}
            rows={2}
            placeholder="your answer"
            onChange={(e) => assist.onChange(e.target.value)}
            onKeyDown={(e) => {
              if (assist.onKeyDown(e)) return;
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !composing(e)) submit(e);
            }}
            {...assist.inputProps}
          />
          {assist.popup}
        </div>
        <button type="submit" disabled={busy || !value.trim()}>
          Send answer
        </button>
      </div>
      <AnswerNoticeFor questionId={q.id} />
      <ErrorLine error={error} />
    </form>
  );
}
