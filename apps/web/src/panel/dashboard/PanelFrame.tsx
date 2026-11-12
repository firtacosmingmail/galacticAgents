import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Panel, PanelData } from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import { useApi } from '../../console/hierarchy/shared.js';
import { useReducedMotion } from '../../scene/motion.js';
import { useDockView } from '../status/dock-view.js';
import { JobMap } from '../jobs/JobMap.js';
import { revealInbox, revealQuestion } from '../inbox-reveal.js';
import { celebrated, markCelebrated } from './celebrated.js';
import { Fireworks } from './Fireworks.js';
import { ageText, shownVerdict, verdictArrow, verdictWord } from './format.js';
import { BarChart } from './panels/BarChart.js';
import { CalendarPanel } from './panels/CalendarPanel.js';
import { LineChart } from './panels/LineChart.js';
import { ListPanel } from './panels/ListPanel.js';
import { StatusBoardPanel } from './panels/StatusBoardPanel.js';
import { TablePanel } from './panels/TablePanel.js';
import { TextPanel } from './panels/TextPanel.js';
import { TilePanel } from './panels/TilePanel.js';

export const CLEAR_HISTORY_TEXT =
  "Clear this panel's history? Its charts and comparisons start again from the next run. This can't be undone.";

/** The state line under the title: what a not-quite-current panel tells the user. */
function stateNote(panel: Panel, data: PanelData, now: Date): string | undefined {
  switch (data.status) {
    case 'stale':
      return `last good value ${ageText(data.lastGoodAt, now)}`.trim();
    case 'job_paused':
      return 'Job paused';
    case 'job_stopped':
      return 'Job stopped';
    case 'not_reported':
      return 'No longer reported';
    case 'empty':
      return panel.historyFrom ? 'No data since history was cleared' : 'No data yet';
    default:
      return undefined;
  }
}

function Body({ panel, data, now }: { panel: Panel; data: PanelData; now: Date }) {
  switch (panel.type) {
    case 'tile':
      return data.tile ? <TilePanel tile={data.tile} display={panel.display} /> : null;
    case 'line':
      return data.series ? <LineChart title={panel.title} series={data.series} /> : null;
    case 'bar':
      return data.series ? <BarChart title={panel.title} series={data.series} /> : null;
    case 'table':
      return data.table ? <TablePanel table={data.table} /> : null;
    case 'list':
      return data.list ? <ListPanel list={data.list} /> : null;
    case 'calendar':
      return data.calendar ? <CalendarPanel calendar={data.calendar} now={now} /> : null;
    case 'status':
      return data.statusBoard ? <StatusBoardPanel board={data.statusBoard} /> : null;
    case 'text':
      return data.text !== undefined ? <TextPanel text={data.text} /> : null;
  }
}

/**
 * One panel: title, body, state note, source line with the age, Refresh (or "Job paused — Fix &
 * retry"; disabled, saying why, while the project or the job is paused) and a ⋯ menu with "Clear
 * history" (closed by Escape or a click outside it). A very good result plays fireworks once per run
 * result (or, under reduced motion, glows steadily); the verdict is always a word and an arrow.
 */
export function PanelFrame({
  panel,
  data,
  now,
  inert = false,
}: {
  panel: Panel;
  data: PanelData | undefined;
  now: Date;
  /** Shown but not usable (arrange mode): nothing inside takes focus, clicks or Tab. */
  inert?: boolean;
}) {
  const api = useApi();
  const reduced = useReducedMotion();
  const jobId = panel.source.kind === 'job' ? panel.source.jobId : undefined;
  const job = useAppStore((s) => (jobId ? s.world.jobs[jobId] : undefined));
  const verdict = shownVerdict(data);
  const good = verdict?.kind === 'very_good';

  // Fireworks: once per result id, remembered per browser (a remount stays quiet). The decision
  // is taken while rendering a new result id; remembering it is the effect.
  const resultId = good ? verdict.resultId : undefined;
  const [seenId, setSeenId] = useState<string>();
  const [burstFor, setBurstFor] = useState<string>();
  if (resultId !== seenId) {
    setSeenId(resultId);
    if (resultId !== undefined && !reduced && !celebrated(resultId)) setBurstFor(resultId);
  }
  useEffect(() => {
    if (burstFor !== undefined) markCelebrated(burstFor);
  }, [burstFor]);
  const burst = burstFor !== undefined && burstFor === resultId;
  const endBurst = useCallback(() => setBurstFor(undefined), []);

  const [mapOpen, setMapOpen] = useState(false);

  // A job map's panel chip asked for this panel: scroll to it and focus it, once.
  const articleRef = useRef<HTMLElement>(null);
  const wanted = useDockView((s) => s.focusPanelId === panel.id);
  const clearFocusPanel = useDockView((s) => s.clearFocusPanel);
  useEffect(() => {
    if (!wanted) return;
    articleRef.current?.scrollIntoView?.({ block: 'start' });
    articleRef.current?.focus();
    clearFocusPanel();
  }, [wanted, clearFocusPanel]);

  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLSpanElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menu) return;
    const outside = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [menu]);
  const escapeMenu = (e: KeyboardEvent) => {
    if (!menu || e.key !== 'Escape') return;
    e.stopPropagation();
    setMenu(false);
    menuButtonRef.current?.focus();
  };
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<'refresh' | 'clear'>();
  const [error, setError] = useState<string>();
  const run = async (kind: 'refresh' | 'clear', action: () => Promise<unknown>) => {
    setBusy(kind);
    setError(undefined);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const projectPaused = useAppStore((s) => s.world.projects[panel.projectId]?.state === 'paused');
  const paused = data?.status === 'job_paused' || job?.state === 'paused';
  const stopped = data?.status === 'job_stopped' || job?.state === 'stopped';
  /** Why Refresh cannot run now, if it cannot. */
  const noRefresh = projectPaused
    ? 'The project is paused'
    : paused
      ? 'The job is paused'
      : stopped
        ? 'The job is stopped'
        : undefined;
  const sourceText = data
    ? [data.sourceLine, ageText(data.lastGoodAt, now)].filter(Boolean).join(' · ')
    : '';
  const note = data ? stateNote(panel, data, now) : undefined;
  const classes = [
    'dash-panel',
    `type-${panel.type}`,
    verdict ? `is-${verdict.kind.replace('_', '-')}` : '',
    good && reduced ? 'is-glowing' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const fix = () => {
    if (job?.failureQuestionId) void revealQuestion(job.failureQuestionId);
    else revealInbox();
  };

  return (
    <article
      id={`dash-panel-${panel.id}`}
      ref={articleRef}
      tabIndex={-1}
      inert={inert}
      className={classes}
      aria-label={panel.title}
      style={{
        gridColumn: `span ${panel.layout.w}`,
        gridRow: `span ${panel.layout.h}`,
      }}
    >
      <header className="dash-head">
        <h3 className="dash-title">{panel.title}</h3>
        {verdict && (
          <span className={`dash-verdict is-${verdict.kind.replace('_', '-')}`}>
            {verdictWord(verdict.kind)}{' '}
            <span aria-hidden="true">{verdictArrow(verdict.arrow)}</span>
          </span>
        )}
        <span className="dash-menu" ref={menuRef} onKeyDown={escapeMenu}>
          <button
            ref={menuButtonRef}
            type="button"
            className="dash-icon"
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu((m) => !m)}
          >
            <span aria-hidden="true">⋯</span>
          </button>
          {menu && (
            <div role="menu" className="dash-menu-list">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  setConfirming(true);
                }}
              >
                Clear history
              </button>
            </div>
          )}
        </span>
      </header>
      {note && <p className={`dash-note${data?.status === 'empty' ? '' : ' is-state'}`}>{note}</p>}
      {data ? <Body panel={panel} data={data} now={now} /> : <p className="muted">Reading…</p>}
      {confirming && (
        <div className="dash-confirm" role="group" aria-label="Clear history">
          <p>{CLEAR_HISTORY_TEXT}</p>
          <div className="dash-confirm-actions">
            <button
              type="button"
              className="danger"
              disabled={busy === 'clear'}
              onClick={() =>
                void run('clear', async () => {
                  await api.clearPanelHistory(panel.id);
                  setConfirming(false);
                })
              }
            >
              Clear history
            </button>
            <button type="button" className="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <footer className="dash-foot">
        {jobId && sourceText ? (
          <button
            type="button"
            className="dash-source dash-link"
            aria-haspopup="dialog"
            onClick={() => setMapOpen(true)}
          >
            {sourceText}
          </button>
        ) : (
          <span className="dash-source">{sourceText}</span>
        )}
        {jobId && (
          <span className="dash-actions">
            {paused && (
              <button type="button" className="dash-link" onClick={fix}>
                Job paused — Fix &amp; retry
              </button>
            )}
            <button
              type="button"
              className="secondary dash-refresh"
              disabled={noRefresh !== undefined || busy === 'refresh'}
              title={noRefresh}
              onClick={() => void run('refresh', () => api.refreshJob(jobId))}
            >
              Refresh
            </button>
          </span>
        )}
      </footer>
      {mapOpen && jobId && <JobMap jobId={jobId} onClose={() => setMapOpen(false)} />}
      {burst && <Fireworks onDone={endBurst} />}
    </article>
  );
}
