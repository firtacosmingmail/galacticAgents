import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { PTY_TERMINAL_SIZE, type Id, type TranscriptChunk } from '@galactic/protocol';
import type { Terminal } from '@xterm/xterm';
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
 */
export function TerminalView({ chunks }: { chunks: TranscriptChunk[] }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | undefined>(undefined);
  /** The seqs drawn: the first (to notice a page landing before it) and the last. */
  const drawn = useRef<{ first: number | undefined; last: number }>({ first: undefined, last: 0 });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const terminal = useMemo(() => chunks.filter((c) => c.kind === 'terminal'), [chunks]);

  useEffect(() => {
    let disposed = false;
    let created: Terminal | undefined;
    import('@xterm/xterm')
      .then(({ Terminal: XTerm }) => {
        if (disposed || !host.current) return;
        created = new XTerm({
          cols: PTY_TERMINAL_SIZE.cols,
          rows: PTY_TERMINAL_SIZE.rows,
          disableStdin: true,
          cursorBlink: false,
          scrollback: 5_000,
          fontSize: 12,
          screenReaderMode: false,
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
  }, []);

  useEffect(() => {
    const t = term.current;
    if (!ready || !t || terminal.length === 0) return;
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
  }, [terminal, ready]);

  return (
    <section className="stw-terminal" aria-label="terminal">
      <h2 className="pnl-eyebrow">Terminal</h2>
      <div className="stw-terminal-scroll">
        <div
          ref={host}
          className="stw-terminal-screen"
          role="img"
          aria-label="the agent's terminal screen (its text is in the transcript below)"
        />
      </div>
      {terminal.length === 0 && !error && <p className="muted">Nothing on the screen yet.</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
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
        logged as your message. Its questions are better answered on their cards.
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
