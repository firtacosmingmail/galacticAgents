import { useEffect, useState } from 'react';
import type { Id, StewardProcess } from '@galactic/protocol';
import { ErrorLine, useAction, useApi } from '../../console/hierarchy/shared.js';

/** How often the list is read again while the view is open. */
export const PROCESSES_REFRESH_MS = 15_000;

/**
 * A Steward's leftover processes in its view (P4-14; SPEC decision 76): "N processes still
 * running", the list on demand, and a confirmed Stop through `POST /api/agents/:id/processes/stop`.
 * Read from `GET /api/agents/:id/processes` when the view opens, when the Steward's state changes,
 * every `PROCESSES_REFRESH_MS` and after a stop. Shows nothing while there is nothing (or the
 * server cannot tell).
 *
 * The stop names exactly the pids it showed: "Stop" reads the list again, shows what will be
 * stopped, and "Confirm stop" sends those pids — never "whatever is attributable by then". While
 * the Steward runs, what its session uses (`held`: its MCP servers, the shell of a tool command)
 * is marked and left out of the bulk stop; each such row has its own Stop, for a deliberate choice.
 */
export function StewardProcesses({ agentId, state }: { agentId: Id; state: string | undefined }) {
  const api = useApi();
  const { run, error, busy } = useAction();
  const [processes, setProcesses] = useState<StewardProcess[]>([]);
  /** What "Confirm stop" will stop, as read just before; `undefined` when not confirming. */
  const [confirm, setConfirm] = useState<StewardProcess[] | undefined>(undefined);
  /** Bumped after a stop: the list is read again. */
  const [reads, setReads] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const reply = await api.processes(agentId);
        if (!cancelled) setProcesses(Array.isArray(reply.processes) ? reply.processes : []);
      } catch {
        if (!cancelled) setProcesses([]); // an older server, or not a Steward: nothing to show
      }
    };
    void load();
    const timer = setInterval(() => void load(), PROCESSES_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [api, agentId, state, reads]);

  /** Reads the list again and asks to confirm `pick` of it. */
  const prepare = (pick: (fresh: StewardProcess[]) => StewardProcess[]) =>
    void run(async () => {
      const reply = await api.processes(agentId);
      const fresh = Array.isArray(reply.processes) ? reply.processes : [];
      setProcesses(fresh);
      const chosen = pick(fresh);
      setConfirm(chosen.length > 0 ? chosen : undefined);
    });

  if (processes.length === 0 && !error) return null;
  const n = processes.length;
  const free = processes.filter((p) => !p.held);
  const bulkLabel =
    free.length === n ? `Stop ${n === 1 ? 'it' : 'them'}` : `Stop the ${free.length} not in use`;
  return (
    <section className="stw-procs" aria-label="processes still running">
      <details>
        <summary>
          {n} process{n === 1 ? '' : 'es'} still running
        </summary>
        <ul className="stw-procs-list">
          {processes.map((p) => (
            <li key={p.pid}>
              <code>{p.pid}</code> <code className="stw-procs-cmd">{p.command}</code>
              {p.ports.length > 0 && (
                <span className="muted">
                  {' '}
                  · port{p.ports.length === 1 ? '' : 's'} {p.ports.join(', ')}
                </span>
              )}
              {p.held && (
                <>
                  <span className="muted"> · in use by the Steward</span>{' '}
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || confirm !== undefined}
                    aria-label={`Stop ${p.pid}`}
                    onClick={() => prepare((fresh) => fresh.filter((q) => q.pid === p.pid))}
                  >
                    Stop
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      </details>
      <div className="stw-controls" role="group" aria-label="process controls">
        {confirm ? (
          <>
            <p className="stw-procs-confirm">
              Stop {confirm.length === 1 ? 'this process' : `these ${confirm.length} processes`}
              {confirm.some((p) => p.held) ? ' (the Steward is using it)' : ''}:{' '}
              {confirm.map((p) => `${p.pid} ${p.command}`).join('; ')}
            </p>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => {
                const pids = confirm.map((p) => p.pid);
                setConfirm(undefined);
                void run(async () => {
                  await api.stopProcesses(agentId, pids);
                  setReads((k) => k + 1);
                });
              }}
            >
              Confirm stop
            </button>
            <button type="button" className="secondary" onClick={() => setConfirm(undefined)}>
              Keep them running
            </button>
          </>
        ) : (
          free.length > 0 && (
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => prepare((fresh) => fresh.filter((p) => !p.held))}
            >
              {bulkLabel}
            </button>
          )
        )}
      </div>
      <ErrorLine error={error} />
    </section>
  );
}
