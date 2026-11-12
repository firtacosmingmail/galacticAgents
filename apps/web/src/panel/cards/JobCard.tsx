import { useState } from 'react';
import {
  affectedPanels,
  panelsOf,
  scheduleText,
  type JobDataMap,
  type JobDraft,
  type Panel,
  type Proposal,
  type ProposalDecisionBody,
  type ProposalJob,
} from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import type { WorldState } from '../../state/reduce.js';
import { ErrorLine, StatePill, useAction, useApi } from '../../console/hierarchy/shared.js';
import { OfflineDecisionNote, useStreamDown } from './QueuedAnswer.js';
import { useClientRules } from '../deliverables/use-deliverables.js';
import { AgentRef } from './links.js';
import { choiceText, jobPublishesWith } from '../providers.js';
import { RejectForm } from './ProposalCard.js';

/**
 * A Waykeeper's job card (P10-07; SPEC decision 144, `Proposal.meta.job`): a new recurring job, a
 * change to one or its stop — the job's name, the moon it lives on, its schedule, provider,
 * instructions and what its runs may do without asking. The user decides it as the Waykeeper made
 * it: Approve or Reject with a reason, never Edit (the server refuses an edit). A change card lists
 * the changed fields as before → after. A card that grants new unattended rules is approved only
 * from a client that may write settings (the Mac, or any under `autoApproveRemote`).
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

type RuleShape = Pick<
  JobDraft['unattendedRules'][number],
  'scope' | 'tool' | 'match' | 'categories'
>;
const ruleShape = (r: RuleShape) =>
  JSON.stringify([r.scope, r.tool, r.match, [...r.categories].sort()]);

/**
 * Whether approving the card grants a rule its job does not have yet — a new or a widened one —
 * which only the Mac (or a phone under `autoApproveRemote`) may approve (decision 138, as the
 * server checks). A stop, no rules, or rules the job already has grant nothing.
 */
export function jobGrantsNewRules(job: ProposalJob): boolean {
  if (job.action === 'stop' || !job.draft) return false;
  const have = new Set((job.before?.draft.unattendedRules ?? []).map(ruleShape));
  return job.draft.unattendedRules.some((r) => !have.has(ruleShape(r)));
}

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
  const wasAi = choiceText(before.provider, before.model)!;
  const willAi = choiceText(after.provider, after.model)!;
  if (wasAi !== willAi) changes.push(['provider', wasAi, willAi]);
  const wasFollow = choiceText(before.followUpProvider, before.followUpModel) ?? 'same as the job';
  const willFollow = choiceText(after.followUpProvider, after.followUpModel) ?? 'same as the job';
  if (wasFollow !== willFollow) changes.push(['follow-up provider', wasFollow, willFollow]);
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

/** The data map a job card shows: where the data comes from, what is collected, the steps. */
function DataMapView({ map }: { map: JobDataMap }) {
  return (
    <div className="job-datamap">
      <p>Where its data comes from:</p>
      <ul className="items" aria-label="sources">
        {map.sources.map((src) => (
          <li key={src.id}>
            <strong>{src.label}</strong> <span className="muted">({src.kind})</span> {src.target}
          </li>
        ))}
      </ul>
      <p>What it collects:</p>
      <ul className="items" aria-label="collected values">
        {map.collects.map((c) => (
          <li key={c.name}>
            <strong>{c.name}</strong> <span className="muted">({c.kind})</span> {c.description}
          </li>
        ))}
      </ul>
      <p>What it does:</p>
      <ol className="items" aria-label="steps">
        {map.steps.map((step, i) => (
          <li key={i}>{step.text}</li>
        ))}
      </ol>
    </div>
  );
}

/**
 * What a job proposal says about the job — its facts, the changed fields, what it may do without
 * asking and its data map — shared by the job card and the panel card that proposes a job.
 */
export function JobDetails({ job }: { job: ProposalJob }) {
  const world = useAppStore((s) => s.world);
  const shown = job.draft ?? job.before?.draft;
  const changes = jobChanges(world, job);
  return (
    <>
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
            <dd>{choiceText(shown.provider, shown.model)}</dd>
          </div>
          <div>
            <dt>follow-up provider</dt>
            <dd>{choiceText(shown.followUpProvider, shown.followUpModel) ?? 'same as the job'}</dd>
          </div>
          <div>
            <dt>publishes with</dt>
            <dd>{jobPublishesWith(shown).text}</dd>
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
      {shown?.dataMap && <DataMapView map={shown.dataMap} />}
    </>
  );
}

/** Whether approving the job part of a card is for the Mac only (new rules, no local client). */
export function useMacOnly(job: ProposalJob | undefined): boolean {
  const mayEdit = useClientRules().edit;
  return !mayEdit && job !== undefined && jobGrantsNewRules(job);
}

/**
 * The panels a stop or a change that drops collected values leaves without data, as the server
 * works them out when the card is approved with `removePanels` (`removeJobPanels`). A panel card
 * passes its job part and the panel it is about (`except`), which is never listed.
 */
export function usePanelsAffected(job: ProposalJob | undefined, except?: string): Panel[] {
  const world = useAppStore((s) => s.world);
  if (!job?.jobId || (job.action !== 'stop' && job.action !== 'change')) return [];
  const panels = panelsOf(world, job.projectId).filter((p) => p.id !== except);
  if (job.action === 'stop') return affectedPanels(panels, job.jobId);
  const after = job.draft?.dataMap;
  if (!after || JSON.stringify(after) === JSON.stringify(job.before?.draft.dataMap)) return [];
  return affectedPanels(panels, job.jobId, after);
}

/** "Panels affected:" and the unticked "Also remove these panels" (P15-08, ruling R18). */
export function PanelsAffected({
  panels,
  checked,
  onChange,
}: {
  panels: Panel[];
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="job-panels">
      <p>Panels affected:</p>
      <ul className="items" aria-label="Panels affected">
        {panels.map((panel) => (
          <li key={panel.id}>{panel.title}</li>
        ))}
      </ul>
      <label>
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />{' '}
        Also remove these panels
      </label>
    </div>
  );
}

export function JobCard({ proposal: p, job }: { proposal: Proposal; job: ProposalJob }) {
  const api = useApi();
  const world = useAppStore((s) => s.world);
  const { run, error, busy: running } = useAction();
  const offline = useStreamDown();
  const busy = running || offline;
  const [alsoRemove, setAlsoRemove] = useState(false);
  const affected = usePanelsAffected(job);
  const decide = (d: ProposalDecisionBody) => run(() => api.decide(p.id, d));
  const project = world.projects[job.projectId];
  const macOnly = useMacOnly(job);
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
      <JobDetails job={job} />
      {affected.length > 0 && p.state !== 'rejected' && (
        <PanelsAffected panels={affected} checked={alsoRemove} onChange={setAlsoRemove} />
      )}
      {p.rationale && <p className="muted">{p.rationale}</p>}
      {offline && <OfflineDecisionNote />}
      {p.state !== 'rejected' && (
        <div className="controls">
          <button
            disabled={busy || macOnly}
            onClick={() =>
              decide({
                decision: 'approve',
                ...(alsoRemove && affected.length > 0 ? { removePanels: true as const } : {}),
              })
            }
          >
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
