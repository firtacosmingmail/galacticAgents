import { useState, type FormEvent } from 'react';
import type { Question } from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import type { WorldState } from '../../state/reduce.js';
import { ApiError } from '../../console/api.js';
import { actorLabel, ErrorLine, useAction, useApi } from '../../console/hierarchy/shared.js';

/** A refused (stale) answer, kept by the view so it can say who answered first. */
export interface StaleRefusal {
  questionId: string;
  message: string;
}

/** "already answered by Waykeeper · CSV tool: "ISO 8601"", from the folded world when it knows. */
export function staleLine(world: WorldState, r: StaleRefusal): string {
  const q = world.questions[r.questionId];
  if (q?.status === 'answered') {
    return `already answered by ${actorLabel(q.answeredBy, world)}${q.answer ? `: "${q.answer}"` : ''}`;
  }
  if (q?.status === 'cancelled') return 'the question was withdrawn';
  return r.message;
}

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
  onStale: (refusal: StaleRefusal) => void;
  onSent: () => void;
}) {
  const api = useApi();
  const world = useAppStore((s) => s.world);
  const { run, error, busy } = useAction();
  const [value, setValue] = useState('');

  const answer = async (text: string) => {
    let stale: string | undefined;
    const ok = await run(async () => {
      try {
        await api.answer(q.id, text, q.version);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'stale') stale = e.message;
        throw e;
      }
    });
    if (ok) {
      setValue('');
      onSent();
    } else if (stale !== undefined) onStale({ questionId: q.id, message: stale });
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = value.trim();
    if (text) void answer(text);
  };

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
        <textarea
          id={`stw-answer-${q.id}`}
          value={value}
          rows={2}
          placeholder="your answer"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e);
          }}
        />
        <button type="submit" disabled={busy || !value.trim()}>
          Send answer
        </button>
      </div>
      <ErrorLine error={error} />
    </form>
  );
}
