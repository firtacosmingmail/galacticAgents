import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { Id, JobRun } from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import { useApi } from '../../console/hierarchy/shared.js';
import { useMediaQuery, COMPACT_TOP_BAR_QUERY } from '../use-media-query.js';
import { useDockView } from '../status/dock-view.js';
import { runLine, whenText } from './jobs-model.js';
import {
  collectNode,
  durationText,
  highlight,
  jobMapModel,
  nodeLabels,
  panelNode,
  sourceNode,
  type MapSource,
} from './job-map-model.js';
import './job-map.css';

/**
 * The job map (P15-09; SPEC decision 156, the approved "pipeline" look): an overlay over the
 * current view showing, left to right, "Gathers from" → "Collects" → "Processes" → "Shown in",
 * under a run bar with the last run, the next run and the schedule. Hovering or focusing a node
 * (or tapping it, on touch) lights it and everything linked to it both ways and dims the rest.
 * A panel chip switches to the Dashboard view and scrolls to that panel. On a phone the columns
 * stack and each node lists its links as text instead of drawing connectors.
 */

export const NO_MAP_TEXT = 'This job has no data map yet — ask the Waykeeper to add one';

const COLUMNS = [
  { key: 'sources', title: 'Gathers from' },
  { key: 'collects', title: 'Collects' },
  { key: 'steps', title: 'Processes' },
  { key: 'panels', title: 'Shown in' },
] as const;

interface Line {
  key: string;
  from: string;
  to: string;
  d: string;
}

const STATE_TEXT: Record<'unused' | 'undeclared', string> = {
  unused: 'not used last run',
  undeclared: 'not declared',
};

export function JobMap({ jobId, onClose }: { jobId: Id; onClose: () => void }) {
  const api = useApi();
  const job = useAppStore((s) => s.world.jobs[jobId]);
  const panels = useAppStore((s) => s.world.panels);
  const stacked = useMediaQuery(COMPACT_TOP_BAR_QUERY);
  const showPanel = useDockView((s) => s.showPanel);
  const [lastRun, setLastRun] = useState<JobRun>();
  const [now] = useState(() => new Date());
  const stamp = `${job?.lastRun?.runId ?? ''}:${job?.lastRun?.outcome ?? ''}`;
  useEffect(() => {
    let live = true;
    api.jobRuns(jobId, 1).then(
      (r) => live && setLastRun(r.runs[0]),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api, jobId, stamp]);

  const model = useMemo(
    () => (job ? jobMapModel(job, lastRun, Object.values(panels)) : undefined),
    [job, lastRun, panels],
  );

  const [hover, setHover] = useState<string>();
  const [focus, setFocus] = useState<string>();
  const [pin, setPin] = useState<string>();
  const active = pin ?? hover ?? focus;
  const lit = useMemo(
    () => (model && active ? highlight(model, active) : undefined),
    [model, active],
  );

  // Focus: into the dialog on open, back to the opener on close.
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => {
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);
  // Escape and Tab are handled on the document, so they work wherever focus is (clicking plain
  // text in the dialog leaves it on the body) and Tab cannot escape into the background.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      const dialog = dialogRef.current;
      if (e.key !== 'Tab' || !dialog) return;
      const items = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled])')];
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const here = document.activeElement;
      if (!dialog.contains(here)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && here === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && here === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Connectors: measured between the nodes, again when the window or the content resizes.
  const gridRef = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const measure = useCallback(() => {
    const grid = gridRef.current;
    if (!grid || !model || stacked) return setLines([]);
    const origin = grid.getBoundingClientRect();
    const rects = new Map<string, DOMRect>();
    grid.querySelectorAll<HTMLElement>('[data-node]').forEach((el) => {
      rects.set(el.dataset.node!, el.getBoundingClientRect());
    });
    const next: Line[] = [];
    for (const e of model.edges) {
      const a = rects.get(e.from);
      const b = rects.get(e.to);
      if (!a || !b) continue;
      const [l, r] = a.left <= b.left ? [a, b] : [b, a];
      const x1 = l.right - origin.left;
      const y1 = l.top + l.height / 2 - origin.top;
      const x2 = r.left - origin.left;
      const y2 = r.top + r.height / 2 - origin.top;
      const mid = (x1 + x2) / 2;
      next.push({
        key: `${e.from}>${e.to}`,
        from: e.from,
        to: e.to,
        d: `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`,
      });
    }
    setLines(next);
  }, [model, stacked]);
  useLayoutEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    const grid = gridRef.current;
    const ro = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    if (grid) ro?.observe(grid);
    return () => {
      window.removeEventListener('resize', measure);
      ro?.disconnect();
    };
  }, [measure]);

  if (!job || !model) return null;
  const labels = nodeLabels(model);
  const problemSources = new Set(
    model.sources.filter((s) => s.state === 'problem').map((s) => sourceNode(s.id)),
  );
  const { header } = model;

  const nodeClass = (id: string, extra = ''): string =>
    ['jm-node', extra, lit?.has(id) ? 'is-lit' : '', lit && !lit.has(id) ? 'is-dim' : '']
      .filter(Boolean)
      .join(' ');
  const hoverProps = (id: string) => ({
    'data-node': id,
    onMouseEnter: () => setHover(id),
    onMouseLeave: () => setHover(undefined),
    onFocus: () => setFocus(id),
    onBlur: () => setFocus(undefined),
  });
  const links = (id: string): ReactNode => {
    if (!stacked) return null;
    const out = model.edges
      .filter((e) => e.from === id)
      .map((e) => ({ id: e.to, label: labels.get(e.to) ?? e.to }));
    if (out.length === 0) return null;
    return (
      <ul className="jm-links">
        {out.map((l) => (
          <li key={l.id}>→ {l.label}</li>
        ))}
      </ul>
    );
  };
  // A tap pins the node (a second tap unpins it). The click also drops hover and focus, which a
  // touch tap or the click itself leaves set, so the second tap really unlights it.
  const tap = (id: string) => () => {
    setHover(undefined);
    setFocus(undefined);
    setPin((p) => (p === id ? undefined : id));
  };

  const sourceNodeView = (s: MapSource) => {
    const id = sourceNode(s.id);
    return (
      <li key={id}>
        <button
          type="button"
          className={nodeClass(id, `jm-source is-${s.state}`)}
          aria-pressed={pin === id}
          {...hoverProps(id)}
          onClick={tap(id)}
        >
          <span className="jm-name">{s.label}</span>
          <span className="jm-sub">
            {s.kind} · {s.target}
          </span>
          {s.state === 'problem' && (
            <>
              <span className="jm-state is-problem">problem</span>
              <span className="jm-sub">{s.problem}</span>
            </>
          )}
          {(s.state === 'unused' || s.state === 'undeclared') && (
            <span className="jm-state is-muted">{STATE_TEXT[s.state]}</span>
          )}
        </button>
        {links(id)}
      </li>
    );
  };

  return createPortal(
    <div className="jm-backdrop">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Data map of ${job.name}`}
        className={`jm${lit ? ' is-highlighting' : ''}${stacked ? ' is-stacked' : ''}`}
      >
        <header className="jm-head">
          <h2 className="jm-title">{job.name}</h2>
          <button ref={closeRef} type="button" className="secondary" onClick={onClose}>
            Close
          </button>
        </header>
        <p className="jm-bar">
          <span>
            <b>Last run</b>{' '}
            {header.lastRun
              ? `${runLine(header.lastRun, now)}${
                  header.lastRun.durationMs === undefined
                    ? ''
                    : ` · took ${durationText(header.lastRun.durationMs)}`
                }`
              : 'none yet'}
          </span>
          <span>
            <b>Next run</b> {header.nextRunAt ? whenText(header.nextRunAt, now) : 'not scheduled'}
          </span>
          <span>
            <b>Schedule</b> {header.schedule}
          </span>
        </p>
        {!model.hasMap && <p className="jm-empty">{NO_MAP_TEXT}</p>}
        <div className="jm-grid" ref={gridRef}>
          {!stacked && (
            <svg className="jm-lines" aria-hidden="true" focusable="false">
              {lines.map((l) => {
                const both = lit?.has(l.from) && lit.has(l.to);
                const cls = [
                  'jm-line',
                  both ? 'is-lit' : '',
                  lit && !both ? 'is-dim' : '',
                  problemSources.has(l.from) ? 'is-problem' : '',
                ]
                  .filter(Boolean)
                  .join(' ');
                return <path key={l.key} d={l.d} className={cls} />;
              })}
            </svg>
          )}
          {COLUMNS.map((col) => (
            <section key={col.key} className="jm-col" aria-labelledby={`jm-h-${col.key}`}>
              <h3 id={`jm-h-${col.key}`} className="jm-col-title">
                {col.title}
              </h3>
              <ul className="jm-nodes">
                {col.key === 'sources' && model.sources.map(sourceNodeView)}
                {col.key === 'collects' &&
                  model.collects.map((c) => {
                    const id = collectNode(c.name);
                    return (
                      <li key={id}>
                        <button
                          type="button"
                          className={nodeClass(id, 'jm-collect')}
                          aria-pressed={pin === id}
                          {...hoverProps(id)}
                          onClick={tap(id)}
                        >
                          <span className="jm-name">{c.name}</span>
                          <span className="jm-sub">
                            {c.kind}
                            {c.description ? ` · ${c.description}` : ''}
                          </span>
                        </button>
                        {links(id)}
                      </li>
                    );
                  })}
                {col.key === 'steps' &&
                  model.steps.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        className={nodeClass(s.id, 'jm-step')}
                        aria-pressed={pin === s.id}
                        {...hoverProps(s.id)}
                        onClick={tap(s.id)}
                      >
                        <span className="jm-name">{s.text}</span>
                      </button>
                      {links(s.id)}
                    </li>
                  ))}
                {col.key === 'panels' &&
                  model.shownIn.map((p) => {
                    const id = panelNode(p.panelId);
                    return (
                      <li key={id}>
                        <button
                          type="button"
                          className={nodeClass(id, 'jm-panel')}
                          {...hoverProps(id)}
                          onClick={() => {
                            showPanel(p.panelId);
                            onClose();
                          }}
                        >
                          <span className="jm-name">{p.title}</span>
                          <span className="jm-sub">{p.values.join(', ')}</span>
                        </button>
                      </li>
                    );
                  })}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
