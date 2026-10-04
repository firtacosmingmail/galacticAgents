import { useEffect, useRef, useState } from 'react';
import type { HistoryWorkDetail } from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import { StatePill, useApi } from '../../console/hierarchy/shared.js';
import {
  AgentLink,
  byLabel,
  Fact,
  liveWork,
  Moves,
  QuestionRow,
  TrailFacts,
  When,
  WorkControls,
  WorkLink,
  workName,
  type WorkTarget,
} from './parts.js';

type Read =
  | { for: string; status: 'loading' }
  | { for: string; status: 'error'; error: string }
  | { for: string; status: 'ready'; detail: HistoryWorkDetail };

const keyOf = (t: WorkTarget) => `${t.kind}:${t.id}`;

/**
 * The history's inspector (P5-03; SPEC §4.2 "a history view of archived work"): one project or
 * task read from `GET /api/history/work/:kind/:id` — its body, dates from the log (created,
 * closed, archived, last reopened), where it moved and the promotion links, every state change
 * with who made it, its project, tasks and sub-projects (each opens here), the agents that ran it
 * (links to their views) and the questions they asked with each one's holder chain. Its controls
 * (Replay, Reopen, Pin, Archive now) are the list's; the item shows its live copy from the stream
 * when there is one, so a reopen shows at once. `back` returns to the item inspected before.
 */
export function WorkInspector({
  target,
  back,
  onBack,
  onClose,
}: {
  target: WorkTarget;
  back: string | undefined;
  onBack: () => void;
  onClose: () => void;
}) {
  const api = useApi();
  const world = useAppStore((s) => s.world);
  const key = keyOf(target);
  const [read, setRead] = useState<Read>({ for: key, status: 'loading' });
  const [reload, setReload] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  // Read again when the stream changes the item (a reopen, a pin): new state changes and dates.
  const stamp =
    target.kind === 'task'
      ? world.tasks[target.id]?.updatedAt
      : world.projects[target.id]?.updatedAt;

  useEffect(() => {
    let live = true;
    api.historyDetail(target.kind, target.id).then(
      (detail) => live && setRead({ for: key, status: 'ready', detail }),
      (e: Error) => live && setRead({ for: key, status: 'error', error: e.message }),
    );
    return () => {
      live = false;
    };
  }, [api, key, target.kind, target.id, reload, stamp]);

  // A new item: move the reader's focus (and the view) to it.
  useEffect(() => {
    heading.current?.focus();
    heading.current?.scrollIntoView?.({ block: 'nearest' });
  }, [key]);

  const current: Read = read.for === key ? read : { for: key, status: 'loading' };
  const detail = current.status === 'ready' ? current.detail : undefined;
  const work = detail ? liveWork(world, detail.work) : undefined;
  const name = work ? workName(work) : target.id;

  return (
    <section className="his-section his-inspector" aria-label={`details of ${name}`}>
      <div className="his-section-head">
        <h2 className="his-title" ref={heading} tabIndex={-1}>
          {work ? (
            <>
              <span className="his-kind">{work.kind}</span> {name}
            </>
          ) : (
            'Loading…'
          )}
        </h2>
        {work && <StatePill state={work.item.state} />}
        <span className="pnl-spacer" />
        {back && (
          <button type="button" className="secondary" onClick={onBack}>
            ← Back to {back}
          </button>
        )}
        <button type="button" className="secondary" onClick={onClose}>
          Close
        </button>
      </div>
      {current.status === 'error' && (
        <p className="his-error" role="alert">
          Could not read it: {current.error}{' '}
          <button type="button" className="secondary" onClick={() => setReload((n) => n + 1)}>
            Try again
          </button>
        </p>
      )}
      {detail && work && (
        <>
          <dl className="his-facts">
            {detail.project && (
              <Fact term={work.kind === 'task' ? 'project' : 'part of'}>
                <WorkLink
                  target={{ kind: 'project', id: detail.project.id }}
                  name={world.projects[detail.project.id]?.name ?? detail.project.name}
                />
              </Fact>
            )}
            <Fact term={work.item.state === 'archived' ? 'lived on' : 'body'}>
              {world.bodies[work.item.bodyId]?.name ?? detail.bodyName ?? work.item.bodyId}
            </Fact>
            <Fact term="created">
              <When at={work.item.createdAt} />
            </Fact>
            <TrailFacts trail={detail.trail} />
            <Fact term="last change">
              <When at={work.item.updatedAt} />
            </Fact>
          </dl>
          <Moves moves={detail.trail.moves} name={name} />
          <WorkControls work={work} />

          {detail.states.length > 0 && (
            <div className="his-block">
              <h3 className="his-subtitle">State changes</h3>
              <ol className="his-steps" aria-label={`state changes of ${name}`}>
                {detail.states.map((s, i) => {
                  const by = byLabel(s.by, world);
                  return (
                    <li key={i}>
                      <StatePill state={s.to} /> <When at={s.at} />
                      {by && <span className="his-muted-inline"> by {by}</span>}
                    </li>
                  );
                })}
              </ol>
            </div>
          )}

          {(detail.tasks.length > 0 || detail.subProjects.length > 0) && (
            <div className="his-block">
              <h3 className="his-subtitle">
                {detail.subProjects.length > 0 ? 'Tasks and sub-projects' : 'Tasks'}
              </h3>
              <ul className="his-links" aria-label={`work of ${name}`}>
                {detail.tasks.map((t) => {
                  const live = world.tasks[t.id] ?? t;
                  return (
                    <li key={t.id}>
                      <StatePill state={live.state} />{' '}
                      <WorkLink target={{ kind: 'task', id: t.id }} name={live.description} />
                    </li>
                  );
                })}
                {detail.subProjects.map((p) => {
                  const live = world.projects[p.id] ?? p;
                  return (
                    <li key={p.id}>
                      <StatePill state={live.state} /> <span className="his-kind">sub-project</span>{' '}
                      <WorkLink target={{ kind: 'project', id: p.id }} name={live.name} />
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {detail.agents.length > 0 && (
            <div className="his-block">
              <h3 className="his-subtitle">Agents</h3>
              <p className="his-agents" aria-label={`agents of ${name}`}>
                {[...detail.agents].reverse().map((a, i, all) => {
                  // "earlier" only among agents of the same role, newest first.
                  const earlier = all.slice(0, i).some((b) => b.role === a.role);
                  return <AgentLink key={a.id} agent={world.agents[a.id] ?? a} earlier={earlier} />;
                })}
              </p>
            </div>
          )}

          <div className="his-block">
            <h3 className="his-subtitle">Questions</h3>
            {detail.questions.length === 0 ? (
              <p className="his-muted">Its agents asked nothing.</p>
            ) : (
              <ul className="his-list" aria-label={`questions of ${name}`}>
                {detail.questions.map((q) => (
                  <QuestionRow key={q.question.id} entry={q} />
                ))}
              </ul>
            )}
            {detail.moreQuestions && (
              <p className="his-muted">
                Older questions are in the past questions list below (search for them).
              </p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
