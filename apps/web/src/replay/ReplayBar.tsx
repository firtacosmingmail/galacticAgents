import { useEffect, type KeyboardEvent } from 'react';
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
 * The timeline scrubber's bar (P4-07; SPEC decision 78), docked between the scene and the
 * conversation while a replay is open. It says that the scene shows the past and the panel stays
 * live; a slider over the project's lifetime with a tick per assignment, move, completion and
 * question; play / pause at 1×, 10× or 60×; previous / next marked event; the time shown; and
 * "Exit replay". Read-only: nothing here changes the server.
 */
export function ReplayBar({ sceneShown }: { sceneShown: boolean }) {
  const r = useReplayStore();
  // Playback stops when the bar goes (another page); the replay itself stays open until exited.
  useEffect(() => () => useReplayStore.getState().pause(), []);
  if (r.phase === 'closed') return null;
  const title = r.name ? `Replay · ${r.name}` : 'Replay';
  // Escape anywhere in the bar ends the replay.
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      r.close();
    }
  };
  const span = Math.max(1, r.end - r.start);
  const events = r.timeline?.events ?? [];
  const shown = r.timeline ? r.timeline.countAt(r.time) : 0;
  return (
    <section className="rpl" aria-label={title} onKeyDown={onKeyDown}>
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
      {r.phase === 'loading' && <p className="rpl-status">Reading the history…</p>}
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
