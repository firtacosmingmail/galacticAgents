import { useState, type FormEvent } from 'react';
import {
  proposalParking,
  proposalPlan,
  proposalPromotion,
  proposalTrust,
  TrustLevel,
  WorkBodyKind,
  type Body,
  type ParkOffer,
  type Proposal,
  type ProposalDecisionBody,
  type ProposedBody,
} from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import type { WorldState } from '../../state/reduce.js';
import { Controls } from './WorkTree.js';
import { actorLabel, ErrorLine, StatePill, useAction, useApi } from './shared.js';

/**
 * Proposal cards (P2-18; SPEC §3.3): the one card a work request produces — approve, edit its
 * size, body and workspace, give the `git init` consent (decision 27) or choose the project's
 * trust level (decision 49), reject with a reason; a
 * parked card shows the occupied bodies and the offers (decision 16, 38) — and a Waykeeper's plan
 * card, approved or rejected as a whole and edited through its tasks (decision 35).
 */

/** What each trust level lets the project's Stewards do without a card (decision 49). */
export const TRUST_HINTS: Record<TrustLevel, string> = {
  default: 'asks before deleting, leaving the workspace, the network and pushing',
  trusting: 'also installs and uses the network on its own',
  cautious: 'asks for every change',
  trusted: 'everything without a card except a push',
};

const OPEN: ReadonlySet<Proposal['state']> = new Set(['pending', 'edited', 'parked']);

const OFFERS: Record<ParkOffer, string> = {
  downsize_moon: 'make it a moon project',
  downsize_asteroid: 'make it standalone work on an asteroid',
  close_early: 'close a completed project early to free its body',
  task_on_planet: 'keep it a task on its planet',
};

export function ProposalCards() {
  const proposals = useAppStore((s) => s.world.proposals);
  const all = Object.values(proposals).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const open = all.filter((p) => OPEN.has(p.state));
  const drafts = all.filter((p) => p.state === 'rejected');
  const decided = all.filter((p) => p.state === 'approved').slice(-5);
  return (
    <section className="proposals" aria-label="proposals">
      <h3>Cards waiting for you ({open.length})</h3>
      {open.length === 0 && <p className="muted">Nothing to decide.</p>}
      {open.map((p) => (
        <ProposalCard key={p.id} proposal={p} />
      ))}
      {drafts.length > 0 && (
        <details>
          <summary>Rejected drafts ({drafts.length})</summary>
          {drafts.map((p) => (
            <ProposalCard key={p.id} proposal={p} />
          ))}
        </details>
      )}
      {decided.length > 0 && (
        <details>
          <summary>Recently approved ({decided.length})</summary>
          <ul className="items">
            {decided.map((p) => (
              <li key={p.id}>
                {proposalPlan(p) ? 'plan' : p.kind} · {p.requestText}
                {carriedOutLine(p)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function carriedOutLine(p: Proposal): string {
  const outcome = p.meta?.['carriedOut'] as { ok?: boolean; error?: string } | undefined;
  if (!outcome) return '';
  return outcome.ok ? ' · carried out' : ` · failed: ${outcome.error ?? 'unknown'}`;
}

export function ProposalCard({ proposal }: { proposal: Proposal }) {
  return proposalPlan(proposal) ? (
    <PlanCard proposal={proposal} />
  ) : (
    <WorkCard proposal={proposal} />
  );
}

function RejectForm({
  onReject,
  busy,
}: {
  onReject: (reason: string | undefined) => void;
  busy: boolean;
}) {
  const [reason, setReason] = useState('');
  return (
    <form
      className="send"
      onSubmit={(e) => {
        e.preventDefault();
        onReject(reason.trim() || undefined);
      }}
    >
      <input
        aria-label="reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="why (optional)"
      />
      <button type="submit" className="danger" disabled={busy}>
        Reject
      </button>
    </form>
  );
}

function requestType(p: Proposal): string | undefined {
  const r = p.meta?.['request'] as { type?: string } | undefined;
  return r?.type?.replace(/_/g, ' ');
}

function WorkCard({ proposal: p }: { proposal: Proposal }) {
  const api = useApi();
  const world = useAppStore((s) => s.world);
  const { run, error, busy } = useAction();
  const [editing, setEditing] = useState(false);
  const decide = (d: ProposalDecisionBody) => run(() => api.decide(p.id, d));
  const parking = proposalParking(p);
  const promotion = proposalPromotion(p);
  const body = p.proposedBody.bodyId ? world.bodies[p.proposedBody.bodyId] : undefined;
  const initGit = p.meta?.['initGit'] === true;
  const trust = proposalTrust(p);
  return (
    <article
      className={`card proposal proposal-${p.state}`}
      aria-label={`proposal ${p.requestText}`}
    >
      <header>
        <StatePill state={p.state} />
        <strong>{p.requestText}</strong>
        <span className="muted">{requestType(p) ?? 'work card'}</span>
      </header>
      <dl className="facts">
        <div>
          <dt>size</dt>
          <dd>{p.kind}</dd>
        </div>
        <div>
          <dt>body</dt>
          <dd>
            {p.proposedBody.name}
            {body ? ` (${body.kind})` : p.proposedBody.bodyId ? '' : ' (server picks a free one)'}
          </dd>
        </div>
        <div className="wide">
          <dt>workspace</dt>
          <dd>
            <code>{p.workspace}</code>
            {initGit ? ' · git init agreed' : ''}
          </dd>
        </div>
        {p.kind !== 'asteroid' && (
          <div className="wide">
            <dt>trust level</dt>
            <dd aria-label="trust level">
              {trust} <span className="muted">— {TRUST_HINTS[trust]}</span>
            </dd>
          </div>
        )}
        {promotion && (
          <div className="wide">
            <dt>moves</dt>
            <dd>
              {promotion.target.kind} {promotion.target.id}
              {promotion.toProjectId
                ? ` into ${world.projects[promotion.toProjectId]?.name ?? promotion.toProjectId}`
                : ''}
            </dd>
          </div>
        )}
        {p.rationale && (
          <div className="wide">
            <dt>why</dt>
            <dd>{p.rationale}</dd>
          </div>
        )}
      </dl>
      {parking && <Parked parking={parking} proposal={p} decide={decide} busy={busy} />}
      <div className="controls">
        {p.state !== 'rejected' && (
          <button disabled={busy} onClick={() => decide({ decision: 'approve' })}>
            Approve
          </button>
        )}
        <button disabled={busy} className="secondary" onClick={() => setEditing((e) => !e)}>
          Edit
        </button>
      </div>
      {editing && (
        <EditCard
          proposal={p}
          world={world}
          busy={busy}
          onSave={async (changes) => {
            if (await decide({ decision: 'edit', changes })) setEditing(false);
          }}
        />
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

function Parked({
  parking,
  proposal,
  decide,
  busy,
}: {
  parking: NonNullable<ReturnType<typeof proposalParking>>;
  proposal: Proposal;
  decide: (d: ProposalDecisionBody) => Promise<boolean>;
  busy: boolean;
}) {
  const world = useAppStore((s) => s.world);
  const name = proposal.proposedBody.name;
  return (
    <div className="parked">
      <p>
        <strong>Parked:</strong> {parking.reason}
        {parking.waitingFor ? ` — it resumes by itself when a ${parking.waitingFor} frees.` : ''}
      </p>
      {parking.occupied && parking.occupied.length > 0 && (
        <ul className="items" aria-label="occupied bodies">
          {parking.occupied.map((o) => {
            const project = o.host?.kind === 'project' ? world.projects[o.host.id] : undefined;
            return (
              <li key={o.bodyId}>
                {o.bodyName}: {o.occupant ?? (o.movedTo ? 'moved away' : '—')}
                {o.state ? ` (${o.state.replace(/_/g, ' ')})` : ''}
                {project && project.state === 'completed' && (
                  <Controls target={{ kind: 'project', id: project.id }} item={project} />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {parking.offers && parking.offers.length > 0 && (
        <div className="controls" aria-label="offers">
          {parking.offers.map((offer) =>
            offer === 'downsize_moon' || offer === 'downsize_asteroid' ? (
              <button
                key={offer}
                disabled={busy}
                onClick={() => {
                  const kind = offer === 'downsize_moon' ? 'moon' : 'asteroid';
                  void decide({
                    decision: 'edit',
                    changes: { kind, proposedBody: { kind, name } },
                  });
                }}
              >
                {OFFERS[offer]}
              </button>
            ) : (
              <span key={offer} className="muted">
                or {OFFERS[offer]}
              </span>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** The free bodies of a kind the card may name (not reserved, not hosting, no "moved" marker). */
function freeBodies(world: Pick<WorldState, 'bodies'>, kind: Proposal['kind']): Body[] {
  if (kind === 'asteroid') return [];
  return Object.values(world.bodies)
    .filter((b) => b.kind === kind && !b.host && !b.movedTo && b.meta?.['reserved'] !== true)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function EditCard({
  proposal: p,
  world,
  busy,
  onSave,
}: {
  proposal: Proposal;
  world: WorldState;
  busy: boolean;
  onSave: (changes: Extract<ProposalDecisionBody, { decision: 'edit' }>['changes']) => void;
}) {
  const [kind, setKind] = useState<Proposal['kind']>(p.kind);
  const [bodyId, setBodyId] = useState(p.proposedBody.bodyId ?? '');
  const [name, setName] = useState(p.proposedBody.name);
  const [workspace, setWorkspace] = useState(p.workspace);
  const [initGit, setInitGit] = useState(p.meta?.['initGit'] === true);
  const [trust, setTrust] = useState<TrustLevel>(proposalTrust(p));
  const choices = freeBodies(world, kind);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const chosen = bodyId ? world.bodies[bodyId] : undefined;
    const proposedBody: ProposedBody = {
      kind,
      name: chosen?.name ?? (name.trim() || p.proposedBody.name),
      ...(chosen ? { bodyId: chosen.id } : {}),
      ...(chosen?.parentId ? { parentId: chosen.parentId } : {}),
    };
    const sameBody =
      kind === p.kind &&
      proposedBody.name === p.proposedBody.name &&
      proposedBody.bodyId === p.proposedBody.bodyId;
    onSave({
      ...(kind !== p.kind ? { kind } : {}),
      ...(sameBody ? {} : { proposedBody }),
      ...(workspace.trim() && workspace.trim() !== p.workspace
        ? { workspace: workspace.trim() }
        : {}),
      ...(initGit !== (p.meta?.['initGit'] === true) ? { initGit } : {}),
      ...(trust !== proposalTrust(p) ? { trust } : {}),
    });
  };
  return (
    <form className="edit" onSubmit={submit} aria-label="edit card">
      <label>
        size
        <select
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as Proposal['kind']);
            setBodyId('');
          }}
        >
          {WorkBodyKind.options.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </label>
      {kind !== 'asteroid' && (
        <label>
          body
          <select value={bodyId} onChange={(e) => setBodyId(e.target.value)}>
            <option value="">any free {kind}</option>
            {choices.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {!bodyId && (
        <label>
          name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
      )}
      <label className="grow">
        workspace
        <input value={workspace} onChange={(e) => setWorkspace(e.target.value)} />
      </label>
      <label className="check">
        <input type="checkbox" checked={initGit} onChange={(e) => setInitGit(e.target.checked)} />
        git init this folder if it is not a repository
      </label>
      {kind !== 'asteroid' && (
        <label>
          trust level
          <select value={trust} onChange={(e) => setTrust(e.target.value as TrustLevel)}>
            {TrustLevel.options.map((t) => (
              <option key={t} value={t}>
                {t} — {TRUST_HINTS[t]}
              </option>
            ))}
          </select>
        </label>
      )}
      <button type="submit" disabled={busy}>
        Save
      </button>
    </form>
  );
}

function PlanCard({ proposal: p }: { proposal: Proposal }) {
  const api = useApi();
  const world = useAppStore((s) => s.world);
  const { run, error, busy } = useAction();
  const plan = proposalPlan(p)!;
  const project = world.projects[plan.projectId];
  const decide = (d: ProposalDecisionBody) => run(() => api.decide(p.id, d));
  return (
    <article className={`card plan proposal-${p.state}`} aria-label={`plan ${p.requestText}`}>
      <header>
        <StatePill state={p.state} />
        <strong>Plan for {project?.name ?? plan.projectId}</strong>
        <span className="muted">
          by {actorLabel({ type: 'agent', id: plan.waykeeperId }, world)}
        </span>
      </header>
      <p>{p.requestText}</p>
      {p.rationale && <p className="muted">{p.rationale}</p>}
      <ol className="plan-tasks">
        {plan.taskIds.map((id) => {
          const task = world.tasks[id];
          if (!task) return <li key={id}>{id}</li>;
          return (
            <li key={id}>
              <StatePill state={task.state} /> {task.description}
              {task.priority !== 'normal' ? ` (${task.priority})` : ''}
              {task.state === 'proposed' && p.state !== 'approved' && (
                <Controls target={{ kind: 'task', id }} item={task} />
              )}
            </li>
          );
        })}
      </ol>
      <div className="controls">
        {p.state !== 'rejected' && (
          <button disabled={busy} onClick={() => decide({ decision: 'approve' })}>
            Approve plan
          </button>
        )}
      </div>
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
