import { useEffect, useState, type FormEvent } from 'react';
import { PROTOCOL_VERSION } from '@galactic/protocol';
import { useAppStore } from './state/store.js';
import {
  discoverToken,
  forgetToken,
  saveToken,
  startSession,
  TOKEN_KEY,
} from './client/session.js';
import './app.css';

export function App() {
  const [token, setToken] = useState<string | undefined>(() => {
    try {
      return localStorage.getItem(TOKEN_KEY) ?? undefined;
    } catch {
      return undefined;
    }
  });
  const [discovering, setDiscovering] = useState(token === undefined);

  useEffect(() => {
    if (token !== undefined) return;
    let cancelled = false;
    void discoverToken().then((found) => {
      if (cancelled) return;
      if (found) setToken(found);
      setDiscovering(false);
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!token) return;
    return startSession(token);
  }, [token]);

  if (!token) {
    return (
      <main className="page">
        <Header />
        {discovering ? (
          <p>Looking for a local Mission Control…</p>
        ) : (
          <TokenForm onSubmit={setToken} />
        )}
      </main>
    );
  }

  return (
    <main className="page">
      <Header />
      <StatusBar
        token={token}
        onForget={() => {
          forgetToken();
          useAppStore.getState().reset();
          setToken(undefined);
        }}
      />
      <World />
      <EventLog />
    </main>
  );
}

function Header() {
  return (
    <header>
      <h1>GalacticAgents</h1>
      <p className="muted">Mission Control · protocol v{PROTOCOL_VERSION} · Phase 0 event page</p>
    </header>
  );
}

function TokenForm({ onSubmit }: { onSubmit: (token: string) => void }) {
  const [value, setValue] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = value.trim();
    if (!t) return;
    saveToken(t);
    onSubmit(t);
  };
  return (
    <form onSubmit={submit} className="token-form">
      <label htmlFor="token">
        Paste the token printed by <code>galactic start</code>
      </label>
      <input id="token" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
      <button type="submit">Connect</button>
    </form>
  );
}

function StatusBar({ token, onForget }: { token: string; onForget: () => void }) {
  const status = useAppStore((s) => s.status);
  const detail = useAppStore((s) => s.statusDetail);
  const seq = useAppStore((s) => s.world.seq);
  const lastError = useAppStore((s) => s.lastError);
  const [busy, setBusy] = useState(false);

  const emitFake = async () => {
    setBusy(true);
    try {
      await fetch('/dev/events', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'agent.progress',
          agentId: 'a-demo',
          summary: `Fake progress from the browser at ${new Date().toLocaleTimeString()}`,
        }),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="status">
      <span className={`pill pill-${status}`}>{status}</span>
      <span>seq {seq}</span>
      {detail && <span className="muted">{detail}</span>}
      {lastError && <span className="error">{lastError}</span>}
      <span className="spacer" />
      <button onClick={emitFake} disabled={busy || status !== 'live'}>
        Emit fake event
      </button>
      <button onClick={onForget} className="secondary">
        Forget token
      </button>
    </section>
  );
}

function World() {
  const world = useAppStore((s) => s.world);
  const entries: [string, number][] = [
    ['bodies', Object.keys(world.bodies).length],
    ['projects', Object.keys(world.projects).length],
    ['tasks', Object.keys(world.tasks).length],
    ['agents', Object.keys(world.agents).length],
    ['questions', Object.keys(world.questions).length],
    ['proposals', Object.keys(world.proposals).length],
  ];
  return (
    <section className="world">
      <h2>Snapshot</h2>
      <dl className="counts">
        {entries.map(([name, n]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>{n}</dd>
          </div>
        ))}
      </dl>
      <ul className="items">
        {Object.values(world.projects).map((p) => (
          <li key={p.id}>
            <strong>project</strong> {p.name} <em>{p.state}</em>
          </li>
        ))}
        {Object.values(world.tasks).map((t) => (
          <li key={t.id}>
            <strong>task</strong> {t.description} <em>{t.state}</em>
          </li>
        ))}
        {Object.values(world.questions)
          .filter((q) => q.status === 'open')
          .map((q) => (
            <li key={q.id}>
              <strong>question</strong> {q.context.text} <em>{q.kind}</em>
            </li>
          ))}
      </ul>
    </section>
  );
}

function EventLog() {
  const log = useAppStore((s) => s.log);
  return (
    <section className="log">
      <h2>Events</h2>
      {log.length === 0 && <p className="muted">No events yet — press “Emit fake event”.</p>}
      <ol>
        {log.map((e) => (
          <li key={e.seq}>
            <code>#{e.seq}</code> <span className="muted">{e.at}</span>{' '}
            <strong>{e.event.type}</strong>{' '}
            <span className="payload">{JSON.stringify(omitType(e.event))}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function omitType(event: { type: string }): Record<string, unknown> {
  const { type: _type, ...rest } = event;
  return rest;
}
