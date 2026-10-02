import { useEffect, useRef } from 'react';
import { ENDED_STATES, type ControlBody, type Id } from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import { QuestionCard } from './QuestionInbox.js';
import { useTranscript } from './ChatBox.js';
import { actorLabel, agentLabel, ErrorLine, StatePill, useAction, useApi } from './shared.js';

/**
 * A Steward's view (P2-18; SPEC §2.4, decision 13): its status, its work and its thought process,
 * read-only. There is no message box — except while it has an open clarification question: then
 * the question's answer box is shown here (the same answer as in the inbox, with its version). An
 * open permission request is shown as its card (allow / refuse, no free text).
 */
export function StewardView({ agentId }: { agentId: Id }) {
  const api = useApi();
  const world = useAppStore((s) => s.world);
  const chunks = useTranscript(agentId);
  const { run, error, busy } = useAction();
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chunks]);

  const agent = world.agents[agentId];
  const status = world.statuses[agentId];
  const ended = status !== undefined && ENDED_STATES.has(status.state);
  const task = agent?.taskId ? world.tasks[agent.taskId] : undefined;
  const open = Object.values(world.questions).filter(
    (q) => q.originAgentId === agentId && q.status === 'open',
  );
  const clarification = open.some((q) => q.kind === 'clarification');
  const act = (action: ControlBody['action']) =>
    run(() => api.control({ target: { kind: 'agent', id: agentId }, action }));
  const name = agentLabel(agent, world);

  return (
    <section className="steward" aria-label={`view of ${name}`}>
      <header>
        <StatePill state={status?.state} />
        <strong>{name}</strong>
        <span className="muted">
          reports to{' '}
          {actorLabel(
            agent?.supervisorId ? { type: 'agent', id: agent.supervisorId } : undefined,
            world,
          )}
        </span>
      </header>
      <dl className="facts">
        <div className="wide">
          <dt>activity</dt>
          <dd>{status?.currentActivity ?? '—'}</dd>
        </div>
        {task && (
          <div className="wide">
            <dt>task</dt>
            <dd>
              {task.description} <StatePill state={task.state} />
              {task.branch ? <code className="muted"> {task.branch}</code> : null}
            </dd>
          </div>
        )}
        <div>
          <dt>tool calls</dt>
          <dd>{status ? `${status.caps.toolCalls.used} / ${status.caps.toolCalls.limit}` : '—'}</dd>
        </div>
        {status?.progress && (
          <div>
            <dt>progress</dt>
            <dd>
              {status.progress.done} / {status.progress.total}
            </dd>
          </div>
        )}
      </dl>
      <div className="controls">
        {status?.state === 'paused' ? (
          <button disabled={busy} onClick={() => act({ action: 'resume' })}>
            Resume
          </button>
        ) : (
          <button disabled={busy || ended} onClick={() => act({ action: 'pause' })}>
            Pause
          </button>
        )}
        <button disabled={busy || ended} className="danger" onClick={() => act({ action: 'stop' })}>
          Stop
        </button>
        {status?.state === 'interrupted' && (
          <button disabled={busy} onClick={() => run(() => api.recover(agentId))}>
            Resume session
          </button>
        )}
      </div>
      <ErrorLine error={error} />
      {open.map((q) => (
        <QuestionCard key={q.id} question={q} />
      ))}
      {!clarification && (
        <p className="muted">
          Read-only: Stewards take no messages (their supervisor speaks for you).
        </p>
      )}
      <h4>Transcript</h4>
      <pre className="transcript" ref={ref}>
        {chunks.length === 0 ? (
          <span className="muted">nothing yet</span>
        ) : (
          chunks.map((c) => (
            <div key={c.seq} className={`chunk chunk-${c.kind}`}>
              <span className="muted">{c.kind}</span> {c.text}
            </div>
          ))
        )}
      </pre>
    </section>
  );
}
