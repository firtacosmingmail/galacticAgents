import { useEffect, useState } from 'react';
import {
  APPROVAL_LOG_ORDER,
  APPROVAL_MARK_DAYS,
  approvalLogCategory,
  isWaykeeperApproval,
  type ApprovalLogCategory,
  type EventEnvelope,
  type Project,
} from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import { agentLabel, ErrorLine, useAction, useApi } from '../../console/hierarchy/shared.js';

/**
 * "Approved by the Waykeeper" (design 2026-11-14 §4.4, layout A): the project's approvals from the
 * history, one collapsible row per category with its count, entries only on opening, newest
 * first. A young entry offers "Ask me next time", which makes an approval mark from it (§4.1).
 */

const CATEGORY_NAMES: Record<ApprovalLogCategory, string> = {
  push: 'Pushes you asked for',
  delete: 'Deletes',
  outside: 'Outside the project',
  network: 'Network',
  unreadable: 'Unreadable scripts',
  edit: 'Edits',
  run: 'Run commands',
  read: 'Reads',
};

const DAY_MS = 86_400_000;

function when(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? at : d.toLocaleString();
}

interface Approval {
  seq: number;
  at: string;
  agentId: string;
  category: ApprovalLogCategory;
  /** Younger than `APPROVAL_MARK_DAYS` when the log was read: can still become a mark. */
  young: boolean;
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
  const now = Date.now();
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
      if (!isWaykeeperApproval(event)) continue;
      out.push({
        seq,
        at,
        agentId: event.agentId,
        category: approvalLogCategory(event),
        young: now - new Date(at).getTime() <= APPROVAL_MARK_DAYS * DAY_MS,
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

function Entry({ projectId, row }: { projectId: string; row: Approval }) {
  const api = useApi();
  const world = useAppStore((s) => s.world);
  const { run, error, busy } = useAction();
  const [marked, setMarked] = useState(false);
  return (
    <li>
      <time dateTime={row.at}>{when(row.at)}</time>
      <span>{agentLabel(world.agents[row.agentId], world)}</span>
      <code>{row.request}</code>
      {row.reason && <span className="muted">{row.reason}</span>}
      {row.quote && <span className="muted">you asked: “{row.quote}”</span>}
      {row.young &&
        (marked ? (
          <span className="pill">Marked</span>
        ) : (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() =>
              void run(() => api.addApprovalMark(projectId, row.seq)).then(
                (ok) => ok && setMarked(true),
              )
            }
          >
            Ask me next time
          </button>
        ))}
      <ErrorLine error={error} />
    </li>
  );
}

function Group({
  projectId,
  category,
  rows,
}: {
  projectId: string;
  category: ApprovalLogCategory;
  rows: Approval[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="approvals-group">
      <button
        type="button"
        className="secondary"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {CATEGORY_NAMES[category]} · {rows.length}
      </button>
      {open && (
        <ul className="permission-rules" aria-label={CATEGORY_NAMES[category]}>
          {rows.map((r) => (
            <Entry key={r.seq} projectId={projectId} row={r} />
          ))}
        </ul>
      )}
    </div>
  );
}

export function ApprovalsLog({ project }: { project: Project }) {
  const api = useApi();
  const [rows, setRows] = useState<Approval[] | undefined>();
  const [error, setError] = useState<string | undefined>();
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
  const groups = APPROVAL_LOG_ORDER.map((category) => ({
    category,
    rows: rows.filter((r) => r.category === category),
  })).filter((g) => g.rows.length > 0);
  return (
    <div className="waykeeper-approved">
      <h4>Approved by the Waykeeper</h4>
      {groups.length === 0 && <p className="muted">Nothing yet.</p>}
      {groups.map((g) => (
        <Group key={g.category} projectId={project.id} category={g.category} rows={g.rows} />
      ))}
    </div>
  );
}
