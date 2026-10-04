import { useEffect } from 'react';
import { REPLAY_SPEEDS, useReplayStore, type ReplaySpeed } from './store.js';
import { tickOf } from './replay-model.js';
import './replay.css';

const TICK_NAMES = {
  assignment: 'placed on a body',
  move: 'moved',
  completion: 'completed',
  question: 'question asked',
} as const;

const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

/**
 * Open layers that close on Escape wherever the focus is (a document-level listener): the panel
 * menu, the controls' "More" menu and the notification settings mark themselves
 * `data-escape-layer`; a modal dialog too. While one is open, Escape is its, not the replay's.
 */
const PAGE_LAYERS = '[data-escape-layer]:not([hidden]), [aria-modal="true"], dialog[open]';
/** Layers that take Escape while the focus is inside them (a popover, a menu, a row's actions). */
const FOCUS_LAYERS =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], .pnl-row-actions';

/** A field Escape belongs to while typing (a select inside the bar is the bar's own). */
function isTypingIn(target: EventTarget | null, bar: Element | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false;
  const el = target as HTMLElement;
  if (el.isContentEditable) return true;
  if (el.closest('textarea, [contenteditable=""], [contenteditable="true"]')) return true;
  const input = el.closest('input');
  if (input) return !NON_TEXT_INPUTS.has(input.type);
  return el.closest('select') !== null && !(bar?.contains(el) ?? false);
}
const NON_TEXT_INPUTS = new Set(['range', 'button', 'submit', 'reset', 'checkbox', 'radio']);

/**
 * Whether a document-level Escape exits the replay (wave-4 review): not when something else
 * already took it (`defaultPrevented`, e.g. the scene's camera "back" or the picking popover's
 * close), with a modifier, while composing, while typing in a field, with the focus in a dialog /
 * menu / popover, or while a page-wide menu or popover is open (it closes first; the next Escape
 * exits the replay).
 */
export function escapeExitsReplay(
  event: Pick<
    globalThis.KeyboardEvent,
    'key' | 'defaultPrevented' | 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing' | 'target'
  >,
  doc: Document,
  bar: Element | null,
): boolean {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  if (isTypingIn(event.target, bar)) return false;
  const target = event.target as Element | null;
  if (typeof target?.closest === 'function' && target.closest(FOCUS_LAYERS)) return false;
  return doc.querySelector(PAGE_LAYERS) === null;
}

/**
 * The timeline scrubber's bar (P4-07), docked between the scene and the
 * conversation while a replay is open. It says that the scene shows the past and the panel stays
 * live; a slider over the project's lifetime with a tick per assignment, move, completion and
 * question; play / pause at 1×, 10× or 60×; previous / next marked event; the time shown; and
 * "Exit replay". Read-only: nothing here changes the server.
 */
export function ReplayBar({ sceneShown }: { sceneShown: boolean }) {
  const r = useReplayStore();
  // Playback stops when the bar goes (another page); the replay itself stays open until exited.
  useEffect(() => () => useReplayStore.getState().pause(), []);
  // While a replay is open, Escape anywhere on the page ends it — after any popover, dialog, menu
  // or field that wants it (bubbling: their own handlers run first).
  const open = r.phase !== 'closed';
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!escapeExitsReplay(e, document, document.querySelector('section.rpl'))) return;
      e.preventDefault();
      useReplayStore.getState().close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  if (r.phase === 'closed') return null;
  const title = r.name ? `Replay · ${r.name}` : 'Replay';
  const span = Math.max(1, r.end - r.start);
  const events = r.timeline?.events ?? [];
  const shown = r.timeline ? r.timeline.countAt(r.time) : 0;
  return (
    <section className="rpl" aria-label={title}>
      <div className="rpl-head">
        <strong className="rpl-title">{title}</strong>
        <span className="rpl-note">
          {sceneShown
            ? 'The scene shows the past; the panel stays live.'
            : 'Show the scene to watch the replay.'}
        </span>
        <button type="button" className="rpl-exit" onClick={r.close}>
          Exit replay
        </button>
      </div>
      {r.phase === 'loading' && (
        <p className="rpl-status" role="status">
          Reading the history…
          {r.progress ? ` ${r.progress.events} events so far (log #${r.progress.seq})` : ''}
        </p>
      )}
      {r.phase === 'error' && (
        <p className="rpl-status" role="alert">
          The history could not be read: {r.error}
        </p>
      )}
      {r.phase === 'ready' && events.length === 0 && (
        <p className="rpl-status">Nothing happened in this project yet.</p>
      )}
      {r.phase === 'ready' && events.length > 0 && (
        <div className="rpl-controls">
          <button
            type="button"
            className="rpl-button"
            aria-label="Previous event"
            title="Previous event"
            onClick={() => r.step(-1)}
          >
            ⏮
          </button>
          <button
            type="button"
            className="rpl-button rpl-play"
            aria-label={r.playing ? 'Pause' : 'Play'}
            onClick={r.playing ? r.pause : r.play}
          >
            {r.playing ? '⏸' : '▶'}
          </button>
          <button
            type="button"
            className="rpl-button"
            aria-label="Next event"
            title="Next event"
            onClick={() => r.step(1)}
          >
            ⏭
          </button>
          <select
            className="rpl-speed"
            aria-label="Speed"
            value={r.speed}
            onChange={(e) => r.setSpeed(Number(e.target.value) as ReplaySpeed)}
          >
            {REPLAY_SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
          <div className="rpl-track">
            <div className="rpl-ticks" aria-hidden="true">
              {r.ticks.map((i) => {
                const e = events[i]!;
                const kind = tickOf(e)!;
                const left = ((Date.parse(e.at) - r.start) / span) * 100;
                return (
                  <span
                    key={e.seq}
                    className={`rpl-tick rpl-tick-${kind}`}
                    style={{ left: `${left}%` }}
                    title={TICK_NAMES[kind]}
                  />
                );
              })}
            </div>
            <input
              type="range"
              className="rpl-slider"
              aria-label="Time"
              aria-valuetext={when(r.time)}
              min={r.start}
              max={r.end}
              step={1000}
              value={r.time}
              onChange={(e) => {
                r.pause();
                r.seek(Number(e.target.value));
              }}
            />
          </div>
          <time className="rpl-time" dateTime={new Date(r.time).toISOString()}>
            {when(r.time)}
          </time>
          <span className="rpl-count">
            {shown} / {events.length} events
          </span>
        </div>
      )}
    </section>
  );
}
