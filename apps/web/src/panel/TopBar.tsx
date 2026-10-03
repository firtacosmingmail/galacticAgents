import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { useAppStore } from '../state/store.js';
import { summaryOf } from '../state/reduce.js';
import { HARMONIZER } from '../state/selection.js';
import type { SceneControl } from '../scene/visibility.js';
import type { ManagedAgentsControl } from './managed-agents-visibility.js';
import { waitingForUserCount } from './inbox-model.js';
import { Beacon, NavLink } from './Navigation.js';
import { NotificationsControl, NotificationsDisclosure } from './notifications/index.js';
import { COMPACT_TOP_BAR_QUERY, useMediaQuery } from './use-media-query.js';

/** The inbox section's id, for the compact bar's "waiting for you" button (P3-12). */
export const INBOX_ID = 'pnl-inbox';
const MENU_ID = 'pnl-top-menu';

interface TopBarProps {
  scene: SceneControl;
  /** The managed-agents section's visibility (P4-09); absent, no toggle shows. */
  agents?: ManagedAgentsControl;
  onForget?: () => void;
}

/**
 * The panel's top bar (P25-02). Wide, every control sits in the bar. Narrow (P3-12,
 * `COMPACT_TOP_BAR_QUERY`), only the essentials stay in one row — the brand (back to the
 * Harmonizer), the connection dot, the "waiting for you" count and a menu button — and every other
 * action moves into the menu.
 */
export function TopBar(props: TopBarProps) {
  const compact = useMediaQuery(COMPACT_TOP_BAR_QUERY);
  return compact ? <CompactTopBar {...props} /> : <WideTopBar {...props} />;
}

function WideTopBar({ scene, agents, onForget }: TopBarProps) {
  const status = useAppStore((s) => s.status);
  const route = useAppStore((s) => s.route);
  const selection = useAppStore((s) => s.selection);
  const world = useAppStore((s) => s.world);
  const summary = summaryOf(world);
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
      {/* Hiding is the column header's button; the bar brings the section back (P4-09). */}
      {agents && !agents.visible && <ManagedAgentsToggle agents={agents} />}
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
 * Scrolls the inbox into view and focuses it, once it is mounted: from the settings or history
 * page the panel first navigates back to the main view, whose columns may wait for the settings
 * read (P25-08's gate), so this looks for the inbox over a few frames. While the first-run wizard
 * shows, the inbox never mounts: it gives up after about a second, having still navigated home.
 */
function revealInbox(triesLeft = 60) {
  const inbox = document.getElementById(INBOX_ID);
  if (inbox) {
    inbox.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    inbox.focus({ preventScroll: true });
    return;
  }
  if (triesLeft > 0) requestAnimationFrame(() => revealInbox(triesLeft - 1));
}

function CompactTopBar({ scene, agents, onForget }: TopBarProps) {
  const status = useAppStore((s) => s.status);
  const route = useAppStore((s) => s.route);
  const selection = useAppStore((s) => s.selection);
  const navigate = useAppStore((s) => s.navigate);
  const world = useAppStore((s) => s.world);
  const summary = summaryOf(world);
  const waiting = waitingForUserCount(world);
  const statusText = status.replace(/_/g, ' ');

  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }, []);

  // Opening moves focus to the menu's first item.
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('a[href], button:not([disabled])')?.focus();
  }, [open]);

  // Escape closes and gives focus back to the button; a tap or click outside closes and leaves
  // focus where the user put it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(true);
      }
    };
    const onDown = (e: PointerEvent | MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open, close]);

  // Any navigation (a menu link, the brand, the back button) closes the menu.
  const location = `${route}|${JSON.stringify(selection)}`;
  const lastLocation = useRef(location);
  useEffect(() => {
    if (lastLocation.current === location) return;
    lastLocation.current = location;
    setOpen(false);
  }, [location]);

  // Tabbing out of the menu closes it.
  const onBlur = (e: ReactFocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null;
    if (!next || menuRef.current?.contains(next) || buttonRef.current?.contains(next)) return;
    setOpen(false);
  };

  // A menu link or button returns focus to the menu button once it has done its work.
  const onMenuClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const item = (e.target as HTMLElement).closest('a, button');
    if (!item || item.closest('.ntf-disclosure')) return;
    // (The managed-agents toggle shares the scene toggle's class.)
    if (item.classList.contains('pnl-scene-toggle') || item.tagName === 'A') close(true);
  };

  const openInbox = () => {
    setOpen(false);
    if (route !== 'panel') navigate({ route: 'panel', selection });
    revealInbox();
  };

  return (
    <header className="pnl-top pnl-top-compact">
      <NavLink to={{ route: 'panel', selection: HARMONIZER }} className="pnl-brand">
        GalacticAgents
      </NavLink>
      <span
        className={`pnl-conn pnl-conn-dot pnl-conn-${status}`}
        role="img"
        aria-label={`connection: ${statusText}`}
        title={statusText}
      />
      <span className="pnl-spacer" />
      {waiting > 0 && (
        <button
          type="button"
          className="pnl-top-waiting"
          aria-label={`${waiting} waiting for you`}
          title="Open the inbox"
          onClick={openInbox}
        >
          <Beacon>
            <span>
              {waiting} waiting<span className="pnl-top-waiting-tail"> for you</span>
            </span>
          </Beacon>
        </button>
      )}
      <button
        ref={buttonRef}
        type="button"
        className="pnl-menu-button"
        aria-expanded={open}
        aria-controls={MENU_ID}
        aria-label="Menu"
        onClick={() => (open ? close(true) : setOpen(true))}
      >
        <span className="pnl-menu-icon" aria-hidden="true" />
      </button>
      <div
        id={MENU_ID}
        ref={menuRef}
        className="pnl-menu"
        role="region"
        aria-label="menu"
        hidden={!open}
        onBlur={onBlur}
        onClick={onMenuClick}
      >
        {open && (
          <>
            <p className="pnl-menu-summary" aria-label="summary">
              <span className={`pnl-conn pnl-conn-${status}`}>{statusText}</span>
              <span>{summary.openQuestions} open questions</span>
              <span>{summary.blockedItems} blocked</span>
            </p>
            <SceneToggle scene={scene} />
            {agents && <ManagedAgentsToggle agents={agents} />}
            <NotificationsDisclosure />
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
            {onForget && (
              <button type="button" className="pnl-forget" onClick={onForget}>
                Forget token
              </button>
            )}
            <NavLink to={{ route: 'debug', selection: HARMONIZER }} className="pnl-debug-link">
              Ops console
            </NavLink>
          </>
        )}
      </div>
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
 * Shows or hides the side column's managed-agents section (P4-09). The wide bar offers it only
 * while the section is hidden (the section's own header hides it); the phone menu always does.
 */
function ManagedAgentsToggle({ agents }: { agents: ManagedAgentsControl }) {
  return (
    <button
      type="button"
      className="pnl-scene-toggle pnl-agents-toggle"
      onClick={() => agents.setVisible(!agents.visible)}
    >
      {agents.visible ? 'Hide managed agents' : 'Show managed agents'}
    </button>
  );
}
