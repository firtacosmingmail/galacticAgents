import { useState } from 'react';
import { PUBLISH_ACTIONS, type Question, type SetAnswer } from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import { AgentRef } from './links.js';

/**
 * The publish card's parts (P11-09; SPEC decision 90's rules as `spend`): a `publish` question asks
 * the user to let a Steward post under their name — the platform, the account, the text in a box
 * the user may edit, and the files. Answered `Approve` (the text in the box rides as the answer's
 * `detail.text`; a blank one the server refuses unless files exist, and the card shows why) or `Refuse`; never
 * decided by a rule or a brain. `QuestionCard` gives it its shell (the ×, the offline queue).
 *
 * The files are listed by name: the only file route serves a deliverable by its id, and a path in a
 * worktree is not one, so no image bytes are fetched for a question.
 */

/** The `↗` badge, platform and account, the text, the files and who asks. */
export function PublishDetails({ question: q }: { question: Question }) {
  const world = useAppStore((s) => s.world);
  const publish = q.context.publish;
  if (!publish) return <p>{q.context.text}</p>;
  const job = publish.jobId ? world.jobs[publish.jobId] : undefined;
  const taskId =
    publish.taskId ?? q.context.origin?.taskId ?? world.agents[q.originAgentId]?.taskId;
  const task = taskId ? world.tasks[taskId] : undefined;
  return (
    <div className="publish">
      <p className="publish-head">
        <span className="publish-badge" aria-hidden="true">
          ↗
        </span>{' '}
        Publish to <strong>{publish.platform}</strong> as <strong>{publish.account}</strong>
      </p>
      {/* The question's own text: a re-asked publish says the earlier attempt may have posted. */}
      <p>{q.context.text}</p>
      {publish.files.length > 0 && (
        <div className="publish-files">
          <p className="muted">
            {publish.files.length === 1 ? '1 file' : `${publish.files.length} files`} (names only;
            the content is in the workspace)
          </p>
          <ul className="items" aria-label="files to publish">
            {publish.files.map((f) => (
              <li key={f.path}>
                <code>{f.path}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="muted">
        {job ? (
          <>from job “{job.name}”</>
        ) : publish.jobId ? (
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

/** The editable text with `Approve` / `Refuse`. */
export function PublishActions({
  question: q,
  busy,
  onAnswer,
}: {
  question: Question;
  busy: boolean;
  onAnswer: (answer: string, detail?: SetAnswer) => void;
}) {
  const original = q.context.publish?.text ?? '';
  const [text, setText] = useState(original);
  const [approve, refuse] = PUBLISH_ACTIONS;
  return (
    <form
      className="publish-edit"
      onSubmit={(e) => {
        e.preventDefault();
        onAnswer(approve, { choices: [approve], text });
      }}
    >
      <label>
        text to post
        <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <div className="controls">
        <button type="submit" disabled={busy}>
          {approve}
        </button>
        <button type="button" className="danger" disabled={busy} onClick={() => onAnswer(refuse)}>
          {refuse}
        </button>
      </div>
    </form>
  );
}
