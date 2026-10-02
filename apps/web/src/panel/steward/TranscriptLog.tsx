import { useLayoutEffect, useRef } from 'react';
import type { TranscriptChunk } from '@galactic/protocol';
import type { TranscriptView } from '../../state/transcript-view.js';

/** Within this many pixels of an edge counts as "at" it. */
const EDGE_PX = 48;

/**
 * The Steward's transcript (P25-05): its text, its tool calls and its thought process. Thinking
 * is collapsed and dimmed (open it to read); tool calls are monospace. The list follows the live
 * stream while the reader is at the bottom; scrolling to the top reads the page before (and keeps
 * the reader's place when it lands).
 */
export function TranscriptLog({
  chunks,
  view,
  loadOlder,
}: {
  chunks: TranscriptChunk[];
  view: TranscriptView;
  loadOlder: () => Promise<void>;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  /** Set before an older page lands: the height and first seq to restore the reader's place. */
  const anchor = useRef<{ height: number; top: number; first: number } | undefined>(undefined);

  const first = chunks[0]?.seq;
  const last = chunks.at(-1)?.seq;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const a = anchor.current;
    if (a && first !== undefined && first < a.first) {
      el.scrollTop = a.top + (el.scrollHeight - a.height);
      anchor.current = undefined;
    } else if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [first, last]);

  const older = () => {
    const el = scroller.current;
    if (el && first !== undefined) {
      anchor.current = { height: el.scrollHeight, top: el.scrollTop, first };
    }
    void loadOlder();
  };
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < EDGE_PX;
    if (el.scrollTop < EDGE_PX && view.hasMore && !view.loadingOlder) older();
  };

  return (
    <section className="stw-transcript" aria-label="transcript">
      <h2 className="pnl-eyebrow">Transcript</h2>
      <div className="stw-log" ref={scroller} role="log" onScroll={onScroll}>
        {view.hasMore && (
          <button
            type="button"
            className="secondary stw-older"
            disabled={view.loadingOlder}
            onClick={older}
          >
            {view.loadingOlder ? 'Loading earlier…' : 'Load earlier'}
          </button>
        )}
        {view.status === 'loading' && chunks.length === 0 && <p className="muted">Loading…</p>}
        {view.status !== 'loading' && chunks.length === 0 && (
          <p className="muted">Nothing yet.</p>
        )}
        {chunks.map((c) => (
          <Chunk key={c.seq} chunk={c} />
        ))}
      </div>
      {view.error && (
        <p className="error" role="alert">
          Could not read the transcript: {view.error}
        </p>
      )}
    </section>
  );
}

function Chunk({ chunk: c }: { chunk: TranscriptChunk }) {
  switch (c.kind) {
    case 'thinking':
      return (
        <details className="stw-chunk stw-thinking" data-seq={c.seq}>
          <summary>thinking</summary>
          <p>{c.text}</p>
        </details>
      );
    case 'tool':
      return (
        <div className="stw-chunk stw-tool" data-seq={c.seq}>
          <span className="stw-chunk-kind">tool</span>
          <code>{c.text}</code>
        </div>
      );
    case 'text':
      return (
        <p className="stw-chunk stw-text" data-seq={c.seq}>
          {c.text}
        </p>
      );
  }
}
