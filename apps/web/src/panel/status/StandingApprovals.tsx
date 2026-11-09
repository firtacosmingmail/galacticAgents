import type { Project, StandingApproval } from '@galactic/protocol';
import { ErrorLine, useAction, useApi } from '../../console/hierarchy/shared.js';

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
