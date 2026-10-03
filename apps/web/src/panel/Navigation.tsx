import { useMemo, useState, type MouseEvent, type ReactNode } from 'react';
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

/**
 * The panel's left navigation (P25-02): the Harmonizer first and always one click away, then the
 * projects (their Waykeepers; sub-projects and tasks nested) and the standalone asteroid tasks.
 * Every row carries its derived state; "blocked on you" is the loud badge and sorts first.
 */
export function Navigation() {
  const world = useAppStore((s) => s.world);
  const selection = useAppStore((s) => s.selection);
  const [showArchived, setShowArchived] = useState(false);
  const nav = useMemo(() => buildNav(world, { showArchived }), [world, showArchived]);
  const harmonizer = currentHarmonizer(world);
  const waiting = summaryOf(world).userQuestions;
  const selectedAgent = selection.kind === 'harmonizer' ? undefined : selection.id;

  return (
    <nav className="pnl-nav" aria-label="navigation">
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
          checked={showArchived}
          onChange={(e) => setShowArchived(e.target.checked)}
        />
        Show archived work
      </label>
    </nav>
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
      className={`pnl-row pnl-row-${item.kind}${item.blocked ? ' is-blocked' : ''}`}
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
      </div>
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
