import { markLabel, type Project, type StandingApproval } from '@galactic/protocol';
import { ErrorLine, useAction, useApi } from '../../console/hierarchy/shared.js';
import { ApprovalsLog } from './ApprovalsLog.js';

/**
 * A project's Waykeeper approvals (P13-06, design §5.6; SPEC decision 154), beside its "Allow
 * similar" rules: the switch "Waykeeper approves Stewards' requests" and the standing approvals,
 * each with what it covers, who made it and when, and a Remove button. Turning the switch on is
 * the Mac's alone: from a remote client the server answers 403 and its message shows here, next
 * to the switch. Turning it off and removing a standing approval work from anywhere.
 */

export function when(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? at : d.toLocaleString();
}

type Mode = 'off' | 'task' | 'auto';
const CHOICES: {
  id: Mode;
  label: string;
  send: (api: ReturnType<typeof useApi>, id: string) => Promise<unknown>;
}[] = [
  { id: 'off', label: 'Off', send: (api, id) => api.setWaykeeperApprovals(id, false) },
  {
    id: 'task',
    label: 'Only what fits the task',
    send: (api, id) => api.setWaykeeperApprovals(id, true, false),
  },
  {
    id: 'auto',
    label: 'Auto: everything except pushing, sending, spending and deletes outside the project',
    send: (api, id) => api.setWaykeeperApprovals(id, true, true),
  },
];

/** "Always asks me (n)": the marks that make the Waykeeper ask the user again (design §4.1). */
function ApprovalMarks({ project }: { project: Project }) {
  const api = useApi();
  const { run, error, busy } = useAction();
  const marks = project.approvalMarks ?? [];
  if (marks.length === 0) return null;
  return (
    <div className="approval-marks">
      <h4>Always asks me ({marks.length})</h4>
      <ul className="permission-rules" aria-label="always asks me">
        {marks.map((m) => (
          <li key={m.id}>
            <strong>{markLabel(m.match)}</strong>
            <span className="muted">from “{m.example}”</span>
            <span className="muted">added {when(m.createdAt)}</span>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              aria-label={`Remove the mark ${markLabel(m.match)}`}
              onClick={() => void run(() => api.removeApprovalMark(project.id, m.id))}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <ErrorLine error={error} />
    </div>
  );
}

export function StandingApprovals({ project }: { project: Project }) {
  const api = useApi();
  const { run, error, busy } = useAction();
  const approvals: StandingApproval[] = project.standingApprovals ?? [];
  const mode: Mode =
    project.waykeeperApprovals !== true ? 'off' : project.waykeeperAuto ? 'auto' : 'task';
  const canSwitch = typeof api.setWaykeeperApprovals === 'function';
  return (
    <div className="standing-approvals">
      {canSwitch && (
        <div
          className="waykeeper-switch"
          role="radiogroup"
          aria-labelledby={`waykeeper-mode-label-${project.id}`}
        >
          <p id={`waykeeper-mode-label-${project.id}`}>
            Waykeeper approves Stewards&apos; requests
          </p>
          {CHOICES.map((c) => (
            <label key={c.id}>
              <input
                type="radio"
                name={`waykeeper-mode-${project.id}`}
                checked={mode === c.id}
                disabled={busy}
                onChange={() => void run(() => c.send(api, project.id))}
              />{' '}
              {c.label}
            </label>
          ))}
        </div>
      )}
      <ErrorLine error={error} />
      <ApprovalMarks project={project} />
      <ApprovalsLog project={project} />
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
