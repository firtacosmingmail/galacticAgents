import { useEffect, useState } from 'react';
import {
  APPROVAL_LOG_ORDER,
  APPROVAL_MARK_DAYS,
  approvalLogCategory,
  isWaykeeperApproval,
  type AllowedBy,
  type ApprovalLogCategory,
  type EventEnvelope,
  type Project,
  type RecordedApproval,
  type SendGrant,
} from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import { agentLabel, ErrorLine, useAction, useApi } from '../../console/hierarchy/shared.js';

/**
 * "Approved by the Waykeeper" (design 2026-11-14 §4.4, layout A): the project's approvals from the
 * history, one collapsible row per category with its count, entries only on opening, newest
 * first. A young entry offers "Ask me next time", which makes an approval mark from it (§4.1).
 * A send says what allowed it (design 2026-11-18 §4.7): the grant it used, the task's words, or
 * the user's own Allow once, which is listed too. Standalone work (no project) has the same log,
 * of its agents' decisions, in the settings (§4.5).
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

/** A timestamp in the viewer's locale; the raw text when it cannot be read. */
export function when(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? at : d.toLocaleString();
}

export interface Approval {
  seq: number;
  at: string;
  agentId: string;
  category: ApprovalLogCategory;
  /** A Waykeeper's approval younger than `APPROVAL_MARK_DAYS` when read: can still become a mark. */
  markable: boolean;
  request: string;
  reason?: string;
  quote?: string;
  allowedBy?: AllowedBy;
  grantId?: string;
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

/** A decision the log lists: a Waykeeper's approval, or the user's Allow once on a send. */
function listed(event: Extract<EventEnvelope['event'], { type: 'permission.decided' }>): boolean {
  return (
    isWaykeeperApproval(event) || (event.decision === 'allow' && event.allowedBy === 'allow_once')
  );
}

/**
 * The scope's listed decisions, from the log (read on demand, newest first): a project's, or
 * standalone work's when `projectId` is undefined.
 */
async function readApprovals(
  api: ReturnType<typeof useApi>,
  projectId: string | undefined,
  live: () => boolean,
): Promise<Approval[]> {
  const out: Approval[] = [];
  const now = Date.now();
  let after: number | undefined;
  for (let page = 0; page < 50 && live(); page++) {
    const query = { limit: 2000, ...(after !== undefined ? { after } : {}) };
    const res =
      projectId === undefined
        ? await api.standaloneDecisions(query)
        : await api.historyEvents({ projectId, type: 'permission.decided', ...query });
    for (const { seq, at, event } of res.events as EventEnvelope[]) {
      if (event.type !== 'permission.decided' || !listed(event)) continue;
      out.push({
        seq,
        at,
        agentId: event.agentId,
        category: approvalLogCategory(event),
        markable:
          isWaykeeperApproval(event) && now - new Date(at).getTime() <= APPROVAL_MARK_DAYS * DAY_MS,
        request: requestLine(event.toolCall.toolName, event.toolCall.input),
        ...(event.reason ? { reason: event.reason } : {}),
        ...(event.quote ? { quote: event.quote } : {}),
        ...(event.allowedBy ? { allowedBy: event.allowedBy } : {}),
        ...(event.grantId ? { grantId: event.grantId } : {}),
      });
    }
    after = res.seq;
    if (!res.hasMore) break;
  }
  return out.sort((a, b) => b.seq - a.seq);
}

/** The approvals log of a scope as read: `rows` once read, `error` when the read failed. */
export interface ApprovalsLogData {
  /** The server can read it (a stand-in api in a test may not). */
  available: boolean;
  rows?: Approval[];
  error?: string;
}

/** Reads the approvals log of a project, or of standalone work when `projectId` is undefined. */
export function useApprovalsLog(projectId: string | undefined): ApprovalsLogData {
  const api = useApi();
  const [rows, setRows] = useState<Approval[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const available =
    typeof (projectId === undefined ? api.standaloneDecisions : api.historyEvents) === 'function';
  useEffect(() => {
    if (!available) return;
    let alive = true;
    readApprovals(api, projectId, () => alive).then(
      (r) => alive && setRows(r),
      (e: unknown) => alive && setError((e as Error).message),
    );
    return () => {
      alive = false;
    };
  }, [api, available, projectId]);
  return { available, ...(rows ? { rows } : {}), ...(error ? { error } : {}) };
}

/**
 * How many sends each grant allowed: counted from the log when it was read, else from the
 * recorded approvals the world keeps (the newest ones).
 */
export function grantUses(
  log: ApprovalsLogData,
  recorded: readonly RecordedApproval[] | undefined,
): Map<string, number> {
  const uses = new Map<string, number>();
  const ids = log.rows
    ? log.rows.map((r) => (r.allowedBy === 'grant' ? r.grantId : undefined))
    : (recorded ?? []).map((r) => r.grantId);
  for (const id of ids) if (id) uses.set(id, (uses.get(id) ?? 0) + 1);
  return uses;
}

/** What allowed an entry, in words (design 2026-11-18 §4.7); none for a plain Auto approval. */
function allowedLine(row: Approval, grants: readonly SendGrant[]): string | undefined {
  switch (row.allowedBy) {
    case 'grant': {
      const grant = grants.find((g) => g.id === row.grantId);
      return grant ? `under grant: ${grant.summary}` : 'under a grant that has ended';
    }
    case 'task_words':
      return 'allowed by your words in the task';
    case 'allow_once':
      return 'allowed once by you';
    default:
      return undefined;
  }
}

function Entry({
  projectId,
  row,
  grants,
}: {
  projectId: string | undefined;
  row: Approval;
  grants: readonly SendGrant[];
}) {
  const api = useApi();
  const world = useAppStore((s) => s.world);
  const { run, error, busy } = useAction();
  const [marked, setMarked] = useState(false);
  const allowed = allowedLine(row, grants);
  return (
    <li>
      <time dateTime={row.at}>{when(row.at)}</time>
      <span>{agentLabel(world.agents[row.agentId], world)}</span>
      <code>{row.request}</code>
      {allowed && <span className="pill">{allowed}</span>}
      {row.reason && <span className="muted">{row.reason}</span>}
      {row.quote && row.allowedBy !== 'grant' && (
        <span className="muted">you asked: “{row.quote}”</span>
      )}
      {row.markable &&
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
  grants,
}: {
  projectId: string | undefined;
  category: ApprovalLogCategory;
  rows: Approval[];
  grants: readonly SendGrant[];
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
            <Entry key={r.seq} projectId={projectId} row={r} grants={grants} />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The log as read (`useApprovalsLog`): a project's under "Approved by the Waykeeper", standalone
 * work's (`projectId` undefined) under "Approved by the Harmonizer". `grants` name the grant an
 * entry used.
 */
export function ApprovalsLogView({
  projectId,
  log,
  grants,
}: {
  projectId: string | undefined;
  log: ApprovalsLogData;
  grants: readonly SendGrant[];
}) {
  if (!log.available) return null;
  if (log.error) return <ErrorLine error={log.error} />;
  const rows = log.rows;
  if (!rows) return null;
  const groups = APPROVAL_LOG_ORDER.map((category) => ({
    category,
    rows: rows.filter((r) => r.category === category),
  })).filter((g) => g.rows.length > 0);
  return (
    <div className="waykeeper-approved">
      <h4>
        {projectId === undefined ? 'Approved by the Harmonizer' : 'Approved by the Waykeeper'}
      </h4>
      {groups.length === 0 && <p className="muted">Nothing yet.</p>}
      {groups.map((g) => (
        <Group
          key={g.category}
          projectId={projectId}
          category={g.category}
          rows={g.rows}
          grants={grants}
        />
      ))}
    </div>
  );
}

/** A project's approvals log, read on its own. */
export function ApprovalsLog({ project }: { project: Project }) {
  const log = useApprovalsLog(project.id);
  return <ApprovalsLogView projectId={project.id} log={log} grants={project.sendGrants ?? []} />;
}
