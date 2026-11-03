import type { Question } from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import { choiceText } from '../providers.js';
import { AgentRef } from './links.js';

/**
 * The usage-limit card's parts (P11-09): a clarification whose `context.usageLimit` says which
 * provider and model hit its subscription limit and when it resets. Its fixed options — one
 * `Switch to …` per eligible model and `Wait until it resets` — are buttons; the server refuses a
 * free-text answer, so the card offers no text box. Nothing switches without the user.
 */

/** Which AI hit its limit, when it resets and who was working. */
export function UsageLimitDetails({ question: q }: { question: Question }) {
  const world = useAppStore((s) => s.world);
  const limit = q.context.usageLimit;
  if (!limit) return <p>{q.context.text}</p>;
  const job = limit.jobId ? world.jobs[limit.jobId] : undefined;
  const taskId = limit.taskId ?? q.context.origin?.taskId;
  const task = taskId ? world.tasks[taskId] : undefined;
  const resets = limit.resetsAt ? new Date(limit.resetsAt) : undefined;
  return (
    <div className="usage-limit">
      <p>{q.context.text}</p>
      <p className="muted">
        {choiceText(limit.provider, limit.model)} hit its usage limit
        {resets && !Number.isNaN(resets.getTime())
          ? `; it resets ${resets.toLocaleString()}`
          : '; the reset time is not known'}
      </p>
      <p className="muted">
        {job ? (
          <>job “{job.name}”</>
        ) : task ? (
          <>task “{task.description}”</>
        ) : (
          <>
            from <AgentRef agentId={q.originAgentId} />
          </>
        )}
      </p>
    </div>
  );
}

/** One button per option, as the question lists them. */
export function UsageLimitActions({
  question: q,
  busy,
  onAnswer,
}: {
  question: Question;
  busy: boolean;
  onAnswer: (answer: string) => void;
}) {
  return (
    <div className="controls">
      {(q.context.options ?? []).map((o) => (
        <button key={o} disabled={busy} onClick={() => onAnswer(o)}>
          {o}
        </button>
      ))}
    </div>
  );
}
