import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import type {
  HistoryQuestion,
  HistoryQuestionStatus,
  HistoryWorkItem,
  HistoryWorkState,
  HostKind,
  QuestionKind,
} from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import { agentsFor, ErrorLine, StatePill, useApi } from '../../console/hierarchy/shared.js';
import { NavLink } from '../Navigation.js';
import { usePaged, type Paged } from './usePaged.js';
import {
  AgentLink,
  Fact,
  InspectContext,
  liveWork,
  Moves,
  QuestionRow,
  TrailFacts,
  When,
  WorkControls,
  WorkLink,
  openOnTrail,
  trailName,
  workName,
  type TrailEntry,
  type WorkTarget,
} from './parts.js';
import { WorkInspector } from './WorkInspector.js';
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
 *
 * P5-03: each work row also shows when it was closed and archived, where it moved and its
 * promotion link, and "Inspect" opens it in the inspector above the lists (`WorkInspector`); a
 * project, task or moved-to link there opens that item in its place, with "Back" to the one
 * before. Each past question shows its holder chain.
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

  // The inspector (P5-03): the item shown and the ones opened before it, for "Back". A name is
  // the caller's, else the inspector's once it has read the item, else the stream's; "…" until
  // one is known (never the raw id, wave-1 review).
  const [trail, setTrail] = useState<TrailEntry[]>([]);
  const world = useAppStore((s) => s.world);
  const inspect = useCallback(
    (target: WorkTarget, name?: string) => setTrail((now) => openOnTrail(now, target, name)),
    [],
  );
  const named = useCallback(
    (target: WorkTarget, name: string) =>
      setTrail((now) => {
        const same = (e: (typeof now)[number]) =>
          e.target.kind === target.kind && e.target.id === target.id;
        if (!now.some((e) => same(e) && e.name !== name)) return now;
        return now.map((e) => (same(e) ? { ...e, name } : e));
      }),
    [],
  );
  const shown = trail.at(-1);
  const before = trail.at(-2);

  return (
    <InspectContext.Provider value={inspect}>
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
        {shown && (
          <WorkInspector
            key={`${shown.target.kind}:${shown.target.id}`}
            target={shown.target}
            back={before ? trailName(before, world) : undefined}
            onName={named}
            onBack={() => setTrail((now) => now.slice(0, -1))}
            onClose={() => setTrail([])}
          />
        )}
        <WorkHistory search={search} />
        <QuestionHistory search={search} />
      </main>
    </InspectContext.Provider>
  );
}

// --- work -------------------------------------------------------------------------------------

const WORK_STATES: { value: '' | HistoryWorkState; label: string }[] = [
  { value: '', label: 'any state' },
  { value: 'completed', label: 'completed' },
  { value: 'failed', label: 'failed or cancelled' },
  { value: 'archived', label: 'archived' },
];

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

function WorkRow({ entry }: { entry: HistoryWorkItem }) {
  const world = useAppStore((s) => s.world);
  const inspect = useContext(InspectContext);
  const nameId = useId();
  const work = liveWork(world, entry);
  const { item } = work;
  const name = workName(work);
  const bodyName = world.bodies[item.bodyId]?.name ?? entry.bodyName;
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

  return (
    <li className="his-row" aria-labelledby={nameId}>
      <div className="his-row-head">
        <span className="his-kind">{work.kind}</span>
        <StatePill state={item.state} />
        {item.pinned && <span className="his-tag">pinned</span>}
        <span className="his-name" id={nameId}>
          {name}
        </span>
        <span className="pnl-spacer" />
        <button
          type="button"
          className="secondary his-inspect"
          aria-label={`Inspect ${name}`}
          onClick={() => inspect({ kind: work.kind, id: item.id }, name)}
        >
          Inspect
        </button>
      </div>
      <dl className="his-facts">
        {project && (
          <Fact term={work.kind === 'task' ? 'project' : 'part of'}>
            <WorkLink target={{ kind: 'project', id: project.id }} name={project.name} />
          </Fact>
        )}
        {bodyName && <Fact term="body">{bodyName}</Fact>}
        <Fact term="created">
          <When at={item.createdAt} />
        </Fact>
        <TrailFacts trail={entry.trail} />
        <Fact term="last change">
          <When at={item.updatedAt} />
        </Fact>
      </dl>
      <Moves moves={entry.trail?.moves} name={name} />
      {agents.length > 0 && (
        <p className="his-agents" aria-label={`agents of ${name}`}>
          {agents.map((a, i) => (
            <AgentLink key={a.id} agent={a} earlier={i > 0} />
          ))}
        </p>
      )}
      <WorkControls work={work} />
    </li>
  );
}

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
