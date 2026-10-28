import { useState } from 'react';
import {
  FINDING_ACTIONS,
  type FindingContext,
  type Question,
  type SetAnswer,
} from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';

/**
 * The finding card's parts (P10-07; SPEC decision 144): what a job's run found, brought to the
 * user as a job-owned question. A suggestion is answered `Create a ticket` / `Implement it` /
 * `Drop`; a drafted reply shows its draft in a box the user may edit, and `Send` carries the
 * edited text as the answer's `detail.text` (`Drop` sends nothing). `QuestionCard` gives it its
 * shell (the ×, the offline queue, the stale banner).
 */

/** The job and area it comes from, its title and its text. */
export function FindingDetails({
  question: q,
  finding,
}: {
  question: Question;
  finding: FindingContext;
}) {
  const world = useAppStore((s) => s.world);
  const job = world.jobs[finding.jobId];
  const area = job ? world.areas[job.areaId] : undefined;
  return (
    <div className="finding">
      <p className="muted">
        {finding.kind === 'reply' ? 'reply drafted by ' : 'suggestion from '}
        {job ? job.name : 'a job'}
        {area ? ` · ${area.name}` : ''}
      </p>
      <p>
        <strong>{finding.title}</strong>
      </p>
      <p>{q.context.text}</p>
    </div>
  );
}

/** The finding's fixed actions; a reply's `Send` carries the (edited) draft. */
export function FindingActions({
  finding,
  busy,
  onAnswer,
}: {
  finding: FindingContext;
  busy: boolean;
  onAnswer: (answer: string, detail?: SetAnswer) => void;
}) {
  const [text, setText] = useState(finding.draft ?? '');
  if (finding.kind === 'suggestion') {
    return (
      <div className="controls">
        {FINDING_ACTIONS.suggestion.map((action) => (
          <button
            key={action}
            disabled={busy}
            className={action === 'Drop' ? 'secondary' : undefined}
            onClick={() => onAnswer(action)}
          >
            {action}
          </button>
        ))}
      </div>
    );
  }
  const [send, drop] = FINDING_ACTIONS.reply;
  return (
    <form
      className="finding-reply"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) onAnswer(send, { choices: [send], text });
      }}
    >
      <label>
        reply
        <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <div className="controls">
        <button type="submit" disabled={busy || !text.trim()}>
          {send}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={() => onAnswer(drop)}>
          {drop}
        </button>
      </div>
    </form>
  );
}
