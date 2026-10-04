import { useEffect, useState } from 'react';
import type { Id, StewardProcess } from '@galactic/protocol';
import { ErrorLine, useAction, useApi } from '../../console/hierarchy/shared.js';

/** How often the list is read again while the view is open. */
export const PROCESSES_REFRESH_MS = 15_000;

/**
 * A Steward's leftover processes in its view (P4-14; SPEC decision pending): "N processes still
 * running", the list on demand, and a Stop (with a confirmation) that stops them all through
 * `POST /api/agents/:id/processes/stop`. Read from `GET /api/agents/:id/processes` when the view
 * opens, when the Steward's state changes, and every `PROCESSES_REFRESH_MS`. Shows nothing while
 * there is nothing (or the server cannot tell).
 */
export function StewardProcesses({ agentId, state }: { agentId: Id; state: string | undefined }) {
  const api = useApi();
  const { run, error, busy } = useAction();
  const [processes, setProcesses] = useState<StewardProcess[]>([]);
  const [confirm, setConfirm] = useState(false);
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

  if (processes.length === 0 && !error) return null;
  const n = processes.length;
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
            </li>
          ))}
        </ul>
      </details>
      <div className="stw-controls" role="group" aria-label="process controls">
        {confirm ? (
          <>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => {
                setConfirm(false);
                void run(async () => {
                  await api.stopProcesses(agentId);
                  setReads((n) => n + 1);
                });
              }}
            >
              Confirm stop
            </button>
            <button type="button" className="secondary" onClick={() => setConfirm(false)}>
              Keep them running
            </button>
          </>
        ) : (
          <button
            type="button"
            className="danger"
            disabled={busy || n === 0}
            onClick={() => setConfirm(true)}
          >
            Stop {n === 1 ? 'it' : 'them'}
          </button>
        )}
      </div>
      <ErrorLine error={error} />
    </section>
  );
}
