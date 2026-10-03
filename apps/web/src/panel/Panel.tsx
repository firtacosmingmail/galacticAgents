import {
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import type { Agent, Id } from '@galactic/protocol';
import { useAppStore } from '../state/store.js';
import type { WorldState } from '../state/reduce.js';
import { HARMONIZER, selectionKey, type Selection } from '../state/selection.js';
import { createApi, type Api } from '../console/api.js';
import { currentHarmonizer } from '../console/hierarchy/HierarchyConsole.js';
import { ApiContext, agentLabel, StatePill } from '../console/hierarchy/shared.js';
import { Conversation } from './chat/Conversation.js';
import { CardLinksContext } from './cards/index.js';
import { Inbox } from './Inbox.js';
import { Beacon, Navigation, NavLink } from './Navigation.js';
import { openQuestionsOf, StewardPanelView } from './steward/StewardPanelView.js';
import { ManagedAgentCards } from './AgentCards.js';
import { ControlsStrip } from './controls.js';
import { FirstRunGate } from './settings/FirstRunGate.js';
import { SettingsProvider } from './settings/SettingsData.js';
import { SettingsPage } from './settings/SettingsPage.js';
import { HistoryPage } from './history/HistoryPage.js';
import { SceneArea } from '../scene/SceneArea.js';
import { useScene } from '../scene/visibility.js';
import { INBOX_ID, TopBar } from './TopBar.js';
import {
  useManagedAgentsVisibility,
  type ManagedAgentsControl,
} from './managed-agents-visibility.js';
import { DockHandle, DOCK_BODY_ID, useUnreadReplies } from './Dock.js';
import { useDockPrefs, type DockControl } from './dock-state.js';
import { STACKED_LAYOUT_QUERY, useMediaQuery } from './use-media-query.js';
import './panel.css';

/**
 * The side panel (P25-02, SPEC §4.2): the navigation on the left, the managed agents and the inbox
 * on the right (P25-04, P25-06), and between them the centre: the solar-system scene (P3-01) with
 * the main area — the chat with a brain (P25-03) or the Steward view (P25-05) — docked under it
 * (P4-10). The dock splits the centre with the scene: a handle sets its height, and it minimises
 * to its bar and comes back, remembered per browser. With the scene hidden ("list mode") the main
 * area takes the whole centre. Narrow screens (STACKED_LAYOUT_QUERY) stack the scene, the
 * navigation and the side column in one scrolling area with the dock under it. The shell is
 * exactly the viewport: the page never scrolls, every column scrolls on its own.
 *
 * Everything comes from the store (TECHNOLOGY §6.3); the selection is the store's too, mirrored in
 * the URL. The managed-agents section can be hidden per browser (P4-09): the inbox stays, and the
 * side column holds only it.
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
  const route = useAppStore((s) => s.route);
  const scene = useScene();
  const showScene = route === 'panel' && scene.shown;
  const agents = useManagedAgentsVisibility();
  const stacked = useMediaQuery(STACKED_LAYOUT_QUERY);
  const dock = useDockPrefs();
  // Minimising makes sense where something else shares the space: the scene, or the stack.
  const collapsible = stacked || showScene;
  const open = !collapsible || dock.open;
  const centre = useRef<HTMLDivElement>(null);
  const gridClass = [
    'pnl-grid',
    showScene && 'pnl-grid-scene',
    !agents.visible && 'pnl-grid-no-agents',
    stacked && 'pnl-grid-stacked',
    collapsible && (open ? 'pnl-grid-dock-open' : 'pnl-grid-dock-min'),
  ]
    .filter(Boolean)
    .join(' ');
  const main = <MainArea dock={dock} collapsible={collapsible} container={centre} />;
  return (
    <ApiContext.Provider value={api}>
      <SettingsProvider api={api}>
        <CardLinksContext.Provider value={true}>
          <div className={showScene ? 'pnl pnl-with-scene' : 'pnl'}>
            <TopBar scene={scene} agents={agents} {...(onForget ? { onForget } : {})} />
            <div className="pnl-body">
              {route === 'settings' ? (
                // The settings page (P25-08), in the panel's frame.
                <SettingsPage token={token} />
              ) : route === 'history' ? (
                // The history view (P25-10), in the panel's frame.
                <HistoryPage />
              ) : (
                // A fresh install walks through the first-run wizard first (P25-08).
                <FirstRunGate>
                  {stacked ? (
                    // Narrow: one scrolling stack, the dock under it.
                    <div className={gridClass} ref={centre}>
                      <div className="pnl-stack">
                        {showScene && <SceneArea onFailure={scene.fail} />}
                        <Navigation />
                        <SideColumn agents={agents} />
                      </div>
                      {main}
                    </div>
                  ) : (
                    <div className={gridClass}>
                      <Navigation />
                      <div className="pnl-centre" ref={centre}>
                        {showScene && <SceneArea onFailure={scene.fail} />}
                        {main}
                      </div>
                      <SideColumn agents={agents} />
                    </div>
                  )}
                </FirstRunGate>
              )}
            </div>
          </div>
        </CardLinksContext.Provider>
      </SettingsProvider>
    </ApiContext.Provider>
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

/**
 * The main area, docked (P4-10): a bar — what is selected, its state, a typing or "new replies"
 * hint, the Waykeeper's controls, and the minimise / restore button — over the chat or the
 * Steward view. Minimised, only the bar stays; the content stays mounted (hidden), so a draft, the
 * scroll position and the live thread survive. Not collapsible (list mode on a wide screen), it is
 * simply the centre.
 */
function MainArea({
  dock,
  collapsible,
  container,
}: {
  dock: DockControl;
  collapsible: boolean;
  container: RefObject<HTMLDivElement | null>;
}) {
  const world = useAppStore((s) => s.world);
  const status = useAppStore((s) => s.status);
  const selection = useAppStore((s) => s.selection);
  const agent = selectedAgent(world, selection);
  useCanonicalSelection(agent, selection);
  const open = !collapsible || dock.open;

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
    // The Harmonizer or a Waykeeper: the conversation (P25-03).
    content = <Conversation key={agent.id} agentId={agent.id} />;
  }

  const className = [
    'pnl-main',
    'pnl-dock',
    open ? 'is-open' : 'is-minimised',
    collapsible && 'is-collapsible',
  ]
    .filter(Boolean)
    .join(' ');
  const style =
    collapsible && open ? ({ '--pnl-dock-size': `${dock.size}%` } as CSSProperties) : undefined;
  return (
    <main
      className={className}
      aria-label="main area"
      data-selection={selectionKey(selection)}
      style={style}
    >
      {collapsible && open && (
        <DockHandle size={dock.size} onSize={dock.setSize} container={container} />
      )}
      <MainHeader
        agent={agent}
        selection={selection}
        {...(collapsible ? { toggle: { open, set: dock.setOpen } } : {})}
      />
      <div className="pnl-dock-body" id={DOCK_BODY_ID} hidden={!open}>
        {content}
      </div>
    </main>
  );
}

/**
 * The dock's bar (P4-10): who is selected, its state ("blocked on you" first for a Steward), the
 * "N new" replies that came while minimised, its activity, the way back to the Harmonizer, the
 * Waykeeper's controls (P4-09), and the minimise / restore button where the dock can minimise.
 */
function MainHeader({
  agent,
  selection,
  toggle,
}: {
  agent: Agent | undefined;
  selection: Selection;
  /** The minimise / restore button's state; absent where the dock cannot minimise. */
  toggle?: { open: boolean; set: (open: boolean) => void };
}) {
  const world = useAppStore((s) => s.world);
  const role = agent?.role ?? selection.kind;
  const status = agent ? world.statuses[agent.id] : undefined;
  const minimised = toggle !== undefined && !toggle.open;
  const unread = useUnreadReplies(
    agent && agent.role !== 'steward' ? agent.id : undefined,
    minimised,
  );
  const blocked =
    agent?.role === 'steward' &&
    openQuestionsOf(world, agent.id).some((q) => q.holder.type === 'user');
  const eyebrow =
    role === 'harmonizer'
      ? 'Talking to'
      : role === 'waykeeper'
        ? 'Talking to the project’s Waykeeper'
        : 'Watching (read-only)';
  const activity = status?.currentActivity;
  return (
    <div className="pnl-main-head pnl-dock-bar">
      <div className="pnl-dock-titles">
        <p className="pnl-eyebrow">{eyebrow}</p>
        <h1 className="pnl-title">{agent ? agentLabel(agent, world) : role}</h1>
      </div>
      {agent && (
        <span className="pnl-dock-state">
          {blocked && <Beacon>blocked on you</Beacon>}
          <StatePill state={status?.state} />
          {unread > 0 && (
            <span className="pnl-dock-unread" role="status" aria-label={`${unread} new replies`}>
              {unread} new
            </span>
          )}
        </span>
      )}
      {activity && agent?.role !== 'steward' && (
        // The Steward view shows its activity in its own header.
        <span className="pnl-dock-hint muted" title={activity}>
          {activity}
        </span>
      )}
      <span className="pnl-dock-spacer" />
      {agent && agent.role !== 'harmonizer' && (
        <NavLink to={{ route: 'panel', selection: HARMONIZER }} className="pnl-back">
          ← Harmonizer
        </NavLink>
      )}
      {agent?.role === 'waykeeper' && <WaykeeperControls agent={agent} />}
      {toggle && (
        <button
          type="button"
          className="pnl-dock-toggle"
          aria-expanded={toggle.open}
          aria-controls={DOCK_BODY_ID}
          aria-label={toggle.open ? 'Minimise the conversation' : 'Restore the conversation'}
          title={toggle.open ? 'Minimise' : 'Restore'}
          onClick={() => toggle.set(!toggle.open)}
        >
          <span aria-hidden="true">{toggle.open ? '▾' : '▴'}</span>
          <span className="pnl-dock-toggle-text">{toggle.open ? 'Minimise' : 'Restore'}</span>
        </button>
      )}
    </div>
  );
}

/**
 * A Waykeeper's own controls in the header (P4-09): its project's work actions and its agent
 * actions, reachable with the managed-agents cards hidden (a project's card sits under the
 * Harmonizer, not here). A Steward's task controls sit in its view, next to its agent controls.
 */
function WaykeeperControls({ agent }: { agent: Agent }) {
  const world = useAppStore((s) => s.world);
  const project = agent.projectId ? world.projects[agent.projectId] : undefined;
  return (
    <ControlsStrip
      key={agent.id}
      agentId={agent.id}
      status={world.statuses[agent.id]}
      work={project ? { kind: 'project', item: project } : undefined}
      withAgent
      name={agentLabel(agent, world)}
    />
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="pnl-empty pnl-empty-main">{children}</p>;
}

/**
 * The right column: the managed-agents section (P25-04) and the inbox (P25-06). Hiding the
 * managed agents (P4-09) unmounts only their section; the inbox always stays.
 */
function SideColumn({ agents }: { agents: ManagedAgentsControl }) {
  const world = useAppStore((s) => s.world);
  const selection = useAppStore((s) => s.selection);
  const agent = selectedAgent(world, selection);
  const supervisor: Id | undefined = agent?.role === 'steward' ? agent.supervisorId : undefined;
  return (
    <aside
      className="pnl-side"
      aria-label={agents.visible ? 'managed agents and inbox' : 'inbox column'}
    >
      {agents.visible && (
        <section aria-label="managed agents">
          <div className="pnl-side-head">
            <h2 className="pnl-eyebrow">{supervisor ? 'Reports to' : 'Managed agents'}</h2>
            <button
              type="button"
              className="pnl-side-hide"
              aria-label="Hide managed agents"
              title="Hide managed agents (bring them back from the top bar)"
              onClick={() => agents.setVisible(false)}
            >
              Hide
            </button>
          </div>
          {supervisor ? (
            <AgentLinks ids={[supervisor]} />
          ) : (
            <ManagedAgentCards supervisor={agent} />
          )}
        </section>
      )}
      <section className="pnl-inbox" aria-label="inbox" id={INBOX_ID} tabIndex={-1}>
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
