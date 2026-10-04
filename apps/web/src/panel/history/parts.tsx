import { createContext, useContext, useId, useState, type ReactNode } from 'react';
import type {
  Actor,
  Agent,
  ControlBody,
  HistoryMove,
  HistoryQuestion,
  HistoryWorkRef,
  HistoryWorkTrail,
  HolderStep,
  HostKind,
  Id,
  Project,
  Task,
} from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import { startReplay } from '../../replay/store.js';
import type { WorldState } from '../../state/reduce.js';
import { actorLabel, ErrorLine, useAction, useApi } from '../../console/hierarchy/shared.js';
import { workActions, type CardAction, type CardWork } from '../agent-cards-model.js';
import { AgentRef, selectionFor } from '../cards/links.js';
import { NavLink } from '../Navigation.js';

/**
 * The pieces the history view's lists and its inspector share (P25-10, P5-03): facts and dates,
 * the work controls, agent links, a past question with its holder chain, and the in-page links
 * that open a project or task in the inspector.
 */

/** What the inspector shows: one project or task. */
export interface WorkTarget {
  kind: HostKind;
  id: Id;
}

/** Opens a project or task in the history's inspector (P5-03). */
export const InspectContext = createContext<(target: WorkTarget) => void>(() => {});

/** The live copy of a history item, when the stream has it. */
export function liveWork(
  world: WorldState,
  work: { kind: 'project'; item: Project } | { kind: 'task'; item: Task },
): CardWork {
  if (work.kind === 'task') return { kind: 'task', item: world.tasks[work.item.id] ?? work.item };
  return { kind: 'project', item: world.projects[work.item.id] ?? work.item };
}

export const workName = (work: CardWork) =>
  work.kind === 'task' ? work.item.description : work.item.name;

/**
 * A link that opens a project or task in the inspector: a button (it navigates inside the page),
 * named "<name>" for the reader; `label` overrides the visible text.
 */
export function WorkLink({ target, name }: { target: WorkTarget; name: string }) {
  const inspect = useContext(InspectContext);
  return (
    <button
      type="button"
      className="his-link"
      aria-label={`inspect ${target.kind} ${name}`}
      onClick={() => inspect(target)}
    >
      {name}
    </button>
  );
}

export function WorkRefLink({ to: r }: { to: HistoryWorkRef }) {
  return <WorkLink target={{ kind: r.kind, id: r.id }} name={r.name} />;
}

/** The controls a history row offers: reopen, pin / unpin and archive now, as the state allows. */
const HISTORY_ACTIONS: ReadonlySet<CardAction['action']> = new Set(['reopen', 'pin', 'archive']);

/** Replay (a project), Reopen, Pin / Unpin and Archive now (confirmed first), for one item. */
export function WorkControls({ work }: { work: CardWork }) {
  const api = useApi();
  const { run, error, busy } = useAction();
  const [confirming, setConfirming] = useState<CardAction | undefined>();
  const { item } = work;
  const name = workName(work);
  const actions = workActions(work).filter((a) => HISTORY_ACTIONS.has(a.action));
  const perform = (a: CardAction) => {
    setConfirming(undefined);
    const action: ControlBody['action'] =
      a.action === 'pin'
        ? { action: 'pin', pinned: !item.pinned }
        : ({ action: a.action } as ControlBody['action']);
    void run(() => api.control({ target: { kind: work.kind, id: item.id }, action }));
  };
  if (actions.length === 0 && work.kind !== 'project') return null;
  return (
    <>
      <div className="his-actions" role="group" aria-label={`${work.kind} controls of ${name}`}>
        {work.kind === 'project' && (
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
    </>
  );
}

/** A link to an agent's view: a Steward's read-only view or a Waykeeper's chat (decision 53). */
export function AgentLink({ agent, earlier }: { agent: Agent; earlier: boolean }) {
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

/**
 * The trail's facts (P5-03): when the work was closed, archived and last reopened, and the
 * promotion links both ways. Moves are listed by `Moves`.
 */
export function TrailFacts({ trail }: { trail: HistoryWorkTrail | undefined }) {
  if (!trail) return null;
  return (
    <>
      {trail.closedAt && (
        <Fact term="closed">
          <When at={trail.closedAt} />
        </Fact>
      )}
      {trail.archivedAt && (
        <Fact term="archived">
          <When at={trail.archivedAt} />
        </Fact>
      )}
      {trail.reopenedAt && (
        <Fact term="last reopened">
          <When at={trail.reopenedAt} />
        </Fact>
      )}
      {trail.promotedFrom && (
        <Fact term="promoted from">
          <WorkRefLink to={trail.promotedFrom} />
        </Fact>
      )}
      {trail.promotedTo && (
        <Fact term="promoted to">
          <WorkRefLink to={trail.promotedTo} />
        </Fact>
      )}
    </>
  );
}

/**
 * Where the work moved (SPEC §3.4, decision 15: the history keeps the link): "Asteroid 7 → Mars,
 * into Site · Oct 4"; the project it joined opens in the inspector.
 */
export function Moves({ moves, name }: { moves: HistoryMove[] | undefined; name: string }) {
  if (!moves || moves.length === 0) return null;
  return (
    <ul className="his-moves" aria-label={`moves of ${name}`}>
      {moves.map((m, i) => (
        <li key={i}>
          <span className="his-moves-term">moved</span>{' '}
          {m.fromBodyId && <>from {m.fromBodyName ?? m.fromBodyId} </>}
          {m.toBodyId && <>to {m.toBodyName ?? m.toBodyId}</>}
          {m.intoProjectId && (
            <>
              {m.toBodyId ? ', ' : ''}into project{' '}
              <WorkLink
                target={{ kind: 'project', id: m.intoProjectId }}
                name={m.intoProjectName ?? m.intoProjectId}
              />
            </>
          )}{' '}
          · <When at={m.at} />
        </li>
      ))}
    </ul>
  );
}

const VIA: Record<HolderStep['via'], string> = {
  asked: 'asked',
  escalated: 'escalated',
  reassigned: 'reassigned',
};

/**
 * Who held a question, in order (P5-03): "Waykeeper · CSV tool → Harmonizer → you"; each step
 * says how it got there and when.
 */
export function HolderChain({ steps }: { steps: HolderStep[] }) {
  const world = useAppStore((s) => s.world);
  return (
    <ol className="his-chain" aria-label="holder chain">
      {steps.map((s, i) => (
        <li key={i} title={`${VIA[s.via]} ${s.at}${s.reason ? ` — ${s.reason}` : ''}`}>
          {actorLabel(s.holder, world)}
          {s.via === 'reassigned' && (
            <span className="his-chain-why"> (reassigned{s.reason ? `: ${s.reason}` : ''})</span>
          )}
        </li>
      ))}
    </ol>
  );
}

/** One past question: kind, text, who asked, its holder chain, who answered, the answer, when. */
export function QuestionRow({ entry }: { entry: HistoryQuestion }) {
  const world = useAppStore((s) => s.world);
  const q = world.questions[entry.question.id] ?? entry.question;
  const nameId = useId();
  const answered = q.status === 'answered';
  const open = q.status === 'open';
  const tool = q.context.toolCall?.toolName;
  return (
    <li className="his-row" aria-labelledby={nameId}>
      <div className="his-row-head">
        <span className={`his-kind his-kind-${q.kind}`}>{q.kind}</span>
        <span className="his-tag">
          {answered ? 'answered' : open ? 'open' : 'withdrawn or ended'}
        </span>
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
        {entry.holders && entry.holders.length > 0 && (
          <Fact term="held by">
            <HolderChain steps={entry.holders} />
          </Fact>
        )}
        {answered ? (
          <>
            <Fact term="answered by">{actorLabel(q.answeredBy, world)}</Fact>
            <Fact term="answered">
              <When at={q.updatedAt} />
            </Fact>
          </>
        ) : open ? null : (
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
      {q.status === 'cancelled' && entry.reason && (
        <p className="his-reason">Why: {entry.reason}</p>
      )}
    </li>
  );
}

export function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export const shortDate = (at: string) =>
  new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export function When({ at }: { at: string }) {
  const d = new Date(at);
  return (
    <time dateTime={at} title={at}>
      {Number.isNaN(d.getTime())
        ? at
        : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
    </time>
  );
}

/** "you", "Harmonizer", "the system": who made a state change, when the log says. */
export const byLabel = (by: Actor | undefined, world: WorldState) =>
  by ? actorLabel(by, world) : undefined;
