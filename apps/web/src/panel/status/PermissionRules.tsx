import type { PermissionRule, PermissionRuleScope, Project } from '@galactic/protocol';
import { ErrorLine, useAction, useApi } from '../../console/hierarchy/shared.js';
import { StandingApprovals } from './StandingApprovals.js';
import { useClientRules } from '../deliverables/use-deliverables.js';

/**
 * A project's "Allow similar" rules (P9-17, SPEC decision 138), in its permission settings (the
 * project's status view): each with its scope, what it matches, who made it and when, and a
 * Remove button — on the Mac's own page, or on any client when the server sets
 * `autoApproveRemote` (elsewhere the list is read-only). Rules end when the project is closed,
 * cancelled or archived; the list says so.
 */

const SCOPE: Record<PermissionRuleScope, string> = {
  exact: 'exactly',
  prefix: 'prefix / folder',
  category: 'category',
  folder: 'folder',
  site: 'site',
};

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** A file-tool folder rule says which kind of access its tool gives. */
function fileToolAccess(tool: string): string {
  if (READ_TOOLS.has(tool)) return ' · reading';
  if (WRITE_TOOLS.has(tool)) return ' · writing';
  return ' · by file tools';
}

function when(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? at : d.toLocaleString();
}

export function PermissionRules({ project }: { project: Project }) {
  const api = useApi();
  const { edit } = useClientRules();
  const { run, error, busy } = useAction();
  const rules: PermissionRule[] = project.permissionRules ?? [];
  const removable = edit && typeof api.removePermissionRule === 'function';
  return (
    <>
      {rules.length === 0 ? (
        <p className="muted sts-empty">
          None. “Allow similar” on a permission card adds one; it lasts until the project closes.
        </p>
      ) : (
        <ul className="permission-rules" aria-label="allowed similar actions">
          {rules.map((r) => (
            <li key={r.id}>
              <span className="pill">
                {SCOPE[r.scope]}
                {r.scope === 'folder' && r.match.kind === 'folder'
                  ? r.match.access === 'any'
                    ? ' · reading and writing'
                    : fileToolAccess(r.tool)
                  : ''}
              </span>
              <code>{r.label}</code>
              <span className="muted">
                {r.tool !== '*' ? `${r.tool} · ` : ''}added {when(r.createdAt)}
                {r.origin === 'remote' ? ' from a remote client' : ''}
              </span>
              {removable && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  aria-label={`Remove the rule ${r.label}`}
                  onClick={() => void run(() => api.removePermissionRule(project.id, r.id))}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ErrorLine error={error} />
      <StandingApprovals project={project} />
    </>
  );
}
