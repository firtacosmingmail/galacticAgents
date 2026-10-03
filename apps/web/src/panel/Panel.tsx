import { useEffect, useMemo, type ReactNode } from 'react';
import type { Agent, Id } from '@galactic/protocol';
import { useAppStore } from '../state/store.js';
import { summaryOf, type WorldState } from '../state/reduce.js';
import { HARMONIZER, selectionKey, type Selection } from '../state/selection.js';
import { createApi, type Api } from '../console/api.js';
import { currentHarmonizer } from '../console/hierarchy/HierarchyConsole.js';
import { ApiContext, agentLabel, StatePill } from '../console/hierarchy/shared.js';
import { Conversation } from './chat/Conversation.js';
import { CardLinksContext } from './cards/index.js';
import { Inbox } from './Inbox.js';
import { waitingForUserCount } from './inbox-model.js';
import { Beacon, Navigation, NavLink } from './Navigation.js';
import { StewardPanelView } from './steward/StewardPanelView.js';
import { ManagedAgentCards } from './AgentCards.js';
import { NotificationsControl } from './notifications/NotificationsControl.js';
import { FirstRunGate } from './settings/FirstRunGate.js';
import { SettingsProvider } from './settings/SettingsData.js';
import { SettingsPage } from './settings/SettingsPage.js';
import { HistoryPage } from './history/HistoryPage.js';
import { SceneArea } from '../scene/SceneArea.js';
import { useScene, type SceneControl } from '../scene/visibility.js';
import './panel.css';

/**
 * The side panel (P25-02, SPEC §4.2): the navigation on the left, the selected conversation or
 * Steward view in the middle, the managed agents and the inbox on the right. With the solar-system
 * scene shown (P3-01) the scene takes the centre and the conversation and the side column sit
 * beside it; hidden ("list mode") the panel is the Phase 2.5 layout. Everything comes from the store (TECHNOLOGY §6.3); the selection is the
 * store's too, mirrored in the URL. The main area is the chat with a brain (P25-03) or the
 * Steward view (P25-05); the right column holds the managed-agents cards (P25-04) and the inbox
 * (P25-06).
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
  return (
    <ApiContext.Provider value={api}>
      <SettingsProvider api={api}>
        <CardLinksContext.Provider value={true}>
          <div className={showScene ? 'pnl pnl-with-scene' : 'pnl'}>
            <TopBar scene={scene} {...(onForget ? { onForget } : {})} />
            {route === 'settings' ? (
              // The settings page (P25-08), in the panel's frame.
              <SettingsPage token={token} />
            ) : route === 'history' ? (
              // The history view (P25-10), in the panel's frame.
              <HistoryPage />
            ) : (
              // A fresh install walks through the first-run wizard first (P25-08).
              <FirstRunGate>
                <div className={showScene ? 'pnl-grid pnl-grid-scene' : 'pnl-grid'}>
                  <Navigation />
                  {showScene && <SceneArea onFailure={scene.fail} />}
                  <MainArea />
                  <SideColumn />
                </div>
              </FirstRunGate>
            )}
          </div>
        </CardLinksContext.Provider>
      </SettingsProvider>
    </ApiContext.Provider>
  );
}

function TopBar({ scene, onForget }: { scene: SceneControl; onForget?: () => void }) {
  const status = useAppStore((s) => s.status);
  const route = useAppStore((s) => s.route);
  const selection = useAppStore((s) => s.selection);
  const world = useAppStore((s) => s.world);
  const summary = summaryOf(world);
  // The inbox header's number too: questions the user holds and cards awaiting their decision.
  const waiting = waitingForUserCount(world);
  return (
    <header className="pnl-top">
      <NavLink to={{ route: 'panel', selection: HARMONIZER }} className="pnl-brand">
        GalacticAgents
      </NavLink>
      <span className={`pnl-conn pnl-conn-${status}`} aria-label="connection">
        {status.replace(/_/g, ' ')}
      </span>
      <span className="pnl-top-counts" aria-label="summary">
        {waiting > 0 && <Beacon>{waiting} waiting for you</Beacon>}
        <span>{summary.openQuestions} open questions</span>
        <span>{summary.blockedItems} blocked</span>
      </span>
      <span className="pnl-spacer" />
      <SceneToggle scene={scene} />
      <NotificationsControl />
      <NavLink
        to={{ route: 'history', selection }}
        current={route === 'history'}
        className="pnl-history-link"
      >
        History
      </NavLink>
      <NavLink
        to={{ route: 'settings', selection }}
        current={route === 'settings'}
        className="pnl-settings-link"
      >
        Settings
      </NavLink>
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
 * Shows or hides the solar-system scene (P3-01; hidden = list mode, SPEC §4.2). Where the scene
 * cannot run (no WebGL, it failed to start, its GPU context was lost) a note says so instead and
 * the panel stays in list mode; "Retry" mounts a fresh scene where retrying can help. The label
 * names the action, so the button is a plain button (no `aria-pressed`).
 */
function SceneToggle({ scene }: { scene: SceneControl }) {
  if (scene.failure)
    return (
      <span className="pnl-scene-off">
        <span role="note" title={scene.failure}>
          3D scene unavailable — list mode
        </span>
        {scene.retry && (
          <button type="button" className="pnl-scene-toggle" onClick={scene.retry}>
            Retry
          </button>
        )}
      </span>
    );
  return (
    <button
      type="button"
      className="pnl-scene-toggle"
      onClick={() => scene.setVisible(!scene.visible)}
    >
      {scene.visible ? 'Hide scene' : 'Show scene'}
    </button>
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
    // The Harmonizer or a Waykeeper: the conversation (P25-03).
    content = <Conversation key={agent.id} agentId={agent.id} />;
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
