import {
  LAUNCH_ACTIONS,
  LAUNCH_FLAGS,
  OFF_SCRIPT_ACTIONS,
  type Question,
} from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';

/**
 * The launch approval card and the off-script card (P12-09; design steward-launch-flags). Both
 * are user-only with fixed answers (the server refuses any other text), so neither has a
 * free-text box and the off-script card never offers "Allow similar". `QuestionCard` gives them
 * their shell (the ×, the offline queue, the error line).
 *
 * A `launch` question shows the exact command a Waykeeper wants a Steward started with, why, what
 * the flag adds over a normal Steward, what the Waykeeper will watch for and check. An off-script
 * question is a permission question whose call the scope judge stopped.
 */

const FIELD_LABEL = 'launch-field-label';

/** The launch card's body, top to bottom. */
export function LaunchDetails({ question: q }: { question: Question }) {
  const world = useAppStore((s) => s.world);
  const launch = q.context.launch;
  if (!launch) return <p>{q.context.text}</p>;
  const origin = world.agents[q.originAgentId];
  const project = origin?.projectId ? world.projects[origin.projectId] : undefined;
  const task = world.tasks[launch.taskId];
  return (
    <div className="launch">
      <p className="muted">
        Waykeeper · {project?.name ?? origin?.projectId ?? q.originAgentId} · needs your approval
      </p>
      <h3 className="launch-title">Start Steward with extra access</h3>
      <dl className="launch-fields">
        <dt className={FIELD_LABEL}>Task</dt>
        <dd>{task?.description ?? launch.taskId}</dd>
        <dt className={FIELD_LABEL}>Why</dt>
        <dd>{launch.reason}</dd>
        <dt className={FIELD_LABEL}>Command</dt>
        <dd>
          <code className="launch-command">{launch.command}</code>
          <div className="muted">
            in <code>{launch.cwd}</code>
          </div>
        </dd>
        <dt className={FIELD_LABEL}>New compared to a normal Steward</dt>
        <dd>
          <ul className="items">
            {launch.flags.map((f) => (
              <li key={f}>
                <code>{LAUNCH_FLAGS[f].cli}</code> {LAUNCH_FLAGS[f].label}
              </li>
            ))}
          </ul>
        </dd>
        <dt className={FIELD_LABEL}>Waykeeper will watch for</dt>
        <dd>{launch.expectedUse}</dd>
        <dt className={FIELD_LABEL}>and check</dt>
        <dd>{launch.check}</dd>
      </dl>
    </div>
  );
}

/** The three fixed launch answers. */
export function LaunchActions({
  busy,
  onAnswer,
}: {
  busy: boolean;
  onAnswer: (answer: string) => void;
}) {
  const [approve, without, deny] = LAUNCH_ACTIONS;
  return (
    <div className="controls">
      <button disabled={busy} onClick={() => onAnswer(approve)}>
        {approve}
      </button>
      <button disabled={busy} className="secondary" onClick={() => onAnswer(without)}>
        {without}
      </button>
      <button disabled={busy} className="danger" onClick={() => onAnswer(deny)}>
        {deny}
      </button>
    </div>
  );
}

/** The off-script body: the stopped call, what was approved and why the judge objected. */
export function OffScriptDetails({ question: q }: { question: Question }) {
  const off = q.context.offScript;
  const call = q.context.toolCall;
  if (!off) return null;
  return (
    <div className="launch off-script">
      <p>{q.context.text}</p>
      {call && (
        <>
          <p className={FIELD_LABEL}>The Steward tried to:</p>
          <p>
            <code>{call.toolName}</code>
          </p>
          {call.input !== undefined && (
            <pre className="off-script-input">{JSON.stringify(call.input, null, 2)}</pre>
          )}
        </>
      )}
      <p className={FIELD_LABEL}>Approved:</p>
      <p>{off.expectedUse}</p>
      {off.precedents.length > 0 && (
        <ul className="items">
          {off.precedents.map((p, i) => (
            <li key={`${i}:${p}`}>{p}</li>
          ))}
        </ul>
      )}
      <p className={FIELD_LABEL}>Why it was stopped:</p>
      <p>{off.judgeReason}</p>
    </div>
  );
}

/** The two fixed off-script answers. */
export function OffScriptActions({
  busy,
  onAnswer,
}: {
  busy: boolean;
  onAnswer: (answer: string) => void;
}) {
  const [approve, stop] = OFF_SCRIPT_ACTIONS;
  return (
    <div className="controls">
      <button disabled={busy} onClick={() => onAnswer(approve)}>
        {approve}
      </button>
      <button disabled={busy} className="danger" onClick={() => onAnswer(stop)}>
        {stop}
      </button>
    </div>
  );
}
