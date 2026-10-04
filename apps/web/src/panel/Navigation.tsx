import {
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import type { Id } from '@galactic/protocol';
import { useAppStore } from '../state/store.js';
import { summaryOf } from '../state/reduce.js';
import {
  HARMONIZER,
  pathFor,
  sameSelection,
  type PageLocation,
  type Selection,
} from '../state/selection.js';
import { currentHarmonizer } from '../console/hierarchy/HierarchyConsole.js';
import {
  buildNav,
  childContainsAgent,
  hasBlockedChild,
  type NavItem,
  type StewardCount,
} from './nav-model.js';
import { NavRowActions } from './nav-row-actions.js';
import { focusElement, listItems, useFocusRescue, usesOwnArrows } from './a11y.js';

/** Per browser (P4-12): whether the navigation lists closed work. Off by default. */
export const SHOW_CLOSED_KEY = 'galactic.panel.nav.showClosed';

function readShowClosed(): boolean {
  try {
    return localStorage.getItem(SHOW_CLOSED_KEY) === '1';
  } catch {
    return false;
  }
}

function useShowClosed(): [boolean, (show: boolean) => void] {
  const [show, setShow] = useState(readShowClosed);
  const set = useCallback((next: boolean) => {
    try {
      localStorage.setItem(SHOW_CLOSED_KEY, next ? '1' : '0');
    } catch {
      // No storage (private mode): the choice lasts for this page only.
    }
    setShow(next);
  }, []);
  return [show, set];
}

/**
 * The panel's left navigation (P25-02): the Harmonizer first and always one click away, then the
 * projects (their Waykeepers; sub-projects and tasks nested) and the standalone asteroid tasks.
 * Every row carries its derived state; "blocked on you" is the loud badge and sorts first.
 * Closed work (completed or archived) is hidden behind "Show closed" (P4-12), and every row's "⋯"
 * opens its work actions (close, cancel, archive…), so leftover work can be cleared from here.
 */
export function Navigation() {
  const world = useAppStore((s) => s.world);
  const selection = useAppStore((s) => s.selection);
  const [showClosed, setShowClosed] = useShowClosed();
  const selectedAgent = selection.kind === 'harmonizer' ? undefined : selection.id;
  const nav = useMemo(
    () => buildNav(world, { showClosed, selectedAgent }),
    [world, showClosed, selectedAgent],
  );
  const harmonizer = currentHarmonizer(world);
  const waiting = summaryOf(world).userQuestions;
  // P5-04: a row archived from its "⋯" leaves the list; the focus goes to the row now in its place.
  const ref = useRef<HTMLElement>(null);
  useFocusRescue(ref, {
    items: '.pnl-nav-hq, li.pnl-row',
    target: (item) =>
      rowTarget(
        item.matches('li') ? item.querySelector<HTMLElement>(':scope > .pnl-row-line')! : item,
      ),
    fallback: (n) => n.querySelector<HTMLElement>('.pnl-nav-hq'),
  });

  return (
    <nav className="pnl-nav" aria-label="navigation" ref={ref} onKeyDown={navKeys}>
      <NavLink
        to={{ route: 'panel', selection: HARMONIZER }}
        current={selection.kind === 'harmonizer'}
        className="pnl-nav-hq"
      >
        <span className="pnl-nav-name">Harmonizer</span>
        <span className="pnl-nav-sub">
          {harmonizer ? (world.statuses[harmonizer.id]?.state ?? 'unknown') : 'not running'}
        </span>
        {waiting > 0 && <Beacon>{waiting} for you</Beacon>}
      </NavLink>

      <h2 className="pnl-eyebrow">Projects</h2>
      {nav.projects.length === 0 ? (
        <p className="pnl-empty">No projects yet. Ask the Harmonizer to start one.</p>
      ) : (
        <ul className="pnl-tree">
          {nav.projects.map((item) => (
            <NavRow
              key={item.key}
              item={item}
              selection={selection}
              selectedAgent={selectedAgent}
            />
          ))}
        </ul>
      )}

      <h2 className="pnl-eyebrow">Asteroids</h2>
      {nav.asteroids.length === 0 ? (
        <p className="pnl-empty">No standalone tasks.</p>
      ) : (
        <ul className="pnl-tree">
          {nav.asteroids.map((item) => (
            <NavRow
              key={item.key}
              item={item}
              selection={selection}
              selectedAgent={selectedAgent}
            />
          ))}
        </ul>
      )}

      <label className="pnl-check">
        <input
          type="checkbox"
          checked={showClosed}
          onChange={(e) => setShowClosed(e.target.checked)}
        />
        Show closed
        {!showClosed && nav.hiddenClosed > 0 && (
          <span className="pnl-check-count">({nav.hiddenClosed} hidden)</span>
        )}
      </label>
    </nav>
  );
}

/** The navigation's rows, in order: the Harmonizer, then every listed project and task row. */
const NAV_ROW = '.pnl-nav-hq, .pnl-row-line';

/**
 * The navigation's keys (P5-04), a light version of the ARIA tree pattern that keeps the rows as
 * links (with `aria-current`) and Tab as it is — every link and button stays a Tab stop:
 * - Down / Up: the next or previous row's link (from anywhere in a row: its link, "+", "⋯");
 * - Home / End: the first row (the Harmonizer) and the last;
 * - Right: opens a closed row's nested work, or goes to its first nested row once open;
 * - Left: closes an open row, or goes to the row it is nested in.
 * A row with no agent yet has no link: its disclosure or "⋯" button takes the focus instead.
 */
export function navKeys(e: KeyboardEvent<HTMLElement>) {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowRight', 'ArrowLeft'];
  if (!keys.includes(e.key)) return;
  const target = e.target as HTMLElement;
  if (usesOwnArrows(target) || target.closest('.pnl-row-actions')) return;
  const rows = listItems(e.currentTarget, NAV_ROW);
  const current = rows.findIndex((r) => r === target || r.contains(target));
  if (current < 0) return;
  const row = rows[current]!;
  const li = row.closest('li');
  const disclose = row.querySelector<HTMLButtonElement>(':scope > .pnl-disclose');
  let to: HTMLElement | undefined;
  if (e.key === 'ArrowDown') to = rows[current + 1];
  else if (e.key === 'ArrowUp') to = rows[current - 1];
  else if (e.key === 'Home') to = rows[0];
  else if (e.key === 'End') to = rows[rows.length - 1];
  else if (e.key === 'ArrowRight') {
    if (!disclose) return;
    if (disclose.getAttribute('aria-expanded') !== 'true') {
      e.preventDefault();
      disclose.click();
      return;
    }
    to = li?.querySelector<HTMLElement>(':scope > ul > li > .pnl-row-line') ?? undefined;
  } else {
    if (disclose?.getAttribute('aria-expanded') === 'true') {
      e.preventDefault();
      disclose.click();
      // The focus stays on the row (its link, or the "+" that was pressed).
      if (!row.contains(document.activeElement)) focusElement(rowTarget(row));
      return;
    }
    to =
      li?.parentElement?.closest('li')?.querySelector<HTMLElement>(':scope > .pnl-row-line') ??
      undefined;
  }
  e.preventDefault();
  if (to) focusElement(rowTarget(to));
}

/** What takes the focus in a row: its link, else (no agent yet) its first button. */
function rowTarget(row: HTMLElement): HTMLElement {
  if (row.matches('a')) return row;
  return (
    row.querySelector<HTMLElement>(':scope > a.pnl-link') ??
    row.querySelector<HTMLElement>('button') ??
    row
  );
}

function NavRow({
  item,
  selection,
  selectedAgent,
}: {
  item: NavItem;
  selection: Selection;
  selectedAgent: Id | undefined;
}) {
  // Nested work shows while something in it is selected or waits for the user; selecting the
  // item itself (a project's Waykeeper) keeps the row compact (P4-09). The disclosure button
  // overrides both.
  const auto = childContainsAgent(item, selectedAgent) || hasBlockedChild(item);
  const [toggled, setToggled] = useState<boolean | undefined>();
  const open = toggled ?? auto;
  const [acting, setActing] = useState(false);
  const actionsId = useId();
  const current = item.selection !== undefined && sameSelection(item.selection, selection);
  const label = (
    <>
      <span className="pnl-nav-name">{item.label}</span>
      <span className={`pnl-nav-sub state-${item.state}`}>{item.state.replace(/_/g, ' ')}</span>
      {item.stewards && item.stewards.total > 0 && <StewardBadge count={item.stewards} />}
      {item.blocked && <Beacon>blocked on you</Beacon>}
    </>
  );
  return (
    <li
      className={`pnl-row pnl-row-${item.kind}${item.blocked ? ' is-blocked' : ''}${item.closed ? ' is-closed' : ''}`}
      aria-label={`${item.kind} ${item.label}`}
    >
      <div className="pnl-row-line">
        {item.children.length > 0 ? (
          <button
            type="button"
            className="pnl-disclose"
            aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} the work in ${item.label}`}
            onClick={() => setToggled(!open)}
          >
            {open ? '−' : '+'}
          </button>
        ) : (
          <span className="pnl-disclose-gap" />
        )}
        {item.selection ? (
          <NavLink to={{ route: 'panel', selection: item.selection }} current={current}>
            {label}
          </NavLink>
        ) : (
          <span className="pnl-link is-inert" title="No agent works on this yet">
            {label}
          </span>
        )}
        <button
          type="button"
          className={`pnl-row-more${acting ? ' is-open' : ''}`}
          aria-expanded={acting}
          aria-controls={acting ? actionsId : undefined}
          aria-label={`Actions for ${item.label}`}
          title={`Close, cancel, archive… this ${item.kind}`}
          onClick={() => setActing((a) => !a)}
        >
          <span aria-hidden="true">⋯</span>
        </button>
      </div>
      {acting && (
        <NavRowActions
          groupId={actionsId}
          kind={item.kind}
          id={item.id}
          label={item.label}
          onDone={() => setActing(false)}
        />
      )}
      {open && item.children.length > 0 && (
        <ul className="pnl-tree pnl-tree-nested">
          {item.children.map((c) => (
            <NavRow key={c.key} item={c} selection={selection} selectedAgent={selectedAgent} />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * A project's Steward count (P4-09), by task: "2 active, 3 in total" — its tasks whose Steward
 * is working now (a paused one is not active) and all its tasks that have had a Steward. The
 * tooltip and screen readers get the same words, naming the Stewards.
 */
function StewardBadge({ count }: { count: StewardCount }) {
  const short = `${count.active} active, ${count.total} in total`;
  const words = `Stewards: ${short}`;
  return (
    <span className={`pnl-nav-stewards${count.active > 0 ? ' is-busy' : ''}`} title={words}>
      <span aria-hidden="true">{short}</span>
      <span className="pnl-visually-hidden">{words}</span>
    </span>
  );
}

/** The loud "blocked on user" badge (SPEC §4.4): the panel's version of the scene's beacon. */
export function Beacon({ children }: { children: ReactNode }) {
  return <span className="pnl-beacon">{children}</span>;
}

/**
 * A real link (so it can be opened in a new tab or copied) that navigates in place through the
 * store on a plain click.
 */
export function NavLink({
  to,
  current = false,
  className,
  children,
}: {
  to: PageLocation;
  current?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const navigate = useAppStore((s) => s.navigate);
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a
      href={pathFor(to)}
      onClick={onClick}
      aria-current={current ? 'page' : undefined}
      className={`pnl-link${current ? ' is-current' : ''}${className ? ` ${className}` : ''}`}
    >
      {children}
    </a>
  );
}
