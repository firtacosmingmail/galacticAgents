import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ENDED_STATES, type Agent, type Id, type SettingsCaps } from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import { HARMONIZER } from '../../state/selection.js';
import { currentHarmonizer } from '../../console/hierarchy/HierarchyConsole.js';
import { ErrorLine, StatePill, useAction, useApi } from '../../console/hierarchy/shared.js';
import { Beacon, NavLink } from '../Navigation.js';
import { formatCost, formatDuration } from '../agent-cards-model.js';
import { useSettingsData } from '../settings/SettingsData.js';
import { useDockView, type DockView } from './dock-view.js';
import {
  COST_CAVEAT,
  formatCostTotal,
  narrativeRequest,
  projectStatus,
  stateWords,
  systemStatus,
  taskStatus,
  type AttentionItem,
  type CapUse,
  type QuestionCounts,
  type StateCount,
  SPAWNS_CAVEAT,
  WAYKEEPER_CAP_CAVEAT,
} from './status-model.js';
import './status.css';

/**
 * The status views (P5-02; SPEC §4.3, TECHNOLOGY §4): the dock's "Chat | Status" switch for the
 * Harmonizer and the Waykeepers, the system and project summaries it shows, and the task facts the
 * Steward view adds. Everything is computed from the client world — the one LLM path is the
 * secondary "Ask the Harmonizer" button, which sends an ordinary chat message.
 */

/** "Now" for the views, refreshed twice a minute (spawns in the last hour, today's cost, caps). */
function useSlowNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The server's caps (decision 51), when the settings are readable. */
function useCaps(): SettingsCaps | undefined {
  const data = useSettingsData();
  return data.status === 'ready' ? data.response?.settings.caps : undefined;
}

// --- the dock's switch ----------------------------------------------------------------------------

/** The dock bar's "Chat | Status" switch (Harmonizer and Waykeepers), remembered per browser. */
export function DockViewToggle() {
  const view = useDockView((s) => s.view);
  const setView = useDockView((s) => s.setView);
  const option = (value: DockView, label: string) => (
    <button
      type="button"
      className={`sts-toggle-option${view === value ? ' is-on' : ''}`}
      aria-pressed={view === value}
      onClick={() => setView(value)}
    >
      {label}
    </button>
  );
  return (
    <span className="sts-toggle" role="group" aria-label="show the chat or the status">
      {option('chat', 'Chat')}
      {option('status', 'Status')}
    </span>
  );
}

/**
 * A brain's dock body: the conversation, and the status view while the switch says so. The
 * conversation stays mounted under the status view (collapsed, invisible, `inert`), as it does
 * while the dock is minimised: its scroll position, its live thread and the draft survive.
 */
export function BrainDock({ agent, children }: { agent: Agent; children: ReactNode }) {
  const view = useDockView((s) => s.view);
  const status = view === 'status';
  return (
    <>
      <div
        className={`sts-pane sts-pane-chat${status ? ' is-hidden' : ''}`}
        inert={status}
        {...(status ? { 'aria-hidden': true } : {})}
      >
        {children}
      </div>
      {status && (
        <div className="sts-pane sts-pane-status">
          <StatusPane agent={agent} />
        </div>
      )}
    </>
  );
}

/** The Harmonizer's status is the system's; a Waykeeper's is its project's. */
export function StatusPane({ agent }: { agent: Agent }) {
  if (agent.role === 'waykeeper' && agent.projectId)
    return <ProjectStatusView projectId={agent.projectId} />;
  return <SystemStatusView />;
}

// --- pieces -----------------------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="sts-section" aria-label={title}>
      <h2 className="pnl-eyebrow">{title}</h2>
      {children}
    </section>
  );
}

/** State counts as chips; "blocked on you" is the amber one. */
function StateChips<S extends string>({
  counts,
  label,
  empty = 'none',
}: {
  counts: StateCount<S>[];
  label: string;
  empty?: string;
}) {
  if (counts.length === 0) return <p className="muted sts-empty">{empty}</p>;
  return (
    <ul className="sts-chips" aria-label={label}>
      {counts.map(({ state, count }) => (
        <li
          key={state}
          className={`sts-chip state-${state}${state === 'blocked_on_user' ? ' is-blocked' : ''}`}
        >
          <span className="sts-chip-count">{count}</span> {stateWords(state)}
        </li>
      ))}
    </ul>
  );
}

const TONE_WORDS: Record<AttentionItem['tone'], string> = {
  blocked: 'blocked on you',
  failed: 'failed',
  interrupted: 'interrupted',
  stalled: 'stalled',
  cap: 'near a cap',
};

/** What needs a look, blocked on you first; each entry selects its agent. */
function AttentionList({ items }: { items: AttentionItem[] }) {
  if (items.length === 0)
    return <p className="muted sts-empty">Nothing is blocked, failed or stalled.</p>;
  return (
    <ul className="sts-attention" aria-label="needs attention">
      {items.map((item) => (
        <li key={item.key} className={`sts-attn tone-${item.tone}`}>
          {item.tone === 'blocked' ? (
            <Beacon>{TONE_WORDS.blocked}</Beacon>
          ) : (
            <span className={`sts-tone tone-${item.tone}`}>{TONE_WORDS[item.tone]}</span>
          )}
          <span className="sts-attn-kind muted">{item.kind}</span>
          {item.selection ? (
            <NavLink to={{ route: 'panel', selection: item.selection }} className="sts-attn-name">
              {item.label}
            </NavLink>
          ) : (
            <span className="sts-attn-name">{item.label}</span>
          )}
          <span className="sts-attn-detail muted">{item.detail}</span>
        </li>
      ))}
    </ul>
  );
}

function QuestionLine({ q }: { q: QuestionCounts }) {
  if (q.open === 0) return <p className="muted sts-empty">No open questions.</p>;
  return (
    <p className="sts-line">
      {q.forUser > 0 && <Beacon>{q.forUser} for you</Beacon>} {q.open} open: {q.byKind.permission}{' '}
      permission, {q.byKind.clarification} clarification
      {q.bySupervisors > 0 && (
        <span className="muted"> · {q.bySupervisors} held by supervisors</span>
      )}
    </p>
  );
}

function capText(cap: CapUse): string {
  return cap.limit !== undefined ? `${cap.used} / ${cap.limit}` : String(cap.used);
}

/** A cap's use; `hint` (a tooltip) says how this count may differ from the server's. */
function Meter({ label, cap, hint }: { label: string; cap: CapUse; hint?: string }) {
  const full = cap.limit !== undefined && cap.used >= cap.limit;
  return (
    <div className={`sts-meter${full ? ' is-full' : ''}`}>
      <dt title={hint}>
        {label}
        {hint && <span aria-hidden="true"> ⓘ</span>}
      </dt>
      <dd title={hint}>
        {capText(cap)}
        {full && <span className="sts-full"> at the cap</span>}
        {cap.limit !== undefined && (
          <meter min={0} max={cap.limit} value={Math.min(cap.used, cap.limit)} aria-hidden="true" />
        )}
      </dd>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="sts-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * The secondary "Ask the Harmonizer" button: the only LLM path of the status views. It sends one
 * ordinary chat message and opens the Harmonizer's chat, where the answer arrives.
 */
export function AskNarrative({ scope }: { scope: Parameters<typeof narrativeRequest>[0] }) {
  const api = useApi();
  const world = useAppStore((s) => s.world);
  const select = useAppStore((s) => s.select);
  const setView = useDockView((s) => s.setView);
  const { run, error, busy } = useAction();
  const harmonizer = currentHarmonizer(world);
  const state = harmonizer ? world.statuses[harmonizer.id]?.state : undefined;
  const ended = !harmonizer || (state !== undefined && ENDED_STATES.has(state));
  const ask = async () => {
    if (!harmonizer) return;
    const ok = await run(() => api.send(harmonizer.id, narrativeRequest(scope), false));
    if (ok) {
      setView('chat');
      select(HARMONIZER);
    }
  };
  return (
    <div className="sts-ask">
      <button
        type="button"
        className="secondary"
        disabled={busy || ended}
        title="Sends a chat message to the Harmonizer (an LLM turn); everything above is computed without one"
        onClick={() => void ask()}
      >
        Ask the Harmonizer for a narrative status
      </button>
      {ended && <span className="muted"> (no Harmonizer is running)</span>}
      <ErrorLine error={error} />
    </div>
  );
}

// --- system -----------------------------------------------------------------------------------------

/** The whole system (the Harmonizer's status view). */
export function SystemStatusView() {
  const world = useAppStore((s) => s.world);
  const caps = useCaps();
  const now = useSlowNow();
  const s = useMemo(() => systemStatus(world, { now, caps }), [world, now, caps]);
  return (
    <section className="sts" aria-label="system status">
      {s.waiting > 0 && (
        <p className="sts-waiting">
          <Beacon>{s.waiting} waiting for you</Beacon>{' '}
          <span className="muted">
            {s.questions.forUser} {s.questions.forUser === 1 ? 'question' : 'questions'}, {s.cards}{' '}
            {s.cards === 1 ? 'card' : 'cards'} to decide (in the inbox)
          </span>
        </p>
      )}
      <Section title="Needs attention">
        <AttentionList items={s.attention} />
      </Section>
      <div className="sts-grid">
        <Section title="Projects">
          <StateChips counts={s.projects} label="projects by state" empty="No projects." />
        </Section>
        <Section title="Tasks">
          <StateChips counts={s.tasks} label="tasks by state" empty="No tasks." />
        </Section>
        <Section title="Agents">
          <p className="sts-line">
            Harmonizer <StatePill state={s.live.harmonizer} /> · {s.live.waykeepers} live{' '}
            {s.live.waykeepers === 1 ? 'Waykeeper' : 'Waykeepers'} · {s.live.stewards} live{' '}
            {s.live.stewards === 1 ? 'Steward' : 'Stewards'}
          </p>
          <StateChips counts={s.agents} label="agents by state" empty="No agents." />
        </Section>
        <Section title="Open questions">
          <QuestionLine q={s.questions} />
        </Section>
        <Section title="Cost">
          <dl className="sts-facts">
            <Fact label="total">{formatCostTotal(s.cost.total)}</Fact>
            <Fact label="agents active today (lifetime cost)">
              {formatCostTotal(s.cost.today)}
            </Fact>
            <Fact label="Harmonizer and Waykeepers">{formatCostTotal(s.cost.brains)}</Fact>
            <Fact label="Stewards">{formatCostTotal(s.cost.stewards)}</Fact>
          </dl>
          <p className="muted sts-note">
            Over the {s.cost.total.agents} agents the server still reports: live, or ended in the
            last 24 h.
          </p>
        </Section>
        <Section title="Caps">
          <dl className="sts-facts">
            <Meter label="live Stewards" cap={s.caps.liveStewards} />
            <Meter
              label="spawns in the last hour"
              cap={s.caps.spawnsLastHour}
              hint={SPAWNS_CAVEAT}
            />
          </dl>
        </Section>
      </div>
      <AskNarrative scope={{ kind: 'system' }} />
    </section>
  );
}

// --- project ----------------------------------------------------------------------------------------

/** A project (a Waykeeper's status view). */
export function ProjectStatusView({ projectId }: { projectId: Id }) {
  const world = useAppStore((s) => s.world);
  const caps = useCaps();
  const now = useSlowNow();
  const p = useMemo(
    () => projectStatus(world, projectId, { now, caps }),
    [world, projectId, now, caps],
  );
  if (!p) return <p className="pnl-empty">This project is not in the current log.</p>;
  const { project } = p;
  return (
    <section className="sts" aria-label={`status of ${project.name}`}>
      <p className="sts-line">
        {project.state === 'blocked_on_user' && <Beacon>blocked on you</Beacon>}{' '}
        <span className={`pill state-${project.state}`}>{stateWords(project.state)}</span>{' '}
        {p.parent && <span className="muted">sub-project of {p.parent.name}</span>}
      </p>
      <Section title="Needs attention">
        <AttentionList items={p.attention} />
      </Section>
      <Section title="Tasks">
        <StateChips counts={p.tasks} label="tasks by state" empty="No tasks yet." />
        {p.rows.length > 0 && (
          <ul className="sts-tasks" aria-label="tasks">
            {p.rows.map((row) => (
              <li key={row.task.id} className={`sts-task${row.blocked ? ' is-blocked' : ''}`}>
                {row.blocked && <Beacon>blocked on you</Beacon>}
                <span className={`pill state-${row.task.state}`}>{stateWords(row.task.state)}</span>
                {row.selection ? (
                  <NavLink
                    to={{ route: 'panel', selection: row.selection }}
                    className="sts-task-name"
                  >
                    {row.task.description}
                  </NavLink>
                ) : (
                  <span className="sts-task-name">{row.task.description}</span>
                )}
                <span className="sts-task-meta muted">
                  {row.steward ? (
                    <>
                      Steward {stateWords(row.status?.state ?? 'unknown')}
                      {row.stewards > 1 && ` (${row.stewards} runs)`}
                    </>
                  ) : (
                    'no Steward yet'
                  )}
                  {' · '}
                  {formatCostTotal(row.cost)}
                  {row.questions.open > 0 && ` · ${row.questions.open} open questions`}
                </span>
              </li>
            ))}
          </ul>
        )}
        {p.archivedTasks > 0 && (
          <p className="muted sts-note">{p.archivedTasks} archived (in the history view).</p>
        )}
      </Section>
      <div className="sts-grid">
        <Section title="Stewards">
          <dl className="sts-facts">
            <Fact label="tasks with a Steward">
              {p.stewards.active} active, {p.stewards.total} in total
            </Fact>
            <Meter
              label="live Stewards (Waykeeper cap)"
              cap={p.stewardCap}
              hint={WAYKEEPER_CAP_CAVEAT}
            />
          </dl>
        </Section>
        <Section title="Open questions">
          <QuestionLine q={p.questions} />
        </Section>
        <Section title="Cost">
          <dl className="sts-facts">
            <Fact label="Waykeeper and Stewards">{formatCostTotal(p.cost)}</Fact>
            {p.waykeeper && (
              <Fact label="Waykeeper">{formatCost(world.statuses[p.waykeeper.id])}</Fact>
            )}
          </dl>
          <p className="muted sts-note">{COST_CAVEAT}</p>
        </Section>
      </div>
      {p.subProjects.length > 0 && (
        <Section title="Sub-projects">
          <ul className="sts-tasks" aria-label="sub-projects">
            {p.subProjects.map((sub) => (
              <li key={sub.project.id} className={`sts-task${sub.blocked ? ' is-blocked' : ''}`}>
                {sub.blocked && <Beacon>blocked on you</Beacon>}
                <span className={`pill state-${sub.project.state}`}>
                  {stateWords(sub.project.state)}
                </span>
                {sub.selection ? (
                  <NavLink
                    to={{ route: 'panel', selection: sub.selection }}
                    className="sts-task-name"
                  >
                    {sub.project.name}
                  </NavLink>
                ) : (
                  <span className="sts-task-name">{sub.project.name}</span>
                )}
                <span className="sts-task-meta muted">
                  Stewards {sub.stewards.active} active, {sub.stewards.total} in total
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <AskNarrative scope={{ kind: 'project', project }} />
    </section>
  );
}

// --- task (inside the Steward view) -----------------------------------------------------------------

/**
 * What the Steward view's header does not say about its task (P5-02): its priority, how long it
 * last changed, how many Stewards it has had and what they cost together, its open
 * questions by kind, and how long this Steward has been silent.
 */
export function TaskStatusFacts({ agentId }: { agentId: Id }) {
  const world = useAppStore((s) => s.world);
  const taskId = world.agents[agentId]?.taskId;
  // A page clock, not the agent's: "last changed … ago" keeps ticking for an ended Steward too.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);
  const t = taskId ? taskStatus(world, taskId, { now, agentId }) : undefined;
  if (!t) return null;
  const since = Date.parse(t.since);
  return (
    <dl className="sts-facts sts-task-facts" aria-label="task status">
      <Fact label="task state">{stateWords(t.task.state)}</Fact>
      {Number.isFinite(since) && (
        <Fact label="task last changed">{formatDuration(Math.max(0, now - since))} ago</Fact>
      )}
      <Fact label="priority">{t.task.priority}</Fact>
      <Fact label="Stewards on it">
        {t.stewards}
        {t.stewards > 1 && <span className="muted"> (respawned)</span>}
      </Fact>
      <Fact label="cost of the task">
        {formatCostTotal(t.cost)}
        <span className="muted" title={COST_CAVEAT}>
          (runs live or ended in the last 24 h)
        </span>
      </Fact>
      <Fact label="open questions">
        {t.questions.open === 0
          ? 'none'
          : `${t.questions.byKind.permission} permission, ${t.questions.byKind.clarification} clarification`}
      </Fact>
      {t.silentForMs !== undefined && (
        <Fact label="last event">{formatDuration(t.silentForMs)} ago</Fact>
      )}
    </dl>
  );
}
