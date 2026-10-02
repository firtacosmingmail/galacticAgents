import { useEffect, useState, type ReactNode } from 'react';
import type { Agent, ControlBody } from '@galactic/protocol';
import { useAppStore } from '../state/store.js';
import { HARMONIZER } from '../state/selection.js';
import { EditForm } from '../console/hierarchy/WorkTree.js';
import {
  agentLabel,
  ErrorLine,
  StatePill,
  useAction,
  useApi,
} from '../console/hierarchy/shared.js';
import { Beacon, NavLink } from './Navigation.js';
import {
  agentActions,
  cardKey,
  formatCost,
  formatDuration,
  managedCards,
  wallClockUsed,
  workActions,
  workTitle,
  type AgentCardModel,
  type CardAction,
} from './agent-cards-model.js';
import './agent-cards.css';

/**
 * The managed-agents cards of the right column (P25-04, SPEC §4.2): one card per agent the
 * selected supervisor manages directly, with its state ("blocked on you" loudest and first), its
 * activity, cost so far, caps usage and open questions, and the control actions of decision 11b
 * on the agent and on the work it runs — all through `POST /api/control`, refusals shown on the
 * card. Destructive actions ask inline first.
 */
export function ManagedAgentCards({ supervisor }: { supervisor: Agent | undefined }) {
  const world = useAppStore((s) => s.world);
  const [showArchived, setShowArchived] = useState(false);
  const cards = managedCards(world, supervisor, { showArchived });
  const ticking = cards.some(
    (c) => c.live && c.status !== undefined && c.status.state !== 'paused',
  );
  const now = useNow(ticking);
  return (
    <div className="agc-list">
      {cards.length === 0 ? (
        <p className="pnl-empty">No agents working under it.</p>
      ) : (
        cards.map((c) => <AgentCard key={cardKey(c)} card={c} now={now} />)
      )}
      <label className="pnl-check agc-archived">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(e) => setShowArchived(e.target.checked)}
        />
        show archived work
      </label>
    </div>
  );
}

/** The current time, re-read every second while something's wall clock runs (cards, Steward view). */
export function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

type Scope = 'agent' | 'work';

function AgentCard({ card, now }: { card: AgentCardModel; now: number }) {
  const api = useApi();
  const world = useAppStore((s) => s.world);
  const { run, error, busy } = useAction();
  const [pending, setPending] = useState<{ scope: Scope; action: CardAction } | undefined>();
  const [editing, setEditing] = useState(false);
  const { agent, status, work, blocked, openQuestions } = card;
  // A work-only card (no agent runs the work yet) is named after its work.
  const name = agent ? agentLabel(agent, world) : work ? workTitle(work) : '—';
  const workName = work
    ? work.kind === 'task'
      ? work.item.description
      : work.item.name
    : undefined;

  const send = (scope: Scope, body: ControlBody['action']) =>
    run(() =>
      api.control({
        target:
          scope === 'work' && work
            ? { kind: work.kind, id: work.item.id }
            : { kind: 'agent', id: agent!.id },
        action: body,
      }),
    );
  const perform = (scope: Scope, a: CardAction) => {
    setPending(undefined);
    if (a.action === 'edit') return setEditing((e) => !e);
    if (a.action === 'pin') return send(scope, { action: 'pin', pinned: !work?.item.pinned });
    return send(scope, { action: a.action } as ControlBody['action']);
  };
  const click = (scope: Scope, a: CardAction) =>
    a.confirm ? setPending({ scope, action: a }) : void perform(scope, a);

  const to = agent
    ? agent.role === 'harmonizer'
      ? HARMONIZER
      : { kind: agent.role, id: agent.id }
    : undefined;
  const wall = status ? wallClockUsed(status, now) : undefined;
  const questions = openQuestions.length;

  return (
    <article className={`agc${blocked ? ' is-blocked' : ''}`} aria-label={`card of ${name}`}>
      <header className="agc-head">
        <StatePill state={status?.state} />
        {blocked && <Beacon>blocked on you</Beacon>}
        {questions > 0 && (
          <span className="agc-qbadge" aria-label="open questions">
            {questions} open question{questions === 1 ? '' : 's'}
          </span>
        )}
        {to ? (
          <NavLink to={{ route: 'panel', selection: to }} className="agc-name">
            <span className="pnl-nav-name">{name}</span>
          </NavLink>
        ) : (
          <span className="agc-name pnl-nav-name">{name}</span>
        )}
      </header>
      <p className="agc-activity" title={status?.currentActivity}>
        {agent
          ? (status?.currentActivity ?? (card.live ? 'no activity yet' : 'not running'))
          : work?.item.state === 'approved'
            ? 'queued: no agent yet'
            : 'no agent'}
      </p>
      <dl className="agc-facts">
        {work && (
          <div className="agc-wide">
            <dt>{work.kind}</dt>
            <dd>
              <StatePill state={work.item.state} />{' '}
              {work.kind === 'task' && work.item.priority !== 'normal' && (
                <span className="muted">{work.item.priority} · </span>
              )}
              {work.item.pinned && <span className="muted">pinned · </span>}
              <span className="agc-work-name">{workName}</span>
            </dd>
          </div>
        )}
        {agent && (
          <>
            <div>
              <dt>cost</dt>
              <dd aria-label="cost so far">{formatCost(status)}</dd>
            </div>
            <div>
              <dt>wall clock</dt>
              <dd aria-label="wall clock">
                {status && wall !== undefined ? (
                  <Usage
                    used={wall}
                    limit={status.caps.wallClockMs.limit}
                    text={`${formatDuration(wall)} / ${formatDuration(status.caps.wallClockMs.limit)}`}
                  />
                ) : (
                  '—'
                )}
              </dd>
            </div>
            <div>
              <dt>tool calls</dt>
              <dd aria-label="tool calls">
                {status ? (
                  <Usage
                    used={status.caps.toolCalls.used}
                    limit={status.caps.toolCalls.limit}
                    text={`${status.caps.toolCalls.used} / ${status.caps.toolCalls.limit}`}
                  />
                ) : (
                  '—'
                )}
              </dd>
            </div>
          </>
        )}
      </dl>

      {agent && (
        <ActionRow
          label={`agent controls of ${name}`}
          title="agent"
          actions={agentActions(status)}
          busy={busy}
          onClick={(a) => click('agent', a)}
          extra={
            status?.state === 'interrupted' ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setPending(undefined);
                  void run(() => api.recover(agent.id));
                }}
              >
                Resume session
              </button>
            ) : null
          }
        />
      )}
      {work && (
        <ActionRow
          label={`${work.kind} controls of ${workName}`}
          title={work.kind}
          actions={workActions(work)}
          busy={busy}
          onClick={(a) => click('work', a)}
        />
      )}
      {pending && (
        <div className="agc-confirm" role="group" aria-label="confirm">
          <span>{pending.action.confirm}</span>
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => void perform(pending.scope, pending.action)}
          >
            Yes, {pending.action.label.toLowerCase()}
          </button>
          <button type="button" className="secondary" onClick={() => setPending(undefined)}>
            Keep
          </button>
        </div>
      )}
      {editing && work && (
        <EditForm
          target={{ kind: work.kind }}
          item={work.item}
          busy={busy}
          onSave={async (changes) => {
            if (await send('work', { action: 'edit', changes })) setEditing(false);
          }}
        />
      )}
      <ErrorLine error={error} />
    </article>
  );
}

function ActionRow({
  label,
  title,
  actions,
  busy,
  onClick,
  extra,
}: {
  label: string;
  title: string;
  actions: CardAction[];
  busy: boolean;
  onClick: (a: CardAction) => void;
  extra?: ReactNode;
}) {
  if (actions.length === 0 && !extra) return null;
  return (
    <div className="agc-actions" role="group" aria-label={label}>
      <span className="agc-actions-title">{title}</span>
      {actions.map((a) => (
        <button
          key={a.action}
          type="button"
          disabled={busy}
          className={a.confirm ? 'agc-destructive' : 'secondary'}
          onClick={() => onClick(a)}
        >
          {a.label}
        </button>
      ))}
      {extra}
    </div>
  );
}

/** "used / limit" with a thin meter; past 80 % it warns. */
function Usage({ used, limit, text }: { used: number; limit: number; text: string }) {
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
  return (
    <span className={`agc-usage${ratio >= 0.8 ? ' is-high' : ''}`}>
      <span>{text}</span>
      <span className="agc-meter" aria-hidden="true">
        <span style={{ width: `${Math.round(ratio * 100)}%` }} />
      </span>
    </span>
  );
}
