import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type {
  Agent,
  ControlBody,
  HistoryQuestion,
  HistoryQuestionStatus,
  HistoryWorkItem,
  HistoryWorkState,
  HostKind,
  QuestionKind,
} from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import { startReplay } from '../../replay/store.js';
import type { WorldState } from '../../state/reduce.js';
import {
  actorLabel,
  agentsFor,
  ErrorLine,
  StatePill,
  useAction,
  useApi,
} from '../../console/hierarchy/shared.js';
import { workActions, type CardAction, type CardWork } from '../agent-cards-model.js';
import { AgentRef, selectionFor } from '../cards/links.js';
import { NavLink } from '../Navigation.js';
import { usePaged, type Paged } from './usePaged.js';
import './history.css';

/**
 * The history view (P25-10; SPEC §4.2 "a history view of archived work and past questions") at
 * `/history`, in the panel's frame: finished and archived projects and tasks, with reopen, pin /
 * unpin and archive-now and links to their agents (decision 53); and past questions — answered,
 * or withdrawn or ended with their agent — with their kind, origin agent, who answered, the answer and when. One search
 * box drives both lists; each has its own filters and pages back over REST
 * (`GET /api/history/work`, `GET /api/history/questions`). A row shows the stream's current
 * copy of its item when the page has one, so a reopen or a pin shows at once. When the stream
 * sees work finish or a question resolve, the list offers a refresh ("New items") instead of
 * splicing the row in; a refresh keeps the rows on screen until the new first page arrives.
 */
export function HistoryPage() {
  const selection = useAppStore((s) => s.selection);
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  // Typing searches after a short pause; Enter searches at once.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(text.trim()), 300);
    return () => clearTimeout(timer);
  }, [text]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSearch(text.trim());
  };

  return (
    <main className="his-page" aria-label="history">
      <div className="his-head">
        <h1 className="pnl-title">History</h1>
        <NavLink to={{ route: 'panel', selection }} className="pnl-back">
          ← Back to the panel
        </NavLink>
      </div>
      <form className="his-search" role="search" onSubmit={submit}>
        <input
          type="search"
          aria-label="Search the history"
          placeholder="Search names, task descriptions, questions and answers"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit">Search</button>
      </form>
      <WorkHistory search={search} />
      <QuestionHistory search={search} />
    </main>
  );
}

// --- work -------------------------------------------------------------------------------------

const WORK_STATES: { value: '' | HistoryWorkState; label: string }[] = [
  { value: '', label: 'any state' },
  { value: 'completed', label: 'completed' },
  { value: 'failed', label: 'failed or cancelled' },
  { value: 'archived', label: 'archived' },
];

/** The controls a history row offers: reopen, pin / unpin and archive now, as the state allows. */
const HISTORY_ACTIONS: ReadonlySet<CardAction['action']> = new Set(['reopen', 'pin', 'archive']);

const WORK_HISTORY_STATES: ReadonlySet<string> = new Set(['completed', 'failed', 'archived']);
const QUESTION_HISTORY_STATUSES: ReadonlySet<string> = new Set(['answered', 'cancelled']);
const workState = (item: { state: string }) => item.state;
const questionStatus = (item: { status: string }) => item.status;

/**
 * Calls `onArrive` when the stream moves an item of `records` into one of `states` (work
 * finishing or being archived, a question resolving) after the page opened. The first snapshot
 * only sets the baseline: what it holds is what the first page read.
 */
function useArrivals<T>(
  records: Record<string, T>,
  stateOf: (item: T) => string,
  states: ReadonlySet<string>,
  onArrive: () => void,
) {
  const snapshots = useAppStore((s) => s.snapshots);
  const prev = useRef({ records, snapshots });
  useEffect(() => {
    const before = prev.current;
    prev.current = { records, snapshots };
    if (before.records === records || before.snapshots === 0) return;
    for (const [id, item] of Object.entries(records)) {
      const was = before.records[id];
      const now = stateOf(item);
      if (states.has(now) && (was === undefined || stateOf(was) !== now)) {
        onArrive();
        return;
      }
    }
  }, [records, snapshots, stateOf, states, onArrive]);
}

function WorkHistory({ search }: { search: string }) {
  const api = useApi();
  const projects = useAppStore((s) => s.world.projects);
  const tasks = useAppStore((s) => s.world.tasks);
  const [kind, setKind] = useState<'' | HostKind>('');
  const [state, setState] = useState<'' | HistoryWorkState>('');
  const list = usePaged<HistoryWorkItem>(
    JSON.stringify([search, kind, state]),
    (before) =>
      api.historyWork({
        ...(before ? { before } : {}),
        ...(search ? { q: search } : {}),
        ...(kind ? { kind } : {}),
        ...(state ? { state: [state] } : {}),
        limit: 25,
      }),
    (i) => `${i.kind}:${i.item.id}`,
  );
  useArrivals(projects, workState, WORK_HISTORY_STATES, list.markStale);
  useArrivals(tasks, workState, WORK_HISTORY_STATES, list.markStale);
  return (
    <section className="his-section" aria-label="past work">
      <div className="his-section-head">
        <h2 className="his-title">Work</h2>
        <p className="his-hint">Finished and archived projects and tasks, newest first.</p>
        <span className="pnl-spacer" />
        <Select label="Work kind" value={kind} onChange={setKind}>
          <option value="">projects and tasks</option>
          <option value="project">projects</option>
          <option value="task">tasks</option>
        </Select>
        <Select label="Work state" value={state} onChange={setState}>
          {WORK_STATES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
        <button type="button" className="secondary" onClick={list.reload}>
          Refresh
        </button>
      </div>
      <ListBody
        list={list}
        empty={search ? 'No finished work matches.' : 'No finished work yet.'}
        render={(i) => <WorkRow key={`${i.kind}:${i.item.id}`} entry={i} />}
      />
    </section>
  );
}

/** The live copy of a history row's item, when the stream has it. */
function liveWork(world: WorldState, entry: HistoryWorkItem): CardWork {
  if (entry.kind === 'task')
    return { kind: 'task', item: world.tasks[entry.item.id] ?? entry.item };
  return { kind: 'project', item: world.projects[entry.item.id] ?? entry.item };
}

function WorkRow({ entry }: { entry: HistoryWorkItem }) {
  const api = useApi();
  const world = useAppStore((s) => s.world);
  const nameId = useId();
  const { run, error, busy } = useAction();
  const [confirming, setConfirming] = useState<CardAction | undefined>();
  const work = liveWork(world, entry);
  const { item } = work;
  const name = work.kind === 'task' ? work.item.description : work.item.name;
  const body = world.bodies[item.bodyId];
  const project =
    work.kind === 'task'
      ? work.item.projectId
        ? world.projects[work.item.projectId]
        : undefined
      : work.item.parentProjectId
        ? world.projects[work.item.parentProjectId]
        : undefined;
  const agents = agentsFor(
    world,
    work.kind === 'task' ? { taskId: item.id } : { projectId: item.id },
  ).reverse();
  const actions = workActions(work).filter((a) => HISTORY_ACTIONS.has(a.action));

  const perform = (a: CardAction) => {
    setConfirming(undefined);
    const action: ControlBody['action'] =
      a.action === 'pin'
        ? { action: 'pin', pinned: !item.pinned }
        : ({ action: a.action } as ControlBody['action']);
    void run(() => api.control({ target: { kind: work.kind, id: item.id }, action }));
  };

  return (
    <li className="his-row" aria-labelledby={nameId}>
      <div className="his-row-head">
        <span className="his-kind">{work.kind}</span>
        <StatePill state={item.state} />
        {item.pinned && <span className="his-tag">pinned</span>}
        <span className="his-name" id={nameId}>
          {name}
        </span>
      </div>
      <dl className="his-facts">
        {project && <Fact term={work.kind === 'task' ? 'project' : 'part of'}>{project.name}</Fact>}
        {body && <Fact term="body">{body.name}</Fact>}
        <Fact term="created">
          <When at={item.createdAt} />
        </Fact>
        <Fact term="last change">
          <When at={item.updatedAt} />
        </Fact>
      </dl>
      {agents.length > 0 && (
        <p className="his-agents" aria-label={`agents of ${name}`}>
          {agents.map((a, i) => (
            <AgentLink key={a.id} agent={a} earlier={i > 0} />
          ))}
        </p>
      )}
      {(actions.length > 0 || work.kind === 'project') && (
        <div className="his-actions" role="group" aria-label={`${work.kind} controls of ${name}`}>
          {work.kind === 'project' && (
            // The timeline scrubber (P4-07): back to the scene, replaying this project.
            <button
              type="button"
              className="secondary"
              onClick={() => startReplay(api, item.id, name)}
            >
              Replay
            </button>
          )}
          {actions.map((a) => (
            <button
              key={a.action}
              type="button"
              disabled={busy}
              className={a.confirm ? 'agc-destructive' : 'secondary'}
              onClick={() => (a.confirm ? setConfirming(a) : perform(a))}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
      {confirming && (
        <div className="agc-confirm" role="group" aria-label="confirm">
          <span>{confirming.confirm}</span>
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => perform(confirming)}
          >
            Yes, {confirming.label.toLowerCase()}
          </button>
          <button type="button" className="secondary" onClick={() => setConfirming(undefined)}>
            Keep
          </button>
        </div>
      )}
      <ErrorLine error={error} />
    </li>
  );
}

/** A link to an agent's view: a Steward's read-only view or a Waykeeper's chat (decision 53). */
function AgentLink({ agent, earlier }: { agent: Agent; earlier: boolean }) {
  const label =
    agent.role === 'steward'
      ? 'Steward view'
      : agent.role === 'waykeeper'
        ? 'Waykeeper chat'
        : 'Harmonizer';
  return (
    <NavLink to={{ route: 'panel', selection: selectionFor(agent) }} className="his-agent-link">
      {earlier ? `earlier ${label.toLowerCase()} (${shortDate(agent.createdAt)})` : label}
    </NavLink>
  );
}

// --- questions --------------------------------------------------------------------------------

function QuestionHistory({ search }: { search: string }) {
  const api = useApi();
  const records = useAppStore((s) => s.world.questions);
  const [kind, setKind] = useState<'' | QuestionKind>('');
  const [status, setStatus] = useState<'' | HistoryQuestionStatus>('');
  const list = usePaged<HistoryQuestion>(
    JSON.stringify([search, kind, status]),
    (before) =>
      api.historyQuestions({
        ...(before ? { before } : {}),
        ...(search ? { q: search } : {}),
        ...(kind ? { kind } : {}),
        ...(status ? { status } : {}),
        limit: 25,
      }),
    (i) => i.question.id,
  );
  useArrivals(records, questionStatus, QUESTION_HISTORY_STATUSES, list.markStale);
  return (
    <section className="his-section" aria-label="past questions">
      <div className="his-section-head">
        <h2 className="his-title">Past questions</h2>
        <p className="his-hint">Answered, withdrawn or ended with their agent, newest first.</p>
        <span className="pnl-spacer" />
        <Select label="Question kind" value={kind} onChange={setKind}>
          <option value="">any kind</option>
          <option value="clarification">clarifications</option>
          <option value="permission">permissions</option>
        </Select>
        <Select label="Question status" value={status} onChange={setStatus}>
          <option value="">answered, withdrawn or ended</option>
          <option value="answered">answered</option>
          <option value="cancelled">withdrawn or ended</option>
        </Select>
        <button type="button" className="secondary" onClick={list.reload}>
          Refresh
        </button>
      </div>
      <ListBody
        list={list}
        empty={search ? 'No past question matches.' : 'No past questions yet.'}
        render={(i) => <QuestionRow key={i.question.id} entry={i} />}
      />
    </section>
  );
}

function QuestionRow({ entry }: { entry: HistoryQuestion }) {
  const world = useAppStore((s) => s.world);
  const q = world.questions[entry.question.id] ?? entry.question;
  const nameId = useId();
  const answered = q.status === 'answered';
  const tool = q.context.toolCall?.toolName;
  return (
    <li className="his-row" aria-labelledby={nameId}>
      <div className="his-row-head">
        <span className={`his-kind his-kind-${q.kind}`}>{q.kind}</span>
        <span className="his-tag">{answered ? 'answered' : 'withdrawn or ended'}</span>
        <span className="his-name" id={nameId}>
          {q.context.text}
        </span>
      </div>
      <dl className="his-facts">
        <Fact term="asked by">
          <AgentRef agentId={q.originAgentId} />
        </Fact>
        {tool && <Fact term="tool">{tool}</Fact>}
        <Fact term="asked">
          <When at={q.createdAt} />
        </Fact>
        {answered ? (
          <>
            <Fact term="answered by">{actorLabel(q.answeredBy, world)}</Fact>
            <Fact term="answered">
              <When at={q.updatedAt} />
            </Fact>
          </>
        ) : (
          <Fact term="withdrawn or ended">
            <When at={q.updatedAt} />
          </Fact>
        )}
      </dl>
      {answered && q.answer !== undefined && (
        <blockquote className="his-answer" aria-label="answer">
          {q.answer}
        </blockquote>
      )}
      {!answered && entry.reason && <p className="his-reason">Why: {entry.reason}</p>}
    </li>
  );
}

// --- shared bits ------------------------------------------------------------------------------

function ListBody<T extends { cursor: string }>({
  list,
  empty,
  render,
}: {
  list: Paged<T>;
  empty: string;
  render: (item: T) => ReactNode;
}) {
  if (list.status === 'loading') return <p className="his-muted">Loading…</p>;
  if (list.status === 'error')
    return (
      <p className="his-error" role="alert">
        Could not read the history: {list.error}{' '}
        <button type="button" className="secondary" onClick={list.reload}>
          Try again
        </button>
      </p>
    );
  return (
    <>
      {list.stale && (
        <p className="his-fresh" role="status">
          New items —{' '}
          <button
            type="button"
            className="secondary"
            disabled={list.refreshing}
            onClick={list.reload}
          >
            refresh
          </button>
        </p>
      )}
      {list.items.length === 0 ? (
        <p className="his-muted">{empty}</p>
      ) : (
        <ul className="his-list">{list.items.map(render)}</ul>
      )}
      {list.error && <ErrorLine error={list.error} />}
      {list.hasMore && (
        <button
          type="button"
          className="secondary his-more"
          disabled={list.loadingMore}
          onClick={list.more}
        >
          {list.loadingMore ? 'Loading…' : 'Show older'}
        </button>
      )}
    </>
  );
}

function Select<V extends string>({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: V;
  onChange: (value: V) => void;
  children: ReactNode;
}) {
  return (
    <select
      aria-label={label}
      className="his-select"
      value={value}
      onChange={(e) => onChange(e.target.value as V)}
    >
      {children}
    </select>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const shortDate = (at: string) =>
  new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function When({ at }: { at: string }) {
  const d = new Date(at);
  return (
    <time dateTime={at} title={at}>
      {Number.isNaN(d.getTime())
        ? at
        : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
    </time>
  );
}
