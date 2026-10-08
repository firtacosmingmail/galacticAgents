import { useState, type ReactNode } from 'react';
import {
  ENDED_STATES,
  type Agent,
  type ControlBody,
  type Id,
  type Question,
  type StatusRecord,
  wallClockLimit,
} from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import type { WorldState } from '../../state/reduce.js';
import { HARMONIZER, type Selection } from '../../state/selection.js';
import { OriginContext, QuestionCard, StaleBanner } from '../cards/index.js';
import {
  actorLabel,
  agentLabel,
  ErrorLine,
  StatePill,
  useAction,
  useApi,
} from '../../console/hierarchy/shared.js';
import { Beacon, NavLink } from '../Navigation.js';
import { useNow } from '../AgentCards.js';
import { formatCost, formatDuration, wallClockUsed } from '../agent-cards-model.js';
import { ControlsStrip } from '../controls.js';
import { ClarificationComposer } from './ClarificationComposer.js';
import { DismissQuestion } from '../cards/DismissQuestion.js';
import { OfflineAnswers } from '../cards/QueuedAnswer.js';
import { StewardProcesses } from './StewardProcesses.js';
import { TerminalInput, TerminalView } from './TerminalView.js';
import { TranscriptLog } from './TranscriptLog.js';
import { TaskStatusFacts } from '../status/StatusViews.js';
import { useStewardTranscript } from './useStewardTranscript.js';
import { TaskDeliverables } from '../deliverables/DeliverablesList.js';
import './steward.css';

/**
 * A Steward's view in the panel's main area (P25-05; SPEC §2.4, decisions 13 and 48): its status,
 * its work and its thought process, read-only. The only way to write to a Steward is the answer
 * to its open clarification question: while one is open, a message box answers it through the
 * question service (with the question's `version`, so a stale answer says who was first); when
 * none is open there is no message box at all. An open permission request shows its card with
 * allow / refuse only. Pause, resume and stop act on the agent through `POST /api/control`.
 */
export function StewardPanelView({ agentId }: { agentId: Id }) {
  const world = useAppStore((s) => s.world);
  const { chunks, view, loadOlder } = useStewardTranscript(agentId);
  const [refusal, setRefusal] = useState<{ questionId: Id; message: string } | undefined>();

  const agent = world.agents[agentId];
  const status = world.statuses[agentId];
  const name = agentLabel(agent, world);
  const open = openQuestionsOf(world, agentId);
  const clarification = open.find((q) => q.kind === 'clarification');
  const permissions = open.filter((q) => q.kind === 'permission');
  const blocked = blockedOnUser(world, agentId, open);
  const task = agent?.taskId ? world.tasks[agent.taskId] : undefined;
  // A terminal agent (P8-08): its screen, its text transcript folded below, and the Mac's keyboard.
  const terminal = agent?.runtime === 'pty';
  const live = status !== undefined && !ENDED_STATES.has(status.state);

  return (
    <section className="steward stw" aria-label={`view of ${name}`}>
      <StatusHeader agent={agent} status={status} blocked={blocked} />
      <TaskStatusFacts agentId={agentId} />
      <div className="stw-controls-row">
        <Controls agentId={agentId} status={status} restartable={agent?.runtime === 'pty'} />
        {task && (
          // The task's own controls (P4-09), next to the agent's: reachable with the cards hidden.
          <ControlsStrip
            key={task.id}
            agentId={agentId}
            status={status}
            work={{ kind: 'task', item: task }}
            withAgent={false}
            name={name}
          />
        )}
      </div>
      <StewardProcesses agentId={agentId} state={status?.state} />
      {open.length > 0 && (
        <section className="stw-open" aria-label="open question">
          <h2 className="pnl-eyebrow">
            {open.length === 1 ? 'Open question' : `Open questions (${open.length})`}
          </h2>
          {permissions.map((q) => (
            <QuestionCard key={q.id} question={q} />
          ))}
          {open
            .filter((q) => q.kind === 'clarification')
            .map((q) => (
              <ClarificationSummary key={q.id} question={q} />
            ))}
        </section>
      )}
      {/* Answers to its questions given offline, once the question is no longer open (P7-05). */}
      <OfflineAnswers filter={(e) => world.questions[e.questionId]?.originAgentId === agentId} />
      {refusal && (
        <StaleBanner
          questionId={refusal.questionId}
          message={refusal.message}
          onDismiss={() => setRefusal(undefined)}
        />
      )}
      {/* The task's deliverables (P9-09), also once the Steward has ended. */}
      {task && <TaskDeliverables key={task.id} taskId={task.id} />}
      {terminal ? (
        <>
          <TerminalView chunks={chunks} />
          <details className="stw-text-transcript">
            <summary>Text transcript</summary>
            <TranscriptLog chunks={chunks} view={view} loadOlder={loadOlder} />
          </details>
        </>
      ) : (
        <TranscriptLog chunks={chunks} view={view} loadOlder={loadOlder} />
      )}
      {terminal && live && <TerminalInput agentId={agentId} />}
      {clarification ? (
        <ClarificationComposer
          key={clarification.id}
          question={clarification}
          onStale={(questionId, message) => setRefusal({ questionId, message })}
          onSent={() => setRefusal(undefined)}
        />
      ) : (
        !terminal && (
          <p className="muted stw-readonly">
            Read-only: Stewards take no messages; their supervisor speaks for you. A message box
            appears here only while it asks a clarification question.
          </p>
        )
      )}
    </section>
  );
}

/** The Steward's open questions, oldest first. */
export function openQuestionsOf(world: WorldState, agentId: Id): Question[] {
  return Object.values(world.questions)
    .filter((q) => q.originAgentId === agentId && q.status === 'open')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** Blocked on the user: a question of its own the user holds, or its task waits for the user. */
function blockedOnUser(world: WorldState, agentId: Id, open: Question[]): boolean {
  if (open.some((q) => q.holder.type === 'user')) return true;
  const taskId = world.agents[agentId]?.taskId;
  return taskId !== undefined && world.tasks[taskId]?.state === 'blocked_on_user';
}

function StatusHeader({
  agent,
  status,
  blocked,
}: {
  agent: Agent | undefined;
  status: StatusRecord | undefined;
  blocked: boolean;
}) {
  const world = useAppStore((s) => s.world);
  const now = useNow(
    status !== undefined && !ENDED_STATES.has(status.state) && status.state !== 'paused',
  );
  const task = agent?.taskId ? world.tasks[agent.taskId] : undefined;
  const project = task?.projectId ? world.projects[task.projectId] : undefined;
  const body = world.bodies[task?.bodyId ?? agent?.bodyId ?? ''];
  const supervisor = agent?.supervisorId ? world.agents[agent.supervisorId] : undefined;
  const supervisorLink: Selection | undefined = supervisor
    ? supervisor.role === 'harmonizer'
      ? HARMONIZER
      : { kind: supervisor.role, id: supervisor.id }
    : undefined;

  return (
    <header className="stw-head">
      <div className="stw-state">
        {blocked && <Beacon>blocked on you</Beacon>}
        <StatePill state={status?.state} />
        {task && <span className="muted">task {task.state.replace(/_/g, ' ')}</span>}
      </div>
      <p className="stw-activity">
        {/* Read out, not shown (its place in the header says it on screen); a `<p>` takes no
            ARIA name. */}
        <span className="pnl-visually-hidden">Current activity: </span>
        {status?.currentActivity ?? (status ? 'no activity reported' : 'no status yet')}
      </p>
      <dl className="stw-facts">
        <Fact label="task">{task?.description ?? '—'}</Fact>
        <Fact label="project">
          {project ? project.name : task ? 'standalone task (asteroid)' : '—'}
        </Fact>
        <Fact label="body">{body ? `${body.name} (${body.kind})` : '—'}</Fact>
        <Fact label="reports to">
          {supervisorLink ? (
            <NavLink to={{ route: 'panel', selection: supervisorLink }} className="stw-link">
              {agentLabel(supervisor, world)}
            </NavLink>
          ) : (
            actorLabel(undefined, world)
          )}
        </Fact>
        <Fact label="worktree" wide>
          {task?.worktreePath ? <code>{task.worktreePath}</code> : '—'}
        </Fact>
        <Fact label="branch">{task?.branch ? <code>{task.branch}</code> : '—'}</Fact>
        <Fact label="cost">{formatCost(status)}</Fact>
        <Fact label="tool calls">
          {status ? `${status.caps.toolCalls.used} / ${status.caps.toolCalls.limit}` : '—'}
        </Fact>
        <Fact label="wall clock">
          {status
            ? wallClockLimit(status.caps.wallClockMs) !== undefined
              ? `${formatDuration(wallClockUsed(status, now))} / ${formatDuration(status.caps.wallClockMs.limit)}`
              : formatDuration(wallClockUsed(status, now))
            : '—'}
        </Fact>
        {status?.progress && (
          <Fact label="progress">
            {status.progress.done} / {status.progress.total}
          </Fact>
        )}
      </dl>
    </header>
  );
}

function Fact({
  label,
  wide = false,
  children,
}: {
  label: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={wide ? 'stw-fact stw-wide' : 'stw-fact'}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Controls({
  agentId,
  status,
  restartable = false,
}: {
  agentId: Id;
  status: StatusRecord | undefined;
  /** Its runtime cannot resume a session (PTY): the action starts it again from its prompt. */
  restartable?: boolean;
}) {
  const api = useApi();
  const { run, error, busy } = useAction();
  const [confirmStop, setConfirmStop] = useState(false);
  const ended = status !== undefined && ENDED_STATES.has(status.state);
  const act = (action: ControlBody['action']) =>
    run(() => api.control({ target: { kind: 'agent', id: agentId }, action }));
  return (
    <div className="stw-controls" role="group" aria-label="controls">
      {status?.state === 'paused' ? (
        <button type="button" disabled={busy} onClick={() => void act({ action: 'resume' })}>
          Resume
        </button>
      ) : (
        <button
          type="button"
          disabled={busy || ended || !status}
          onClick={() => void act({ action: 'pause' })}
        >
          Pause
        </button>
      )}
      {confirmStop ? (
        <>
          <button
            type="button"
            className="danger"
            disabled={busy || ended}
            onClick={() => {
              setConfirmStop(false);
              void act({ action: 'stop' });
            }}
          >
            Confirm stop
          </button>
          <button type="button" className="secondary" onClick={() => setConfirmStop(false)}>
            Keep it running
          </button>
        </>
      ) : (
        <button
          type="button"
          className="danger"
          disabled={busy || ended || !status}
          onClick={() => setConfirmStop(true)}
        >
          Stop
        </button>
      )}
      {status?.state === 'interrupted' && (
        <button type="button" disabled={busy} onClick={() => void run(() => api.recover(agentId))}>
          {restartable ? 'Restart from its first prompt' : 'Resume session'}
        </button>
      )}
      <ErrorLine error={error} />
    </div>
  );
}

/** The open clarification, shown prominently above the transcript; the composer answers it. */
function ClarificationSummary({ question: q }: { question: Question }) {
  const world = useAppStore((s) => s.world);
  const userHeld = q.holder.type === 'user';
  return (
    <article
      className={`card question question-clarification stw-question${userHeld ? ' is-yours' : ''}`}
      aria-label={`clarification question ${q.context.text}`}
    >
      <header>
        <span className="pill kind-clarification">clarification</span>
        <span className="muted">held by {actorLabel(q.holder, world)}</span>
        <DismissQuestion question={q} />
      </header>
      <p className="stw-question-text">{q.context.text}</p>
      <OriginContext question={q} />
      <p className="muted">
        {userHeld
          ? 'It waits for your answer: write it in the box below.'
          : 'Its supervisor may answer it from context; you can answer it yourself below. Answering anywhere resolves it everywhere.'}
      </p>
    </article>
  );
}
