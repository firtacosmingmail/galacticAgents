import { useState } from 'react';
import type { Question } from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import type { WorldState } from '../../state/reduce.js';
import { ApiError } from '../api.js';
import { actorLabel, agentLabel, ErrorLine, useAction, useApi } from './shared.js';

/**
 * The question inbox (P2-18; SPEC §2.6): every open question with its kind, holder and origin
 * context. The user answers inline with the question's `version`, so a stale answer is refused
 * and the page says who was first ("already answered by …"). Permission cards show the tool call
 * and the action (decision 7, 31). Clarifications a supervisor holds are visible read-only and can
 * still be answered by the user (answering anywhere resolves everywhere); the ones a supervisor
 * answered from context are listed read-only with an override that tells that supervisor
 * (decision 12).
 */

/** A refused answer, kept so the inbox can say who answered first even after the card left. */
interface Refusal {
  questionId: string;
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
  const onStale = (questionId: string, message: string) =>
    setRefusals((r) => [...r.filter((x) => x.questionId !== questionId), { questionId, message }]);

  return (
    <section className="inbox" aria-label="question inbox">
      <h3>Questions for you ({mine.length})</h3>
      {refusals.map((r) => (
        <p key={r.questionId} className="error" role="alert">
          Not sent: {staleLine(world, r)}{' '}
          <button
            className="secondary"
            onClick={() => setRefusals((all) => all.filter((x) => x !== r))}
          >
            dismiss
          </button>
        </p>
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
            <AnsweredCard key={q.id} question={q} />
          ))}
        </>
      )}
    </section>
  );
}

/** "already answered by Waykeeper · CSV tool: "ISO 8601"" — from the folded world when it knows. */
function staleLine(world: WorldState, r: Refusal): string {
  const q = world.questions[r.questionId];
  if (q?.status === 'answered') {
    return `already answered by ${actorLabel(q.answeredBy, world)}${q.answer ? `: "${q.answer}"` : ''}`;
  }
  if (q?.status === 'cancelled') return 'the question was withdrawn';
  if (q && q.holder.type !== 'user') {
    return `${r.message} — it is now held by ${actorLabel(q.holder, world)}`;
  }
  return r.message;
}

/** Where a question comes from: the asking agent, its task and project, its last events. */
export function OriginContext({ question }: { question: Question }) {
  const world = useAppStore((s) => s.world);
  const origin = question.context.origin;
  const agent = world.agents[question.originAgentId];
  const task = origin?.taskId ? world.tasks[origin.taskId] : undefined;
  const project = origin?.projectId ? world.projects[origin.projectId] : undefined;
  return (
    <div className="origin muted">
      from {agentLabel(agent, world)}
      {task ? ` · task "${task.description}"` : ''}
      {project ? ` · project ${project.name}` : ''}
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

export function QuestionCard({
  question: q,
  onStale,
}: {
  question: Question;
  onStale?: (questionId: string, message: string) => void;
}) {
  const api = useApi();
  const world = useAppStore((s) => s.world);
  const { run, error, busy } = useAction();
  const [value, setValue] = useState('');
  const permission = q.kind === 'permission';
  const call = q.context.toolCall;
  const userHeld = q.holder.type === 'user';
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
    if (ok) setValue('');
    else if (stale !== undefined) onStale?.(q.id, stale);
  };
  return (
    <article
      className={`card question question-${q.kind}`}
      aria-label={`${q.kind} question ${q.context.text}`}
    >
      <header>
        <span className={`pill kind-${q.kind}`}>{q.kind}</span>
        <span className="muted">held by {actorLabel(q.holder, world)}</span>
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
      {permission ? (
        <div className="controls">
          <button disabled={busy} onClick={() => void answer('allow')}>
            Allow
          </button>
          <button disabled={busy} className="danger" onClick={() => void answer('no')}>
            Refuse
          </button>
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
      <ErrorLine error={error} />
    </article>
  );
}

/**
 * A clarification a supervisor answered from context (decision 12): read-only, with an override
 * that tells the supervisor what the user wants instead — the user talks to supervisors, never to
 * the Steward (decision 13); the supervisor passes it on.
 */
function AnsweredCard({ question: q }: { question: Question }) {
  const api = useApi();
  const world = useAppStore((s) => s.world);
  const { run, error, busy } = useAction();
  const [value, setValue] = useState('');
  const [sent, setSent] = useState(false);
  const supervisorId = q.answeredBy?.id;
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
