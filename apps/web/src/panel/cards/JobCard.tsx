import { useState } from 'react';
import {
  scheduleText,
  type JobDraft,
  type Proposal,
  type ProposalDecisionBody,
  type ProposalJob,
} from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import type { WorldState } from '../../state/reduce.js';
import { ErrorLine, StatePill, useAction, useApi } from '../../console/hierarchy/shared.js';
import { OfflineDecisionNote, useStreamDown } from './QueuedAnswer.js';
import { AgentRef } from './links.js';
import { RejectForm } from './ProposalCard.js';

/**
 * A Waykeeper's job card (P10-07; SPEC decision 144, `Proposal.meta.job`): a new recurring job, a
 * change to one or its stop — the job's name, the moon it lives on, its schedule, provider,
 * instructions and what its runs may do without asking. The user decides it as the Waykeeper made
 * it: Approve or Reject with a reason, never Edit (the server refuses an edit). A change card lists
 * the changed fields as before → after.
 */

export const JOB_CARD_TITLES: Record<ProposalJob['action'], string> = {
  create: 'New recurring job',
  change: 'Change job',
  stop: 'Stop job',
};

/** Instructions longer than this many lines are collapsed. */
const INSTRUCTION_LINES = 6;

type JobWorld = Pick<WorldState, 'areas' | 'bodies'>;

const areaName = (world: JobWorld, areaId: string) => world.areas[areaId]?.name ?? 'an area';

/**
 * "Marketing area on Titan" for an existing area; "Feedback moon · new area" for one the approval
 * creates (with the moon it would likely take, a preview: ruling R10).
 */
export function jobAreaLine(world: JobWorld, job: ProposalJob): string {
  const target = job.area ?? (job.before ? { areaId: job.before.areaId } : undefined);
  const preview = job.moonId ? world.bodies[job.moonId]?.name : undefined;
  if (!target) return preview ? `on ${preview}` : '—';
  if ('name' in target) {
    return `${target.name} moon · new area${preview ? ` (likely ${preview})` : ''}`;
  }
  const area = world.areas[target.areaId];
  const moon = (area ? world.bodies[area.bodyId]?.name : undefined) ?? preview;
  return `${area?.name ?? 'an area'} area${moon ? ` on ${moon}` : ''}`;
}

const rulesText = (d: JobDraft) =>
  d.unattendedRules.length > 0 ? d.unattendedRules.map((r) => r.label).join(', ') : 'none';

/** A change card's changed fields: `[field, before, after]`. */
export function jobChanges(world: JobWorld, job: ProposalJob): [string, string, string][] {
  const before = job.before?.draft;
  const fromArea = job.before?.areaId;
  const after = job.draft;
  if (job.action !== 'change' || !before || !fromArea || !after) return [];
  const changes: [string, string, string][] = [];
  if (before.name !== after.name) changes.push(['name', before.name, after.name]);
  const was = scheduleText(before.schedule);
  const will = scheduleText(after.schedule);
  if (was !== will) changes.push(['schedule', was, will]);
  if (before.provider !== after.provider)
    changes.push(['provider', before.provider, after.provider]);
  if (before.instructions !== after.instructions) {
    changes.push(['instructions', 'as they were', 'rewritten (below)']);
  }
  if (rulesText(before) !== rulesText(after)) {
    changes.push(['may do without asking', rulesText(before), rulesText(after)]);
  }
  const area = job.area;
  if (area) {
    const to = 'name' in area ? `${area.name} (new)` : areaName(world, area.areaId);
    if (!('areaId' in area) || area.areaId !== fromArea) {
      changes.push(['area', areaName(world, fromArea), to]);
    }
  }
  return changes;
}

function Instructions({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const lines = text.split('\n');
  const long = lines.length > INSTRUCTION_LINES;
  return (
    <>
      <pre className="job-instructions">
        {long && !open ? lines.slice(0, INSTRUCTION_LINES).join('\n') : text}
      </pre>
      {long && (
        <button className="secondary" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? 'Show less' : `Show all ${lines.length} lines`}
        </button>
      )}
    </>
  );
}

export function JobCard({ proposal: p, job }: { proposal: Proposal; job: ProposalJob }) {
  const api = useApi();
  const world = useAppStore((s) => s.world);
  const { run, error, busy: running } = useAction();
  // Card decisions are not queued offline (P7-05): they wait for the connection.
  const offline = useStreamDown();
  const busy = running || offline;
  const decide = (d: ProposalDecisionBody) => run(() => api.decide(p.id, d));
  const shown = job.draft ?? job.before?.draft;
  const changes = jobChanges(world, job);
  const project = world.projects[job.projectId];
  return (
    <article
      className={`card proposal job-card proposal-${p.state}`}
      aria-label={`job card ${p.requestText}`}
    >
      <header>
        <StatePill state={p.state} />
        <strong>{JOB_CARD_TITLES[job.action]}</strong>
        <span className="muted">
          {project ? `${project.name} · ` : ''}by <AgentRef agentId={job.waykeeperId} />
        </span>
      </header>
      {shown && (
        <dl className="facts">
          <div>
            <dt>name</dt>
            <dd>{shown.name}</dd>
          </div>
          <div>
            <dt>moon</dt>
            <dd>{jobAreaLine(world, job)}</dd>
          </div>
          <div>
            <dt>schedule</dt>
            <dd>{scheduleText(shown.schedule)}</dd>
          </div>
          <div>
            <dt>provider</dt>
            <dd>{shown.provider}</dd>
          </div>
          <div className="wide">
            <dt>instructions</dt>
            <dd>
              <Instructions text={shown.instructions} />
            </dd>
          </div>
        </dl>
      )}
      {changes.length > 0 && (
        <ul className="items job-changes" aria-label="changes">
          {changes.map(([field, was, will]) => (
            <li key={field}>
              <strong>{field}:</strong> {was} → {will}
            </li>
          ))}
        </ul>
      )}
      {shown &&
        (shown.unattendedRules.length > 0 ? (
          <div className="job-rules">
            <p>May do without asking:</p>
            <ul className="items" aria-label="may do without asking">
              {shown.unattendedRules.map((r, i) => (
                <li key={r.id ?? i}>{r.label}</li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="muted">Nothing — it asks for anything outside the project&apos;s rules</p>
        ))}
      {p.rationale && <p className="muted">{p.rationale}</p>}
      {offline && <OfflineDecisionNote />}
      {p.state !== 'rejected' && (
        <div className="controls">
          <button disabled={busy} onClick={() => decide({ decision: 'approve' })}>
            Approve
          </button>
        </div>
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
