import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { PTY_TERMINAL_SIZE, type Id, type TranscriptChunk } from '@galactic/protocol';
import type { ILinkHandler, Terminal } from '@xterm/xterm';
import { isLoopbackHostname } from '../../scene/device.js';
import { ErrorLine, useAction, useApi } from '../../console/hierarchy/shared.js';
import '@xterm/xterm/css/xterm.css';

/**
 * A terminal agent's screen (P8-08; TECHNOLOGY §3.3): its raw `terminal` transcript chunks drawn
 * by xterm.js at the agent's own terminal size (`PTY_TERMINAL_SIZE`), so cursor movement and
 * colours land where the CLI meant them. Read-only: the view takes no keystrokes (xterm's stdin
 * is off). xterm.js loads with the first terminal agent viewed, not with the page.
 *
 * Chunks are written as they arrive, in `seq` order. When an older page lands before the ones
 * already drawn (or retention removed some), the screen is cleared and redrawn from the oldest
 * chunk held: a terminal can only be replayed forwards.
 *
 * The view draws at most the last `TERMINAL_VIEW_BYTES` of output (P8-08 review): past that it
 * drops the oldest chunks down to half of it — rarely, so the redraw it costs is rare — and says
 * "earlier output trimmed" (the text transcript below keeps it).
 *
 * Links (OSC 8 hyperlinks a CLI prints) go through `TERMINAL_LINKS`: http(s) only, after a
 * confirmation, in a new window with no opener — the same in a browser and in the desktop app.
 */
export function TerminalView({ chunks }: { chunks: TranscriptChunk[] }) {
  const all = useMemo(() => chunks.filter((c) => c.kind === 'terminal'), [chunks]);
  return (
    <section className="stw-terminal" aria-label="terminal">
      <h2 className="pnl-eyebrow">Terminal</h2>
      <XtermScreen
        chunks={all}
        cols={PTY_TERMINAL_SIZE.cols}
        rows={PTY_TERMINAL_SIZE.rows}
        label="the agent's terminal screen (its text is in the transcript below)"
        trimmedNote="Earlier output trimmed: the transcript below keeps all of it."
        emptyNote="Nothing on the screen yet."
      />
    </section>
  );
}

/** What `XtermScreen` draws: a chunk of terminal output and its `seq`. */
export interface ScreenChunk {
  seq: number;
  text: string;
}

/**
 * xterm.js, read-only, over chunks of terminal output in `seq` order (P8-08; reused by the run
 * view, P9-10). Loaded with the first screen shown, not with the page. Chunks are written as they
 * arrive; when an older chunk lands before the ones drawn the screen is replayed from the oldest
 * held. At most `TERMINAL_VIEW_BYTES` are drawn ("earlier output trimmed" past it). `convertEol`
 * draws a bare newline as a new line (a program's output through a pipe, not a terminal).
 */
export function XtermScreen({
  chunks: all,
  cols,
  rows,
  label,
  trimmedNote,
  emptyNote,
  convertEol = false,
  linkHandler = TERMINAL_LINKS,
}: {
  chunks: readonly ScreenChunk[];
  cols: number;
  rows: number;
  label: string;
  trimmedNote: string;
  emptyNote: string;
  convertEol?: boolean;
  linkHandler?: ILinkHandler;
}) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | undefined>(undefined);
  /** The seqs drawn: the first (to notice a page landing before it) and the last. */
  const drawn = useRef<{ first: number | undefined; last: number }>({ first: undefined, last: 0 });
  /** The first seq the view keeps (0: everything held). */
  const keepFrom = useRef(0);
  /** "Earlier output trimmed", shown by the drawing effect. */
  const notice = useRef<HTMLParagraphElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let disposed = false;
    let created: Terminal | undefined;
    import('@xterm/xterm')
      .then(({ Terminal: XTerm }) => {
        if (disposed || !host.current) return;
        created = new XTerm({
          cols,
          rows,
          disableStdin: true,
          cursorBlink: false,
          scrollback: 5_000,
          fontSize: 12,
          screenReaderMode: false,
          convertEol,
          linkHandler,
        });
        created.open(host.current);
        term.current = created;
        drawn.current = { first: undefined, last: 0 };
        setReady(true);
      })
      .catch((e: unknown) => {
        if (!disposed) setError(`The terminal view could not start: ${(e as Error).message}`);
      });
    return () => {
      disposed = true;
      created?.dispose();
      term.current = undefined;
    };
  }, [cols, rows, convertEol, linkHandler]);

  useEffect(() => {
    const t = term.current;
    if (!ready || !t || all.length === 0) return;
    const kept = trimTerminal(all, keepFrom.current);
    keepFrom.current = kept.from;
    if (notice.current) notice.current.hidden = !kept.trimmed;
    const terminal = kept.chunks;
    const first = terminal[0]!.seq;
    const d = drawn.current;
    if (d.first !== undefined && first !== d.first) {
      t.reset();
      d.last = 0;
    }
    d.first = first;
    for (const c of terminal) {
      if (c.seq <= d.last) continue;
      t.write(c.text);
      d.last = c.seq;
    }
  }, [all, ready]);

  return (
    <>
      <div className="stw-terminal-scroll">
        <div ref={host} className="stw-terminal-screen" role="img" aria-label={label} />
      </div>
      <p ref={notice} className="muted" hidden>
        {trimmedNote}
      </p>
      {all.length === 0 && !error && <p className="muted">{emptyNote}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

/** How much terminal output the view keeps (UTF-16 code units, about bytes). */
export const TERMINAL_VIEW_BYTES = 512 * 1024;

/**
 * The terminal chunks the view draws: those from `from` on (0: all held, older pages included);
 * when they exceed `TERMINAL_VIEW_BYTES`, the newest that fit in half of it (the new `from`).
 */
export function trimTerminal<T extends ScreenChunk>(
  all: readonly T[],
  from: number,
  cap = TERMINAL_VIEW_BYTES,
): { chunks: T[]; from: number; trimmed: boolean } {
  let kept = from > 0 ? all.filter((c) => c.seq >= from) : [...all];
  let start = from;
  let size = kept.reduce((n, c) => n + c.text.length, 0);
  if (size > cap) {
    let i = kept.length;
    size = 0;
    while (i > 0 && size + kept[i - 1]!.text.length <= cap / 2) {
      i -= 1;
      size += kept[i]!.text.length;
    }
    if (i === kept.length) i = kept.length - 1; // one chunk alone above half the cap
    kept = kept.slice(i);
    start = kept[0]!.seq;
  }
  return { chunks: kept, from: start, trimmed: start > 0 && all.length > 0 && all[0]!.seq < start };
}

/**
 * What a click on a link in the terminal does: an http(s) link opens after the user confirms,
 * in a new window without an opener; anything else (file:, javascript:, a custom scheme) does
 * nothing. A link printed by an agent no table can judge is untrusted.
 */
export const TERMINAL_LINKS: ILinkHandler = linkHandlerFor("the agent's terminal");

/** A link handler as `TERMINAL_LINKS`, asking about a link "from <where>" (P9-10: a run's output). */
export function linkHandlerFor(where: string): ILinkHandler {
  return {
    allowNonHttpProtocols: false,
    activate: (_event, text) => {
      let url: URL;
      try {
        url = new URL(text);
      } catch {
        return;
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
      if (!globalThis.confirm?.(`Open this link from ${where}?\n\n${url.href}`)) return;
      globalThis.open?.(url.href, '_blank', 'noopener,noreferrer');
    },
  };
}

/**
 * The user's keyboard on a terminal agent (P8-08; decision 113): one line typed into its
 * terminal now (the text, then Enter) — for a prompt the server did not recognise as a question.
 * Offered on the Mac's own browser only: the server refuses a remote client whatever its
 * settings. Logged as the user's message.
 */
export function TerminalInput({ agentId }: { agentId: Id }) {
  const api = useApi();
  const { run, error, busy } = useAction();
  const [text, setText] = useState('');
  if (!isLoopbackHostname(globalThis.location?.hostname)) {
    return (
      <p className="muted stw-readonly">
        Typing into this agent&rsquo;s terminal works only from the Mac&rsquo;s own browser.
      </p>
    );
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api.terminal(agentId, text))) setText('');
  };
  return (
    <form className="stw-composer stw-terminal-input" onSubmit={(e) => void submit(e)}>
      <label className="stw-composer-label" htmlFor={`terminal-${agentId}`}>
        Type into its terminal
      </label>
      <p className="muted">
        Goes straight to the agent&rsquo;s terminal followed by Enter, whatever it is doing, and is
        logged as your message (and shown on its screen): do not type passwords or secrets here. Its
        questions are better answered on their cards.
      </p>
      <div className="stw-terminal-row">
        <input
          id={`terminal-${agentId}`}
          className="stw-terminal-field"
          value={text}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" disabled={busy}>
          Type it
        </button>
      </div>
      <ErrorLine error={error} />
    </form>
  );
}
