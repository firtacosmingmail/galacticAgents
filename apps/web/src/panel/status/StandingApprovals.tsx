import { useEffect, useState } from 'react';
import type { EventEnvelope, Project, StandingApproval } from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import { agentLabel, ErrorLine, useAction, useApi } from '../../console/hierarchy/shared.js';

/**
 * A project's Waykeeper approvals (P13-06, design §5.6; SPEC decision 154), beside its "Allow
 * similar" rules: the switch "Waykeeper approves Stewards' requests" and the standing approvals,
 * each with what it covers, who made it and when, and a Remove button. Turning the switch on is
 * the Mac's alone: from a remote client the server answers 403 and its message shows here, next
 * to the switch. Turning it off and removing a standing approval work from anywhere.
 */

function when(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? at : d.toLocaleString();
}

interface Approval {
  seq: number;
  at: string;
  agentId: string;
  request: string;
  reason?: string;
  quote?: string;
}

/** A one-line reading of the approved tool call (text only; the log redacted it already). */
function requestLine(toolName: string, input: unknown): string {
  const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const text =
    typeof record['command'] === 'string'
      ? record['command']
      : typeof input === 'string'
        ? input
        : input === undefined
          ? ''
          : JSON.stringify(input);
  const line = `${toolName} ${text}`.replace(/\s+/g, ' ').trim();
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

/** The project's decisions a Waykeeper made, from the log (read on demand, newest first). */
async function readApprovals(
  api: ReturnType<typeof useApi>,
  projectId: string,
  live: () => boolean,
): Promise<Approval[]> {
  const out: Approval[] = [];
  let after: number | undefined;
  for (let page = 0; page < 50 && live(); page++) {
    const res = await api.historyEvents({
      projectId,
      type: 'permission.decided',
      limit: 2000,
      ...(after !== undefined ? { after } : {}),
    });
    for (const { seq, at, event } of res.events as EventEnvelope[]) {
      if (event.type !== 'permission.decided') continue;
      if (event.decision !== 'allow' || event.decidedBy.type !== 'agent') continue;
      out.push({
        seq,
        at,
        agentId: event.agentId,
        request: requestLine(event.toolCall.toolName, event.toolCall.input),
        ...(event.reason ? { reason: event.reason } : {}),
        ...(event.quote ? { quote: event.quote } : {}),
      });
    }
    after = res.seq;
    if (!res.hasMore) break;
  }
  return out.sort((a, b) => b.seq - a.seq);
}

/**
 * "The Waykeeper approved <n> requests" with a "Show them" toggle (P13-06, design §5.6): read
 * from the history when the section opens, newest first; not live (reopening refreshes it).
 */
export function WaykeeperApprovalsList({ project }: { project: Project }) {
  const api = useApi();
  const world = useAppStore((s) => s.world);
  const [rows, setRows] = useState<Approval[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [open, setOpen] = useState(false);
  const available = typeof api.historyEvents === 'function';
  useEffect(() => {
    if (!available) return;
    let alive = true;
    readApprovals(api, project.id, () => alive).then(
      (r) => alive && setRows(r),
      (e: unknown) => alive && setError((e as Error).message),
    );
    return () => {
      alive = false;
    };
  }, [api, available, project.id]);
  if (!available) return null;
  if (error) return <ErrorLine error={error} />;
  if (!rows) return null;
  return (
    <div className="waykeeper-approved">
      <p>
        The Waykeeper approved {rows.length} {rows.length === 1 ? 'request' : 'requests'}
        {rows.length > 0 && (
          <>
            {' '}
            <button
              type="button"
              className="secondary"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              {open ? 'Hide them' : 'Show them'}
            </button>
          </>
        )}
      </p>
      {open && (
        <ul className="permission-rules" aria-label="requests the Waykeeper approved">
          {rows.map((r) => (
            <li key={r.seq}>
              <time dateTime={r.at}>{when(r.at)}</time>
              <span>{agentLabel(world.agents[r.agentId], world)}</span>
              <code>{r.request}</code>
              {r.reason && <span className="muted">{r.reason}</span>}
              {r.quote && <span className="muted">you asked: “{r.quote}”</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function StandingApprovals({ project }: { project: Project }) {
  const api = useApi();
  const { run, error, busy } = useAction();
  const approvals: StandingApproval[] = project.standingApprovals ?? [];
  const on = project.waykeeperApprovals === true;
  const canSwitch = typeof api.setWaykeeperApprovals === 'function';
  return (
    <div className="standing-approvals">
      {canSwitch && (
        <label className="waykeeper-switch">
          <input
            type="checkbox"
            checked={on}
            disabled={busy}
            onChange={() => void run(() => api.setWaykeeperApprovals(project.id, !on))}
          />{' '}
          Waykeeper approves Stewards&apos; requests
        </label>
      )}
      <ErrorLine error={error} />
      <WaykeeperApprovalsList project={project} />
      {approvals.length === 0 ? (
        <p className="muted sts-empty">
          No standing approvals yet. A forwarded card offers one after three similar approvals; it
          lasts until the project closes.
        </p>
      ) : (
        <ul className="permission-rules" aria-label="standing approvals">
          {approvals.map((a) => (
            <li key={a.id}>
              <span className="pill">standing</span>
              <strong>{a.kind}</strong>
              <code>{a.examples.join(' · ')}</code>
              <span className="muted">
                added {when(a.createdAt)}
                {a.createdBy.type === 'user' ? '' : ' by the Waykeeper'}
                {a.origin === 'remote' ? ' from a remote client' : ''}
              </span>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                aria-label={`Remove the standing approval ${a.kind}`}
                onClick={() => void run(() => api.removeStandingApproval(project.id, a.id))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
