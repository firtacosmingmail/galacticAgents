import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  formatUsd,
  isCatalogued,
  proposalBudget,
  proposalParking,
  proposalPlan,
  proposalPromotion,
  proposalTrust,
  TrustLevel,
  WorkBodyKind,
  type Body,
  type Id,
  type ParkOffer,
  type Proposal,
  type ProposalDecisionBody,
  type ProposedBody,
} from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import type { WorldState } from '../../state/reduce.js';
import { budgetInput, Controls } from '../../console/hierarchy/WorkTree.js';
import { ErrorLine, StatePill, useAction, useApi } from '../../console/hierarchy/shared.js';
import { OfflineDecisionNote, useStreamDown } from './QueuedAnswer.js';
import { AgentRef } from './links.js';

/**
 * Proposal cards (P2-18, extracted for the panel in P25-06; SPEC §3.3): the one card a work
 * request produces — approve, edit its size, body and workspace, give the `git init` consent
 * (decision 27) or choose the project's trust level (decision 49), reject with a reason; a parked
 * card shows the occupied bodies and the offers (decisions 16, 38) — and a Waykeeper's plan card,
 * approved or rejected as a whole and edited through its tasks (decision 35). An approved card is
 * read-only, with its outcome. The cards read the store only, so a decision taken anywhere shows
 * everywhere once the stream brings it.
 */

/** What each trust level lets the project's Stewards do without a card (decision 49). */
export const TRUST_HINTS: Record<TrustLevel, string> = {
  default: 'asks before deleting, leaving the workspace, the network and pushing',
  trusting: 'also installs and uses the network on its own',
  cautious: 'asks for every change',
  trusted: 'everything without a card except a push',
};

/** The states in which a card still waits for the user (or, parked, for a free body). */
export const OPEN_PROPOSAL_STATES: ReadonlySet<Proposal['state']> = new Set([
  'pending',
  'edited',
  'parked',
]);

const OFFERS: Record<ParkOffer, string> = {
  downsize_moon: 'make it a moon project',
  downsize_asteroid: 'make it standalone work on an asteroid',
  close_early: 'close a completed project early to free its body',
  task_on_planet: 'keep it a task on its planet',
};

/** " · carried out" / " · failed: …" from an approved card's `meta.carriedOut`. */
export function carriedOutLine(p: Proposal): string {
  const outcome = p.meta?.['carriedOut'] as { ok?: boolean; error?: string } | undefined;
  if (!outcome) return '';
  return outcome.ok ? ' · carried out' : ` · failed: ${outcome.error ?? 'unknown'}`;
}

/**
 * A proposal's card, whichever kind it is: a plan card (`meta.plan`), a work card, or — once
 * approved — a read-only line with its outcome.
 */
export function ProposalCard({ proposal }: { proposal: Proposal }) {
  if (proposal.state === 'approved') return <ApprovedCard proposal={proposal} />;
  return proposalPlan(proposal) ? (
    <PlanCard proposal={proposal} />
  ) : (
    <WorkCard proposal={proposal} />
  );
}

/** A proposal by id, as the store has it now (for a chat thread, P25-03). */
export function ProposalView({ proposalId }: { proposalId: Id }) {
  const p = useAppStore((s) => s.world.proposals[proposalId]);
  return p ? <ProposalCard proposal={p} /> : null;
}

function ApprovedCard({ proposal: p }: { proposal: Proposal }) {
  const world = useAppStore((s) => s.world);
  const plan = proposalPlan(p);
  return (
    <article
      className={`card ${plan ? 'plan' : 'proposal'} proposal-approved`}
      aria-label={`${plan ? 'plan' : 'proposal'} ${p.requestText}`}
    >
      <header>
        <StatePill state={p.state} />
        <strong>
          {plan
            ? `Plan for ${world.projects[plan.projectId]?.name ?? plan.projectId}`
            : p.requestText}
        </strong>
        <span className="muted">
          {plan ? `${plan.taskIds.length} tasks` : `${p.kind} · ${p.proposedBody.name}`}
          {carriedOutLine(p)}
        </span>
      </header>
    </article>
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

export function WorkCard({ proposal: p }: { proposal: Proposal }) {
  const api = useApi();
  const world = useAppStore((s) => s.world);
  const { run, error, busy: running } = useAction();
  // Card decisions are not queued offline (P7-05): they wait for the connection.
  const offline = useStreamDown();
  const busy = running || offline;
  const [editing, setEditing] = useState(false);
  const decide = (d: ProposalDecisionBody) => run(() => api.decide(p.id, d));
  const parking = proposalParking(p);
  const promotion = proposalPromotion(p);
  const body = p.proposedBody.bodyId ? world.bodies[p.proposedBody.bodyId] : undefined;
  const initGit = p.meta?.['initGit'] === true;
  const trust = proposalTrust(p);
  const budget = proposalBudget(p);
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
            <dd role="definition" aria-label="trust level">
              {trust} <span className="muted">— {TRUST_HINTS[trust]}</span>
            </dd>
          </div>
        )}
        <div>
          <dt>budget</dt>
          <dd role="definition" aria-label="budget">
            {budget !== undefined ? formatUsd(budget) : 'none'}
          </dd>
        </div>
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
      {offline && <OfflineDecisionNote />}
      <div className="controls">
        {p.state !== 'rejected' && (
          <button disabled={busy} onClick={() => decide({ decision: 'approve' })}>
            Approve
          </button>
        )}
        <button
          disabled={busy}
          className="secondary"
          aria-expanded={editing}
          onClick={() => setEditing((e) => !e)}
        >
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
        <div className="controls" role="group" aria-label="offers">
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

/**
 * The free bodies of a kind the card may name: not reserved, not hosting, no "moved" marker, and
 * catalogued — the server's own rule (`isCatalogued`): never a demo, retired or orbit-less planet,
 * which the server would not use.
 */
export function freeBodies(world: Pick<WorldState, 'bodies'>, kind: Proposal['kind']): Body[] {
  if (kind === 'asteroid') return [];
  return Object.values(world.bodies)
    .filter(
      (b) =>
        b.kind === kind &&
        !b.host &&
        !b.movedTo &&
        b.meta?.['reserved'] !== true &&
        isCatalogued(b),
    )
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
  const [budget, setBudget] = useState(() => {
    const b = proposalBudget(p);
    return b !== undefined ? String(b) : '';
  });
  const choices = freeBodies(world, kind);
  // P5-04: opening the form puts the keyboard on its first field.
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => form.current?.querySelector<HTMLElement>('select, input')?.focus(), []);
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
      ...budgetChange(budget, proposalBudget(p)),
    });
  };
  return (
    <form className="edit" onSubmit={submit} aria-label="edit card" ref={form}>
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
      <BudgetField value={budget} onChange={setBudget} />
      <button type="submit" disabled={busy}>
        Save
      </button>
    </form>
  );
}

/** A card's budget change (P8-01): `{budgetUsd}` when the field says something new, else nothing. */
function budgetChange(text: string, current: number | undefined): { budgetUsd?: number | null } {
  const usd = budgetInput(text);
  if (usd === undefined) return {};
  if (usd === null) return current !== undefined ? { budgetUsd: null } : {};
  return usd !== current ? { budgetUsd: usd } : {};
}

function BudgetField({
  value,
  onChange,
  label = 'budget ($)',
}: {
  value: string;
  onChange: (v: string) => void;
  label?: string;
}) {
  return (
    <label>
      {label}
      <input
        type="number"
        inputMode="decimal"
        min="0.01"
        step="0.01"
        placeholder="none"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/**
 * A plan card's budget (P8-01): the project's budget, given with the plan and set on approval.
 * The project's budget now is shown beside it.
 */
function PlanBudget({
  proposal: p,
  current,
  busy,
  decide,
}: {
  proposal: Proposal;
  current: number | undefined;
  busy: boolean;
  decide: (d: ProposalDecisionBody) => Promise<boolean>;
}) {
  const onCard = proposalBudget(p);
  const [value, setValue] = useState(onCard !== undefined ? String(onCard) : '');
  const change = budgetChange(value, onCard);
  return (
    <form
      className="edit"
      aria-label="plan budget"
      onSubmit={(e) => {
        e.preventDefault();
        if ('budgetUsd' in change) void decide({ decision: 'edit', changes: change });
      }}
    >
      <BudgetField value={value} onChange={setValue} label="project budget ($)" />
      <span className="muted">
        {onCard !== undefined ? `set on approval: ${formatUsd(onCard)}` : 'none on the card'}
        {' · now '}
        {current !== undefined ? formatUsd(current) : 'none'}
      </span>
      <button type="submit" className="secondary" disabled={busy || !('budgetUsd' in change)}>
        Set budget
      </button>
    </form>
  );
}

export function PlanCard({ proposal: p }: { proposal: Proposal }) {
  const api = useApi();
  const world = useAppStore((s) => s.world);
  const { run, error, busy: running } = useAction();
  const offline = useStreamDown();
  const busy = running || offline;
  const plan = proposalPlan(p)!;
  const project = world.projects[plan.projectId];
  const decide = (d: ProposalDecisionBody) => run(() => api.decide(p.id, d));
  return (
    <article className={`card plan proposal-${p.state}`} aria-label={`plan ${p.requestText}`}>
      <header>
        <StatePill state={p.state} />
        <strong>Plan for {project?.name ?? plan.projectId}</strong>
        <span className="muted">
          by <AgentRef agentId={plan.waykeeperId} />
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
      {(p.state === 'pending' || p.state === 'edited') && (
        <PlanBudget proposal={p} current={project?.budgetUsd} busy={busy} decide={decide} />
      )}
      {offline && <OfflineDecisionNote />}
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
