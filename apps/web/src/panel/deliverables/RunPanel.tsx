import { useEffect, useMemo, useRef, useState } from 'react';
import type { Deliverable, DeliverableRun, Id, RunSummary } from '@galactic/protocol';
import { useApi } from '../../console/hierarchy/shared.js';
import { useAppStore } from '../../state/store.js';
import { desktopShell } from '../../desktop-shell.js';
import { ConfirmBox } from '../controls.js';
import { linkHandlerFor, XtermScreen } from '../steward/TerminalView.js';
import { runStateText, type ClientRules } from './deliverables-model.js';
import { RunDialog } from './RunDialog.js';
import {
  historyText,
  portUrl,
  refusalText,
  runActions,
  stripAnsi,
  wasEdited,
  type RunAction,
} from './runs-model.js';
import { useRunOutput } from './use-run-output.js';
import './runs.css';

/** The run view's terminal size: output through a pipe, wrapped at this width. */
export const RUN_VIEW_SIZE = { cols: 100, rows: 16 } as const;
/** The runs the history lists (the server keeps the output of the last five, decision 130). */
export const HISTORY_SHOWN = 10;

const RUN_LINKS = linkHandlerFor("this run's output");

/**
 * A command row's runs (P9-10; SPEC decisions 129–131, 134): its state ("running · :5173",
 * "exited 1", "stopped — Mission Control restarted"), announced when it changes; the ports it
 * listens on — links on the Mac (in the desktop app they open in the default browser), text on
 * the phone; Run (the confirmation dialog), Stop (confirmed first) and Restart (confirmed again);
 * the live output (the read-only terminal view over the run stream, or as plain text); and the
 * command's run history. The phone follows the state and the output and may Stop; Run and
 * Restart say "on the Mac" (decision 131).
 */
export function RunPanel({ row, rules }: { row: Deliverable; rules: ClientRules }) {
  const api = useApi();
  // The world's run is live (the stream); the REST row may be a moment behind it.
  const worldRun = useAppStore((s) => s.world.deliverables?.[row.id]?.lastRun);
  const [started, setStarted] = useState<RunSummary>();
  const lastRun = newest(worldRun ?? row.lastRun, started);
  const { actions, macOnly } = runActions(row, lastRun, rules);
  const has = (a: RunAction) => actions.includes(a);
  const [dialog, setDialog] = useState<'run' | 'restart'>();
  const [stopping, setStopping] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [error, setError] = useState<string>();
  const [showOutput, setShowOutput] = useState(false);
  const [outputRun, setOutputRun] = useState<Id>();
  const [showHistory, setShowHistory] = useState(false);
  const runButton = useRef<HTMLButtonElement>(null);
  const restartButton = useRef<HTMLButtonElement>(null);
  const stopButton = useRef<HTMLButtonElement>(null);

  const live = lastRun !== undefined && lastRun.state !== 'ended';
  const state = stopping && live ? 'stopping' : runStateText(lastRun);
  const announce = useAnnouncement(lastRun ? `${row.title}: ${state}` : '');
  const shownRun = outputRun ?? lastRun?.runId;

  const onStarted = (run: DeliverableRun) => {
    setDialog(undefined);
    setError(undefined);
    setStarted({ runId: run.id, state: run.state, startedAt: run.startedAt, ports: run.ports });
    setOutputRun(undefined);
    setShowOutput(true);
  };

  const stop = async () => {
    if (!lastRun) return;
    setConfirmStop(false);
    setStopping(true);
    setError(undefined);
    try {
      await api.stopRun(lastRun.runId);
    } catch (e) {
      setError(refusalText(e));
    } finally {
      setStopping(false);
    }
  };

  const desktop = desktopShell() !== undefined;
  return (
    <div className="run-panel">
      <p className="dlv-run-state">
        <span
          className={`run-dot is-${live ? 'live' : (lastRun?.outcome ?? 'none')}`}
          aria-hidden
        />
        <span className="dlv-run">{state}</span>
        <span className="pnl-visually-hidden" role="status" aria-live="polite">
          {announce}
        </span>
      </p>
      {live && lastRun.ports.length > 0 && (
        <p className="run-ports">
          {rules.local ? (
            lastRun.ports.map((p) => (
              <a
                key={p}
                className="run-port"
                href={portUrl(p)}
                // In the desktop app the shell's navigation guard hands an outside address to the
                // default browser (decision 134); a browser opens a new tab without an opener.
                {...(desktop ? {} : { target: '_blank', rel: 'noopener noreferrer' })}
              >
                {portUrl(p)}
              </a>
            ))
          ) : (
            <>
              {lastRun.ports.map((p) => (
                <code key={p} className="run-port">
                  {portUrl(p)}
                </code>
              ))}
              <span className="muted"> — on the Mac: open it in the Mac’s browser</span>
            </>
          )}
        </p>
      )}
      <div className="dlv-actions run-actions" role="group" aria-label={`run ${row.title}`}>
        {has('run') && (
          <button type="button" ref={runButton} onClick={() => setDialog('run')}>
            Run…
          </button>
        )}
        {has('stop') && (
          <button
            type="button"
            ref={stopButton}
            className="danger"
            disabled={stopping}
            onClick={() => setConfirmStop(true)}
          >
            {stopping ? 'Stopping…' : 'Stop'}
          </button>
        )}
        {has('restart') && (
          <button
            type="button"
            ref={restartButton}
            className="secondary"
            disabled={stopping}
            onClick={() => setDialog('restart')}
          >
            Restart…
          </button>
        )}
        {lastRun && (
          <button
            type="button"
            className="secondary"
            aria-expanded={showOutput}
            onClick={() => setShowOutput((v) => !v)}
          >
            {showOutput ? 'Hide output' : 'Output'}
          </button>
        )}
        {lastRun && (
          <button
            type="button"
            className="secondary"
            aria-expanded={showHistory}
            onClick={() => setShowHistory((v) => !v)}
          >
            Runs
          </button>
        )}
        {macOnly.length > 0 && (
          <span className="dlv-mac-only muted">
            {macOnly.map((a) => (a === 'run' ? 'Run' : 'Restart')).join(', ')}: on the Mac
          </span>
        )}
      </div>
      {confirmStop && lastRun && (
        <ConfirmBox
          question={`Stop ${row.title}? It ends the command and everything it started.`}
          yes="Stop"
          busy={stopping}
          opener={stopButton}
          onConfirm={() => void stop()}
          onKeep={() => setConfirmStop(false)}
        />
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {dialog && (
        <RunDialog
          row={row}
          mode={dialog}
          runId={dialog === 'restart' ? lastRun?.runId : undefined}
          opener={dialog === 'restart' ? restartButton : runButton}
          onClose={() => setDialog(undefined)}
          onStarted={onStarted}
        />
      )}
      {showOutput && shownRun && (
        <RunOutputView
          key={shownRun}
          runId={shownRun}
          current={shownRun === lastRun?.runId}
          onBackToCurrent={() => setOutputRun(undefined)}
        />
      )}
      {showHistory && lastRun && (
        <RunHistory
          deliverableId={row.id}
          stamp={`${lastRun.runId}/${lastRun.state}/${lastRun.ports.join(',')}`}
          shown={showOutput ? shownRun : undefined}
          onShow={(id) => {
            setOutputRun(id === lastRun.runId ? undefined : id);
            setShowOutput(true);
          }}
        />
      )}
    </div>
  );
}

/** The run this page started wins over an older one the stream has not replaced yet. */
function newest(a: RunSummary | undefined, b: RunSummary | undefined): RunSummary | undefined {
  if (!a) return b;
  if (!b || a.runId === b.runId) return a;
  return b.startedAt > a.startedAt ? b : a;
}

/** The text a live region says: the state once it changes after the row appeared, not before. */
function useAnnouncement(text: string): string {
  const [first] = useState(text);
  const [changed, setChanged] = useState(false);
  if (!changed && text !== first) setChanged(true);
  return changed || text !== first ? text : '';
}

/**
 * A run's output (TECHNOLOGY §9.8): the read-only terminal view (xterm.js, ANSI colours kept) over
 * the stored output and the live stream, or the same as plain text (for reading, copying and
 * screen readers). Not a live region: the output is never announced.
 */
function RunOutputView({
  runId,
  current,
  onBackToCurrent,
}: {
  runId: Id;
  current: boolean;
  onBackToCurrent: () => void;
}) {
  const out = useRunOutput(runId);
  const [plain, setPlain] = useState(false);
  const screen = useMemo(
    () => out.chunks.map((c) => ({ seq: c.seq, text: c.chunk })),
    [out.chunks],
  );
  const text = useMemo(
    () => (plain ? stripAnsi(screen.map((c) => c.text).join('')) : ''),
    [plain, screen],
  );
  return (
    <section className="run-output" aria-label="output">
      <div className="run-output-bar">
        <h3 className="pnl-eyebrow">{current ? 'Output' : 'Output of an earlier run'}</h3>
        <span className="pnl-spacer" />
        {!current && (
          <button type="button" className="secondary" onClick={onBackToCurrent}>
            Latest run
          </button>
        )}
        <button
          type="button"
          className="secondary"
          aria-pressed={plain}
          onClick={() => setPlain((p) => !p)}
        >
          Plain text
        </button>
      </div>
      {out.truncatedBefore !== undefined && (
        <p className="muted run-truncated">
          Earlier output dropped: Mission Control keeps the newest part of each run.
        </p>
      )}
      {out.status === 'loading' && out.chunks.length === 0 && (
        <p className="muted">Reading the output…</p>
      )}
      {out.error && (
        <p className="error" role="alert">
          Could not read all of the output: {out.error}
        </p>
      )}
      {plain ? (
        <pre className="run-output-text" tabIndex={0} role="region" aria-label="the output as text">
          {text || 'No output yet.'}
        </pre>
      ) : (
        <XtermScreen
          chunks={screen}
          cols={RUN_VIEW_SIZE.cols}
          rows={RUN_VIEW_SIZE.rows}
          convertEol
          linkHandler={RUN_LINKS}
          label="the run's output (Plain text shows it as text)"
          trimmedNote="Earlier output trimmed from the view: Plain text shows all that was read."
          emptyNote={out.status === 'loading' ? '' : 'No output yet.'}
        />
      )}
    </section>
  );
}

/**
 * A command's runs, newest first (`GET /api/deliverables/:id/runs`): when each started, how it
 * ended, how long it ran, its ports and whether its line was edited for it; "Output" shows that
 * run's output (kept for the last five runs, decision 130). Read again when the newest changes.
 */
function RunHistory({
  deliverableId,
  stamp,
  shown,
  onShow,
}: {
  deliverableId: Id;
  stamp: string;
  shown: Id | undefined;
  onShow: (runId: Id) => void;
}) {
  const api = useApi();
  const [read, setRead] = useState<{ runs: DeliverableRun[]; at: number }>();
  const runs = read?.runs;
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    api.runs(deliverableId).then(
      (r) => {
        if (live) {
          setRead({ runs: r.runs, at: Date.now() });
          setError(undefined);
        }
      },
      (e: unknown) => live && setError((e as Error).message),
    );
    return () => {
      live = false;
    };
  }, [api, deliverableId, stamp]);
  const now = read?.at ?? 0;
  return (
    <section className="run-history" aria-label="runs">
      <h3 className="pnl-eyebrow">Runs</h3>
      {error && (
        <p className="error" role="alert">
          Could not read the runs: {error}
        </p>
      )}
      {!runs && !error && <p className="muted">Reading the runs…</p>}
      {runs && runs.length === 0 && <p className="muted">No runs yet.</p>}
      {runs && runs.length > 0 && (
        <ol className="run-history-list">
          {runs.slice(0, HISTORY_SHOWN).map((r) => (
            <li key={r.id} className={shown === r.id ? 'is-shown' : undefined}>
              <time dateTime={r.startedAt}>{new Date(r.startedAt).toLocaleString()}</time>
              <span>{historyText(r, now)}</span>
              {wasEdited(r) && (
                <span className="muted" title={r.line}>
                  · edited: <code>{r.line}</code>
                </span>
              )}
              <button
                type="button"
                className="secondary"
                aria-pressed={shown === r.id}
                onClick={() => onShow(r.id)}
              >
                Output
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
