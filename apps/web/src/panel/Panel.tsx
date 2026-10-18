import {
  memo,
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
import { ControlsStrip, HarmonizerControls, type RestartFocus } from './controls.js';
import { FirstRunGate } from './settings/FirstRunGate.js';
import { SettingsProvider } from './settings/SettingsData.js';
import { SettingsPage } from './settings/SettingsPage.js';
import { HistoryPage } from './history/HistoryPage.js';
import { SceneArea } from '../scene/SceneArea.js';
import { ReplayBar } from '../replay/ReplayBar.js';
import { useScene } from '../scene/visibility.js';
import { dropDeepLink } from '../scene/picking/sync.js';
import { INBOX_ID, TopBar } from './TopBar.js';
import { StorageBanner } from './StorageBanner.js';
import {
  useManagedAgentsVisibility,
  type ManagedAgentsControl,
} from './managed-agents-visibility.js';
import { useInboxVisibility, type InboxControl } from './inbox-visibility.js';
import { DockHandle, DOCK_BODY_ID, UnreadReplies } from './Dock.js';
import { useDockPrefs, type DockControl } from './dock-state.js';
import { COMPACT_TOP_BAR_QUERY, STACKED_LAYOUT_QUERY, useMediaQuery } from './use-media-query.js';
import { SceneOffer } from './SceneOffer.js';
import { NavSheet, useEdgeSwipe, useNavSheet } from './nav-sheet.js';
import { closePhoneViewThen, usePhoneView } from './phone-view.js';
import { PhoneFullView } from './PhoneFullView.js';
import { BrainDock, DockViewToggle, SystemStatusView } from './status/StatusViews.js';
import { useDockView } from './status/dock-view.js';
import {
  focusAfterRemoval,
  listKeys,
  useFocusRescue,
  useRouteFocus,
  WaitingAnnouncer,
} from './a11y.js';
import { AnswerQueueAnnouncer } from './cards/QueuedAnswer.js';
import './panel.css';

/*
 * Memoised: a change of the dock (minimise, a resize) or of the selection must not re-render the
 * scene area (and its canvas), the navigation or the side column when their props did not change.
 */
const SceneAreaMemo = memo(SceneArea);
const NavigationMemo = memo(Navigation);

/**
 * The side panel (P25-02, SPEC §4.2): the navigation on the left, the managed agents and the inbox
 * on the right (P25-04, P25-06), and between them the centre: the solar-system scene (P3-01) with
 * the main area — the chat with a brain (P25-03) or the Steward view (P25-05) — docked under it
 * (P4-10). The dock splits the centre with the scene: a handle sets its height, and it minimises
 * to its bar and comes back, remembered per browser. With the scene hidden ("list mode") the main
 * area takes the whole centre. Narrow screens (STACKED_LAYOUT_QUERY) stack the scene, the
 * navigation and the side column in one scrolling area with the dock under it; on a phone
 * (COMPACT_TOP_BAR_QUERY) the navigation leaves the stack for a sheet that slides in from the left
 * (P8-15). The shell is exactly the viewport: the page never scrolls, every column scrolls on its
 * own.
 *
 * Everything comes from the store (TECHNOLOGY §6.3); the selection is the store's too, mirrored in
 * the URL. The managed-agents section (P4-09) and the inbox (P4-12) can each be hidden per
 * browser: the side column holds what is left, and goes when both are hidden.
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
  // The main view in list mode: a deep link (a load, a return from another page) is spent — a
  // scene shown later must not fly to it (P5-01).
  useEffect(() => {
    if (route === 'panel' && !scene.shown) dropDeepLink();
  }, [route, scene.shown]);
  const agents = useManagedAgentsVisibility();
  const inbox = useInboxVisibility();
  // Both sections hidden (P4-12): no side column; the centre takes its width.
  const side = agents.visible || inbox.visible;
  const stacked = useMediaQuery(STACKED_LAYOUT_QUERY);
  // P7-03: list mode on a phone offers the scene with one tap (the bar's toggle is in its menu).
  const compact = useMediaQuery(COMPACT_TOP_BAR_QUERY);
  const offerScene = compact && route === 'panel' && !scene.visible && !scene.failure;
  // P8-15: on a phone the navigation is a sheet that slides in from the left, not a block of the
  // stack; the top bar's "Agents" button and a swipe from the left edge open it.
  const sheeted = compact && route === 'panel';
  const rawSheet = useNavSheet(sheeted);
  // P8-18: on a phone, one main screen at a time — the chat, the inbox or the managed agents.
  const phoneView = usePhoneView(sheeted);
  const fullView = phoneView.view === 'chat' ? undefined : phoneView.view;
  // The sheet and a full view exclude each other: the view (and its history entry) goes first.
  const navSheet = useMemo(
    () => ({
      open: rawSheet.open,
      setOpen: (next: boolean) =>
        next ? closePhoneViewThen(() => rawSheet.setOpen(true)) : rawSheet.setOpen(false),
    }),
    [rawSheet],
  );
  useEdgeSwipe(navSheet, sheeted);
  // A link inside a full view (an agent's card, a card's "open agent") or a page from the menu
  // changes the location: the view closes, and `navigate` has already taken its history entry.
  const selected = useAppStore((s) => selectionKey(s.selection));
  const location = `${route}|${selected}`;
  const lastLocation = useRef(location);
  useEffect(() => {
    if (lastLocation.current === location) return;
    lastLocation.current = location;
    phoneView.close();
  }, [location, phoneView]);
  // A full view opened while the sheet is open (a beacon, a notification): the sheet closes.
  const closeSheet = rawSheet.setOpen;
  const sheetOpen = rawSheet.open;
  useEffect(() => {
    if (fullView && sheetOpen) closeSheet(false);
  }, [fullView, sheetOpen, closeSheet]);
  const dock = useDockPrefs();
  // P8-18: a phone in list mode gives the chat the whole screen (the inbox and the managed agents
  // open full screen from the top bar): nothing shares it, so it neither resizes nor minimises.
  const phoneList = sheeted && !showScene;
  // Minimising makes sense where something else shares the space: the scene, or the stack.
  const collapsible = (stacked || showScene) && !phoneList;
  const open = !collapsible || dock.open;
  const centre = useRef<HTMLDivElement>(null);
  const gridClass = [
    'pnl-grid',
    showScene && 'pnl-grid-scene',
    side && !agents.visible && 'pnl-grid-no-agents',
    side && !inbox.visible && 'pnl-grid-no-inbox',
    !side && 'pnl-grid-no-side',
    stacked && 'pnl-grid-stacked',
    sheeted && 'pnl-grid-nav-sheet',
    // A phone in list mode has nothing above the dock but the scene offer: it fills (P8-18).
    phoneList && 'pnl-grid-dock-fills',
    collapsible && (open ? 'pnl-grid-dock-open' : 'pnl-grid-dock-min'),
  ]
    .filter(Boolean)
    .join(' ');
  useRouteFocus();
  const main = <MainArea dock={dock} collapsible={collapsible} container={centre} />;
  return (
    <ApiContext.Provider value={api}>
      <SettingsProvider api={api}>
        <CardLinksContext.Provider value={true}>
          <div className={showScene ? 'pnl pnl-with-scene' : 'pnl'}>
            <WaitingAnnouncer />
            <AnswerQueueAnnouncer />
            <TopBar
              scene={scene}
              agents={agents}
              inbox={inbox}
              {...(sheeted ? { navSheet } : {})}
              {...(onForget ? { onForget } : {})}
            />
            {/* While the database refuses writes (P8-09): the disk is full, actions refused. */}
            <StorageBanner />
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
                    <>
                      <div
                        className={gridClass}
                        ref={centre}
                        // A full view on a phone covers the chat; it stays mounted, unreachable.
                        inert={fullView !== undefined}
                        {...(fullView ? { 'aria-hidden': true } : {})}
                      >
                        <div className="pnl-stack">
                          {showScene && <SceneAreaMemo onFailure={scene.fail} />}
                          {offerScene && <SceneOffer scene={scene} />}
                          {!sheeted && <NavigationMemo />}
                          {/* P8-18: on a phone the side column's sections open full screen. */}
                          {side && !sheeted && <SideColumn agents={agents} inbox={inbox} />}
                        </div>
                        <ReplayBar sceneShown={showScene} />
                        {main}
                        {sheeted && (
                          <NavSheet control={navSheet}>
                            <NavigationMemo />
                          </NavSheet>
                        )}
                      </div>
                      {sheeted && fullView && (
                        <PhoneFullView view={fullView} onClose={phoneView.close}>
                          {fullView === 'inbox' ? <InboxSection /> : <ManagedAgentsSection />}
                        </PhoneFullView>
                      )}
                    </>
                  ) : (
                    <div className={gridClass}>
                      <NavigationMemo />
                      <div className="pnl-centre" ref={centre}>
                        {showScene && <SceneAreaMemo onFailure={scene.fail} />}
                        <ReplayBar sceneShown={showScene} />
                        {main}
                      </div>
                      {side && <SideColumn agents={agents} inbox={inbox} />}
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
 * The main area, docked (P4-10): a bar — what is selected, its state, its current activity (the
 * status record's, not a typing indicator), the "N new" replies while minimised, the Waykeeper's
 * controls, and the minimise / restore button — over the chat or the Steward view. Minimised,
 * only the bar shows: the body stays mounted and laid out, collapsed to no height and invisible
 * (not `display: none`, which would drop the thread's scroll position), and `inert` and
 * `aria-hidden` so neither the keyboard nor a screen reader reaches it. The live thread, its
 * scroll position and the "N new" count survive; a draft lives in the conversation store. Not
 * collapsible (list mode on a wide screen), it is simply the centre.
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
  const view = useDockView((s) => s.view);
  // An answered question, a closed confirmation: the focus stays in the main area (P5-04) — on
  // the next open question's card (the thread's inline cards, the Steward view's question cards
  // and its clarification box) when one is left, else on the main area's title.
  const mainRef = useRef<HTMLElement>(null);
  useFocusRescue(mainRef, {
    items: MAIN_QUESTION,
    target: (item) =>
      item.matches('form') ? (item.querySelector<HTMLElement>('textarea') ?? item) : item,
    fallback: (main) => main.querySelector<HTMLElement>('h1'),
  });

  let content;
  if (!agent) {
    content =
      selection.kind === 'harmonizer' ? (
        // No Harmonizer row (decision 44; where every deselect lands): the system status still
        // shows — it needs no agent; only its "Ask the Harmonizer" button is disabled (P5-02).
        view === 'status' ? (
          <div className="sts-pane sts-pane-status">
            <SystemStatusView />
          </div>
        ) : (
          <Empty>
            No Harmonizer is running. Start Mission Control with <code>galactic start</code>.
          </Empty>
        )
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
    // The Harmonizer or a Waykeeper: the conversation (P25-03), or its status view (P5-02).
    content = (
      <BrainDock agent={agent}>
        <Conversation key={agent.id} agentId={agent.id} />
      </BrainDock>
    );
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
  // The landmark says who it is about: "Conversation with Harmonizer", "Steward · <task>".
  const label = !agent
    ? 'main area'
    : agent.role === 'steward'
      ? agentLabel(agent, world)
      : `Conversation with ${agentLabel(agent, world)}`;
  return (
    <main
      ref={mainRef}
      className={className}
      aria-label={label}
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
      <div
        className="pnl-dock-body"
        id={DOCK_BODY_ID}
        inert={!open}
        {...(open ? {} : { 'aria-hidden': true })}
      >
        {content}
      </div>
    </main>
  );
}

/**
 * The dock's bar (P4-10): who is selected, its state ("blocked on you" first for a Steward), the
 * "N new" replies that came while minimised, its activity, the way back to the Harmonizer, the
 * Waykeeper's controls (P4-09) or the Harmonizer's (P5-06), and the minimise / restore button
 * where the dock can minimise.
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
  // Survives the remount of the Harmonizer's controls (keyed by its id) across a restart.
  const restartFocusRef = useRef<RestartFocus | undefined>(undefined);
  return (
    <div className="pnl-main-head pnl-dock-bar">
      <div className="pnl-dock-titles">
        <p className="pnl-eyebrow">{eyebrow}</p>
        {/* Focusable for the Harmonizer's restart (P5-06): focus waits here meanwhile. */}
        <h1 className="pnl-title" tabIndex={-1}>
          {agent ? agentLabel(agent, world) : role}
        </h1>
      </div>
      {agent && (
        <span className="pnl-dock-state">
          {blocked && <Beacon>blocked on you</Beacon>}
          <StatePill state={status?.state} />
          {minimised && agent.role !== 'steward' && (
            <UnreadReplies key={agent.id} agentId={agent.id} />
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
      {agent?.role === 'harmonizer' && (
        // P5-06 (decision 82): pause / resume, "Resume session" when interrupted, and restart.
        <HarmonizerControls
          key={agent.id}
          agentId={agent.id}
          status={status}
          name={agentLabel(agent, world)}
          restartFocusRef={restartFocusRef}
        />
      )}
      {(agent ? agent.role !== 'steward' : selection.kind === 'harmonizer') && (
        <DockViewToggle
          role={agent?.role === 'waykeeper' ? 'waykeeper' : 'harmonizer'}
          projectId={agent?.role === 'waykeeper' ? agent.projectId : undefined}
        />
      )}
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
 * The right column: the managed-agents section (P25-04) and the inbox (P25-06). Each hides on its
 * own (P4-09, P4-12) and comes back from the top bar; the panel drops the column when both are.
 */
const SideColumn = memo(function SideColumn({
  agents,
  inbox,
}: {
  agents: ManagedAgentsControl;
  inbox: InboxControl;
}) {
  return (
    <aside
      className="pnl-side"
      aria-label={
        agents.visible && inbox.visible
          ? 'managed agents and inbox'
          : agents.visible
            ? 'managed agents column'
            : 'inbox column'
      }
    >
      {agents.visible && (
        <ManagedAgentsSection
          onHide={() => {
            agents.setVisible(false);
            focusAfterRemoval('.pnl-agents-toggle', '.pnl-menu-button', '.pnl-inbox');
          }}
        />
      )}
      {inbox.visible && (
        <InboxSection
          onHide={() => {
            inbox.setVisible(false);
            focusAfterRemoval('.pnl-inbox-toggle', '.pnl-menu-button', '.pnl-nav-hq');
          }}
        />
      )}
    </aside>
  );
});

/**
 * The managed agents (P25-04): in the side column with its "Hide" (P4-09), or the phone's full
 * view (P8-18) without one — the view's header names it.
 */
function ManagedAgentsSection({ onHide }: { onHide?: () => void }) {
  const world = useAppStore((s) => s.world);
  const selection = useAppStore((s) => s.selection);
  const agent = selectedAgent(world, selection);
  const supervisor: Id | undefined = agent?.role === 'steward' ? agent.supervisorId : undefined;
  // P5-04: arrow keys between the cards, and the focus kept in the list when a card goes away.
  const ref = useRef<HTMLElement>(null);
  useFocusRescue(ref, {
    items: AGENT_CARD,
    fallback: (s) => s.querySelector<HTMLElement>('h2') ?? s,
  });
  return (
    <section aria-label="managed agents" ref={ref} onKeyDown={listKeys(AGENT_CARD)}>
      {onHide && (
        <div className="pnl-side-head">
          <h2 className="pnl-eyebrow">{supervisor ? 'Reports to' : 'Managed agents'}</h2>
          <button
            type="button"
            className="pnl-side-hide"
            aria-label="Hide managed agents"
            title="Hide managed agents (bring them back from the top bar)"
            onClick={onHide}
          >
            Hide
          </button>
        </div>
      )}
      {supervisor ? <AgentLinks ids={[supervisor]} /> : <ManagedAgentCards supervisor={agent} />}
    </section>
  );
}

/** The inbox (P25-06): in the side column, or the phone's full view (P8-18) without its head. */
function InboxSection({ onHide }: { onHide?: () => void }) {
  const ref = useRef<HTMLElement>(null);
  useFocusRescue(ref, { items: INBOX_CARD, fallback: (s) => s });
  return (
    <section
      className="pnl-inbox"
      aria-label="inbox"
      id={INBOX_ID}
      tabIndex={-1}
      ref={ref}
      onKeyDown={listKeys(INBOX_CARD)}
    >
      <Inbox {...(onHide ? { onHide } : { withHead: false })} />
    </section>
  );
}

/** The items the arrow keys move between (P5-04): the managed agents' cards, the inbox's cards. */
const AGENT_CARD = 'article.agc, .pnl-agents > li > a';
const INBOX_CARD = 'article.card';
/** The main area's open questions: their cards and the Steward view's clarification box. */
const MAIN_QUESTION = 'article.card.question:not(.answered), form.stw-composer';

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
