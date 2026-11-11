import {
  type PanelDraft,
  type Proposal,
  type ProposalDecisionBody,
  type ProposalPanel,
} from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import { ErrorLine, StatePill, useAction, useApi } from '../../console/hierarchy/shared.js';
import { OfflineDecisionNote, useStreamDown } from './QueuedAnswer.js';
import { AgentRef } from './links.js';
import { JobDetails, useMacOnly } from './JobCard.js';
import { RejectForm } from './ProposalCard.js';

/**
 * A Waykeeper's panel card (P15-08; SPEC decision 156): add, change or remove one panel of its
 * long-term project's dashboard, with the job part that fills it — an existing job ("No job
 * changes") or a job proposed in the same card (shown as a job card's body). Approve or Reject
 * with a reason, never Edit. A panel grants nothing; a job part that grants new unattended rules
 * is approved only where a job card would be (the Mac, or a phone under `autoApproveRemote`).
 */

export const PANEL_CARD_TITLES: Record<ProposalPanel['action'], string> = {
  create: 'New panel',
  change: 'Change panel',
  remove: 'Remove panel',
};

const displayText = (d: PanelDraft['display']): string =>
  [
    d.format,
    d.unit && `unit ${d.unit}`,
    d.currency,
    d.compare && `compare to last ${d.compare}`,
    d.rangeDays && `last ${d.rangeDays} days`,
    d.columns && `columns ${d.columns.join(', ')}`,
  ]
    .filter(Boolean)
    .join(' · ') || 'default';

const valuesText = (d: PanelDraft): string =>
  d.source.kind === 'job' ? d.source.values.join(', ') : "the project's tasks";

const limitsText = (d: PanelDraft): string =>
  d.limits.length > 0 ? d.limits.map((l) => `${l.value} (better: ${l.better})`).join('; ') : 'none';

/** A change's changed fields: `[field, before, after]`. */
function panelChanges(before: PanelDraft, after: PanelDraft): [string, string, string][] {
  const fields: [string, (d: PanelDraft) => string][] = [
    ['type', (d) => d.type],
    ['title', (d) => d.title],
    ['shows', valuesText],
    ['display', (d) => displayText(d.display)],
    ['limits', limitsText],
  ];
  return fields.flatMap(([name, text]) =>
    text(before) === text(after)
      ? []
      : [[name, text(before), text(after)] as [string, string, string]],
  );
}

function PanelFacts({ draft }: { draft: PanelDraft }) {
  return (
    <dl className="facts">
      <div>
        <dt>type</dt>
        <dd>{draft.type}</dd>
      </div>
      <div>
        <dt>title</dt>
        <dd>{draft.title}</dd>
      </div>
      <div>
        <dt>shows</dt>
        <dd>{valuesText(draft)}</dd>
      </div>
      <div>
        <dt>display</dt>
        <dd>{displayText(draft.display)}</dd>
      </div>
      <div className="wide">
        <dt>limits</dt>
        <dd>{limitsText(draft)}</dd>
      </div>
    </dl>
  );
}

function JobPart({ card }: { card: ProposalPanel }) {
  const job = useAppStore((s) =>
    card.job && 'use' in card.job ? s.world.jobs[card.job.use] : undefined,
  );
  if (!card.job) return null;
  if ('propose' in card.job) return <JobDetails job={card.job.propose} />;
  const values = card.draft?.source.kind === 'job' ? card.draft.source.values.join(', ') : '';
  return (
    <p className="muted">
      Filled by job &apos;{job?.name ?? card.job.use}&apos;, which already reports {values}. No job
      changes.
    </p>
  );
}

export function PanelCard({ proposal: p, panel }: { proposal: Proposal; panel: ProposalPanel }) {
  const api = useApi();
  const project = useAppStore((s) => s.world.projects[panel.projectId]);
  const { run, error, busy: running } = useAction();
  const offline = useStreamDown();
  const busy = running || offline;
  const decide = (d: ProposalDecisionBody) => run(() => api.decide(p.id, d));
  const proposedJob = panel.job && 'propose' in panel.job ? panel.job.propose : undefined;
  const macOnly = useMacOnly(proposedJob);
  const shown = panel.draft ?? panel.before;
  const changes =
    panel.action === 'change' && panel.before && panel.draft
      ? panelChanges(panel.before, panel.draft)
      : [];
  return (
    <article
      className={`card proposal panel-card proposal-${p.state}`}
      aria-label={`panel card ${p.requestText}`}
    >
      <header>
        <StatePill state={p.state} />
        <strong>{PANEL_CARD_TITLES[panel.action]}</strong>
        <span className="muted">
          {project ? `${project.name} · ` : ''}by <AgentRef agentId={panel.waykeeperId} />
        </span>
      </header>
      {shown && <PanelFacts draft={shown} />}
      {changes.length > 0 && (
        <ul className="items job-changes" aria-label="changes">
          {changes.map(([field, was, will]) => (
            <li key={field}>
              <strong>{field}:</strong> {was} → {will}
            </li>
          ))}
        </ul>
      )}
      <JobPart card={panel} />
      {p.rationale && <p className="muted">{p.rationale}</p>}
      {offline && <OfflineDecisionNote />}
      {p.state !== 'rejected' && (
        <div className="controls">
          <button disabled={busy || macOnly} onClick={() => decide({ decision: 'approve' })}>
            Approve
          </button>
        </div>
      )}
      {p.state !== 'rejected' && macOnly && (
        <p className="muted">
          Only the Mac (or a phone when remote auto-approval is on) can approve a job that grants
          what its runs may do unattended. You can reject it here.
        </p>
      )}
      {p.state !== 'rejected' && (
        <RejectForm
          busy={busy}
          onReject={(reason) => decide({ decision: 'reject', ...(reason ? { reason } : {}) })}
        />
      )}
      <ErrorLine error={error} />
    </article>
  );
}
