import type { Id, Question } from '@galactic/protocol';
import { dismissalOf, SUPERSEDED_BY_MESSAGE } from '@galactic/protocol';
import { ApiError } from '../../console/api.js';
import { actorLabel, useAction, useApi } from '../../console/hierarchy/shared.js';
import type { WorldState } from '../../state/reduce.js';
import { useStreamDown } from './QueuedAnswer.js';

/**
 * The × on a question card (P9-14, SPEC decision 135): the user withdraws a question without
 * answering it. A clarification's agent is told "the user dismissed this question" and carries
 * on; a permission request is denied, never allowed. No confirmation: nothing is lost (the agent
 * may ask again) and a dismissed permission is a refusal, the safe side. Sent with the question's
 * `version`, so a question answered or moved meanwhile is refused as stale and the card says who
 * was first. Never queued: offline the button is disabled and says why.
 */
export function DismissQuestion({
  question: q,
  onStale,
}: {
  question: Question;
  onStale?: (questionId: Id, message: string) => void;
}) {
  const api = useApi();
  const offline = useStreamDown();
  const { run, error, busy, clear } = useAction();
  const permission = q.kind === 'permission';
  const text = q.context.text.length > 80 ? `${q.context.text.slice(0, 79)}…` : q.context.text;
  const label = permission
    ? `Dismiss the permission request (deny it): ${text}`
    : `Dismiss the question, no reply: ${text}`;
  const dismiss = async () => {
    let stale: string | undefined;
    await run(async () => {
      try {
        await api.dismiss(q.id, q.version);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'stale') stale = e.message;
        throw e;
      }
    });
    // A stale refusal goes to the card's banner ("already answered by …") when it has one.
    if (stale !== undefined && onStale) {
      clear();
      onStale(q.id, stale);
    }
  };
  return (
    <>
      <button
        type="button"
        className="secondary card-dismiss"
        aria-label={label}
        title={
          offline
            ? 'Dismissing needs the connection'
            : permission
              ? 'Dismiss (deny)'
              : 'Dismiss: the agent is told you will not answer'
        }
        disabled={busy || offline}
        onClick={() => void dismiss()}
      >
        <span aria-hidden="true">×</span>
      </button>
      {error && (
        <span className="error card-dismiss-error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

/**
 * How a withdrawn question reads in a thread (P9-14): "Dismissed by you", "Withdrawn: you wrote
 * to its agent", or plain "Withdrawn" for any other cancellation.
 */
export function withdrawnLabel(
  q: Question,
  world: Pick<WorldState, 'agents' | 'projects' | 'tasks'>,
): string {
  const d = dismissalOf(q);
  if (!d) return 'Withdrawn';
  if (d.by.type === 'user') return 'Dismissed by you';
  if (d.reason === SUPERSEDED_BY_MESSAGE) {
    return 'Withdrawn: you wrote to its agent directly';
  }
  return `Withdrawn by ${actorLabel(d.by, world)}`;
}
