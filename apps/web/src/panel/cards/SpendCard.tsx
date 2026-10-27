import { SPEND_ACTIONS, spendAmountText, type Question } from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import { AgentRef } from './links.js';

/**
 * The spend card's parts (P10-07; SPEC decision 145): a `spend` question asks the user to approve
 * real money — the amount in the page's locale, what it is for and who asks (a job's run or a
 * task's Steward), answered `Approve` / `Refuse` and nothing else: never "Allow similar", never a
 * free answer. `QuestionCard` gives it its shell (class `question-spend`, the × and the offline
 * queue); on a remote client it is gated exactly like a permission card (ruling R7).
 */

/** The `$` badge, the amount, the purpose and who asks. */
export function SpendDetails({ question: q }: { question: Question }) {
  const world = useAppStore((s) => s.world);
  const spend = q.context.spend;
  if (!spend) return <p>{q.context.text}</p>;
  const job = spend.jobId ? world.jobs[spend.jobId] : undefined;
  const taskId = q.context.origin?.taskId ?? world.agents[q.originAgentId]?.taskId;
  const task = taskId ? world.tasks[taskId] : undefined;
  return (
    <div className="spend">
      <p className="spend-amount">
        <span className="spend-badge" aria-hidden="true">
          $
        </span>{' '}
        <strong>{spendAmountText(spend.amount, spend.currency)}</strong>
      </p>
      <p>{spend.purpose}</p>
      <p className="muted">
        {job ? (
          <>from job “{job.name}”</>
        ) : spend.jobId ? (
          <>from a job</>
        ) : task ? (
          <>from task “{task.description}”</>
        ) : (
          <>
            from <AgentRef agentId={q.originAgentId} />
          </>
        )}
      </p>
    </div>
  );
}

/** `Approve` / `Refuse`: the only answers the domain takes on a spend. */
export function SpendActions({
  busy,
  onAnswer,
}: {
  busy: boolean;
  onAnswer: (answer: string) => void;
}) {
  const [approve, refuse] = SPEND_ACTIONS;
  return (
    <div className="controls">
      <button disabled={busy} onClick={() => onAnswer(approve)}>
        {approve}
      </button>
      <button disabled={busy} className="danger" onClick={() => onAnswer(refuse)}>
        {refuse}
      </button>
    </div>
  );
}
