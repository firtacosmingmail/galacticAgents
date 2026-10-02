import { useEffect, useMemo, type ReactNode } from 'react';
import { ENDED_STATES, type Agent, type Id } from '@galactic/protocol';
import { useAppStore } from '../state/store.js';
import { summaryOf, type WorldState } from '../state/reduce.js';
import { HARMONIZER, selectionKey, type Selection } from '../state/selection.js';
import { createApi, type Api } from '../console/api.js';
import { ChatBox } from '../console/hierarchy/ChatBox.js';
import { currentHarmonizer } from '../console/hierarchy/HierarchyConsole.js';
import { ApiContext, agentLabel, StatePill } from '../console/hierarchy/shared.js';
import { CardLinksContext } from './cards/index.js';
import { Inbox } from './Inbox.js';
import { Beacon, Navigation, NavLink } from './Navigation.js';
import { StewardPanelView } from './steward/StewardPanelView.js';
import { ManagedAgentCards } from './AgentCards.js';
import './panel.css';

/**
 * The side panel (P25-02, SPEC §4.2) in "list mode", the only mode for now: the navigation on
 * the left, the selected conversation or Steward view in the middle, the managed agents and the
 * inbox on the right. Everything comes from the store (TECHNOLOGY §6.3); the selection is the
 * store's too, mirrored in the URL. The main area and the right column reuse P2-18's pieces until
 * P25-03 … P25-06 replace them.
 */
export function Panel({
  token,
  api: given,
  onForget,
}: {
  token: string;
  api?: Api;
  /** Forgets the stored token (back to the paste form), as the ops console's status bar does. */
  onForget?: () => void;
}) {
  const api = useMemo(() => given ?? createApi(token), [given, token]);
  return (
    <ApiContext.Provider value={api}>
      <CardLinksContext.Provider value={true}>
        <div className="pnl">
          <TopBar {...(onForget ? { onForget } : {})} />
          <div className="pnl-grid">
            <Navigation />
            <MainArea />
            <SideColumn />
          </div>
        </div>
      </CardLinksContext.Provider>
    </ApiContext.Provider>
  );
}

function TopBar({ onForget }: { onForget?: () => void }) {
  const status = useAppStore((s) => s.status);
  const world = useAppStore((s) => s.world);
  const summary = summaryOf(world);
  return (
    <header className="pnl-top">
      <NavLink to={{ route: 'panel', selection: HARMONIZER }} className="pnl-brand">
        GalacticAgents
      </NavLink>
      <span className={`pnl-conn pnl-conn-${status}`} aria-label="connection">
        {status.replace(/_/g, ' ')}
      </span>
      <span className="pnl-top-counts" aria-label="summary">
        {summary.userQuestions > 0 && <Beacon>{summary.userQuestions} waiting for you</Beacon>}
        <span>{summary.openQuestions} open questions</span>
        <span>{summary.blockedItems} blocked</span>
      </span>
      <span className="pnl-spacer" />
      <NavLink to={{ route: 'debug', selection: HARMONIZER }} className="pnl-debug-link">
        Ops console
      </NavLink>
      {onForget && (
        <button type="button" className="pnl-forget" onClick={onForget}>
          Forget token
        </button>
      )}
    </header>
  );
}

/**
 * A selection whose kind is not the agent's role (`/waykeeper/<a Steward's id>`, an old link)
 * shows the agent's real view; this rewrites the URL to match, without a new history entry.
 */
function useCanonicalSelection(agent: Agent | undefined, selection: Selection) {
  const navigate = useAppStore((s) => s.navigate);
  const role = agent?.role;
  const id = agent?.id;
  useEffect(() => {
    if (selection.kind === 'harmonizer' || !role || !id || role === selection.kind) return;
    navigate(
      { route: 'panel', selection: role === 'harmonizer' ? HARMONIZER : { kind: role, id } },
      { replace: true },
    );
  }, [navigate, selection, role, id]);
}

/** The agent a selection points at, if the stream has it. */
function selectedAgent(world: WorldState, selection: Selection): Agent | undefined {
  return selection.kind === 'harmonizer' ? currentHarmonizer(world) : world.agents[selection.id];
}

function MainArea() {
  const world = useAppStore((s) => s.world);
  const status = useAppStore((s) => s.status);
  const selection = useAppStore((s) => s.selection);
  const agent = selectedAgent(world, selection);
  useCanonicalSelection(agent, selection);

  let content;
  if (!agent) {
    content =
      selection.kind === 'harmonizer' ? (
        <Empty>
          No Harmonizer is running. Start Mission Control with <code>galactic start</code>.
        </Empty>
      ) : status === 'live' ? (
        <Empty>
          This {selection.kind} is not in the current log.{' '}
          <NavLink to={{ route: 'panel', selection: HARMONIZER }}>Back to the Harmonizer</NavLink>
        </Empty>
      ) : (
        <Empty>Loading…</Empty>
      );
  } else if (agent.role === 'steward') {
    // Read-only except an open clarification's answer (decision 13; P25-05).
    content = <StewardPanelView key={agent.id} agentId={agent.id} />;
  } else {
    // P25-03 replaces this chat.
    content = (
      <ChatBox
        key={agent.id}
        agentId={agent.id}
        {...(agent.role === 'harmonizer' ? { title: 'Harmonizer' } : {})}
      />
    );
  }

  return (
    <main className="pnl-main" aria-label="main area" data-selection={selectionKey(selection)}>
      <MainHeader agent={agent} selection={selection} />
      {content}
    </main>
  );
}

function MainHeader({ agent, selection }: { agent: Agent | undefined; selection: Selection }) {
  const world = useAppStore((s) => s.world);
  const role = agent?.role ?? selection.kind;
  const eyebrow =
    role === 'harmonizer'
      ? 'Talking to'
      : role === 'waykeeper'
        ? 'Talking to the project’s Waykeeper'
        : 'Watching (read-only)';
  return (
    <div className="pnl-main-head">
      <p className="pnl-eyebrow">{eyebrow}</p>
      <h1 className="pnl-title">{agent ? agentLabel(agent, world) : role}</h1>
      {agent && agent.role !== 'harmonizer' && (
        <NavLink to={{ route: 'panel', selection: HARMONIZER }} className="pnl-back">
          ← Harmonizer
        </NavLink>
      )}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="pnl-empty pnl-empty-main">{children}</p>;
}

/**
 * The agents the selected supervisor manages directly (SPEC §4.2): for the Harmonizer its
 * Waykeepers and the asteroid Stewards, for a Waykeeper its Stewards, for a Steward its
 * supervisor. The panel itself shows P25-04's cards (`managedCards`, which also keeps ended
 * agents and sub-project Waykeepers); this plain list stays for callers that want live agents.
 */
export function managedAgents(world: WorldState, agent: Agent | undefined): Agent[] {
  if (!agent) return [];
  const live = (a: Agent) => {
    const s = world.statuses[a.id]?.state;
    return s === undefined || !ENDED_STATES.has(s);
  };
  const all = Object.values(world.agents).sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  if (agent.role === 'harmonizer')
    return all.filter(
      (a) =>
        live(a) &&
        (a.role === 'waykeeper' ||
          (a.role === 'steward' && a.taskId !== undefined && !world.tasks[a.taskId]?.projectId)),
    );
  if (agent.role === 'waykeeper')
    return all.filter((a) => a.role === 'steward' && a.supervisorId === agent.id && live(a));
  return [];
}

function SideColumn() {
  const world = useAppStore((s) => s.world);
  const selection = useAppStore((s) => s.selection);
  const agent = selectedAgent(world, selection);
  const supervisor: Id | undefined = agent?.role === 'steward' ? agent.supervisorId : undefined;
  return (
    <aside className="pnl-side" aria-label="managed agents and inbox">
      <section aria-label="managed agents">
        <h2 className="pnl-eyebrow">{supervisor ? 'Reports to' : 'Managed agents'}</h2>
        {supervisor ? <AgentLinks ids={[supervisor]} /> : <ManagedAgentCards supervisor={agent} />}
      </section>
      <section className="pnl-inbox" aria-label="inbox">
        <Inbox />
      </section>
    </aside>
  );
}

function AgentLinks({ ids }: { ids: Id[] }) {
  const world = useAppStore((s) => s.world);
  const selection = useAppStore((s) => s.selection);
  return (
    <ul className="pnl-agents">
      {ids.map((id) => {
        const a = world.agents[id];
        if (!a) return null;
        const to: Selection = a.role === 'harmonizer' ? HARMONIZER : { kind: a.role, id: a.id };
        return (
          <li key={id}>
            <NavLink
              to={{ route: 'panel', selection: to }}
              current={selection.kind !== 'harmonizer' && selection.id === id}
            >
              <StatePill state={world.statuses[id]?.state} />{' '}
              <span className="pnl-nav-name">{agentLabel(a, world)}</span>
            </NavLink>
          </li>
        );
      })}
    </ul>
  );
}
