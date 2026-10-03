import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { PROTOCOL_VERSION } from '@galactic/protocol';
import { useAppStore } from './state/store.js';
import {
  discoverToken,
  forgetToken,
  saveToken,
  startSession,
  TOKEN_KEY,
} from './client/session.js';
import { AgentsConsole } from './console/AgentsConsole.js';
import { HierarchyConsole } from './console/hierarchy/HierarchyConsole.js';
import { Panel } from './panel/Panel.js';
import { NavLink } from './panel/Navigation.js';
import { HARMONIZER } from './state/selection.js';
import { captureFpsFlag } from './scene/fps.js';
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
  const route = useAppStore((s) => s.route);
  useLocationSync();
  // How many refused tokens this page life may still recover from by re-discovering (P0-17).
  const rediscoveries = useRef(1);

  useEffect(() => {
    if (token !== undefined || !discovering) return;
    let cancelled = false;
    void discoverToken().then((found) => {
      if (cancelled) return;
      if (found) setToken(found);
      setDiscovering(false);
    });
    return () => {
      cancelled = true;
    };
  }, [token, discovering]);

  useEffect(() => {
    if (!token) return;
    return startSession(token);
  }, [token]);

  // A token the server refuses (config reset, another machine's token) is forgotten so the page
  // does not sit on "unauthorized": once per page life it re-discovers the current token from
  // `/health`; a second refusal falls through to the paste form.
  const status = useAppStore((s) => s.status);
  useEffect(() => {
    if (status !== 'unauthorized' || !token) return;
    forgetToken();
    useAppStore.getState().reset();
    setDiscovering(rediscoveries.current-- > 0);
    setToken(undefined);
  }, [status, token]);

  if (!token) {
    return (
      <main className="page">
        <Header debug={false} />
        {discovering ? (
          <p>Looking for a local Mission Control…</p>
        ) : (
          <TokenForm onSubmit={setToken} />
        )}
      </main>
    );
  }

  const forget = () => {
    forgetToken();
    useAppStore.getState().reset();
    setToken(undefined);
  };

  // The settings page (P25-08) and the history view (P25-10) live in the panel's frame.
  if (route === 'panel' || route === 'settings' || route === 'history')
    return <Panel token={token} onForget={forget} />;

  return (
    <main className="page">
      <Header debug />
      <StatusBar token={token} onForget={forget} />
      <Consoles token={token} />
    </main>
  );
}

/**
 * The route and the panel's selection follow the URL (P25-02): read on load (a deep link or a
 * reload restores them) and on back/forward; the store pushes history entries as the user
 * navigates. The scene's `?show_fps=` flag (P3-11) is taken from the loaded URL first, before any
 * navigation can drop the query; the canonical rewrite itself keeps it.
 */
function useLocationSync() {
  useLayoutEffect(() => {
    captureFpsFlag();
    const sync = () => useAppStore.getState().syncFromLocation();
    sync();
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);
}

type Tab = 'hierarchy' | 'agents';
const TABS: { id: Tab; label: string }[] = [
  { id: 'hierarchy', label: 'Hierarchy' },
  { id: 'agents', label: 'Agents (dev)' },
];

/**
 * The console's pages (P2-18): the hierarchy console drives the Phase 2 loop; the Phase 1 agents
 * console (free-form spawns, a development tool — decision 24) stays one click away; the raw
 * snapshot counts and the event log stay below both.
 */
function Consoles({ token }: { token: string }) {
  const [tab, setTab] = useState<Tab>('hierarchy');
  return (
    <>
      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? 'selected' : 'secondary'}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      {tab === 'hierarchy' && <HierarchyConsole token={token} />}
      {tab === 'agents' && <AgentsConsole token={token} />}
      <World />
      <EventLog />
    </>
  );
}

function Header({ debug }: { debug: boolean }) {
  return (
    <header>
      <h1>GalacticAgents</h1>
      <p className="muted">
        Mission Control · protocol v{PROTOCOL_VERSION}
        {debug && (
          <>
            {' '}
            · ops console ·{' '}
            <NavLink to={{ route: 'panel', selection: HARMONIZER }}>back to the panel</NavLink>
          </>
        )}
      </p>
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

  const setLastError = (e: string | undefined) => useAppStore.setState({ lastError: e });
  const devPost = async (path: string, body?: unknown) => {
    setBusy(true);
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (!res.ok) {
        const hint =
          res.status === 404
            ? ' (dev routes are off: start with `pnpm dev` or `galactic start --dev`)'
            : '';
        setLastError(`${path} failed: ${res.status}${hint}`);
      } else {
        setLastError(undefined);
      }
    } catch (e) {
      setLastError(`${path} failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const emitFake = () =>
    devPost('/dev/events', {
      type: 'agent.progress',
      agentId: 'a-demo',
      summary: `Fake progress from the browser at ${new Date().toLocaleTimeString()}`,
    });
  const seed = () => devPost('/dev/seed');

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
      <button
        onClick={seed}
        disabled={busy || status !== 'live'}
        title="Creates a demo planet + project"
      >
        Seed demo project
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
