import { useEffect, useState } from 'react';
import { openQuestionsLabel, questionItems } from './question-count.js';
import { wallClockLimit, type Agent } from '@galactic/protocol';
import { useAppStore } from '../state/store.js';
import { HARMONIZER } from '../state/selection.js';
import { agentLabel, StatePill } from '../console/hierarchy/shared.js';
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
} from './agent-cards-model.js';
import { ActionRow, ControlFeedback, useControls } from './controls.js';
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

function AgentCard({ card, now }: { card: AgentCardModel; now: number }) {
  const world = useAppStore((s) => s.world);
  const { agent, status, work, blocked, openQuestions } = card;
  const controls = useControls(agent?.id, work);
  const { busy } = controls;
  // A work-only card (no agent runs the work yet) is named after its work.
  const name = agent ? agentLabel(agent, world) : work ? workTitle(work) : '—';
  const workName = work
    ? work.kind === 'task'
      ? work.item.description
      : work.item.name
    : undefined;

  const to = agent
    ? agent.role === 'harmonizer'
      ? HARMONIZER
      : { kind: agent.role, id: agent.id }
    : undefined;
  const wall = status ? wallClockUsed(status, now) : undefined;
  const wallLimit = status ? wallClockLimit(status.caps.wallClockMs) : undefined;
  // A question set counts once (P8-22).
  const questions = openQuestionsLabel(questionItems(openQuestions));

  return (
    <article className={`agc${blocked ? ' is-blocked' : ''}`} aria-label={`card of ${name}`}>
      <header className="agc-head">
        <StatePill state={status?.state} />
        {blocked && <Beacon>blocked on you</Beacon>}
        {questions && <span className="agc-qbadge">{questions}</span>}
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
              <dd role="definition" aria-label="cost so far">
                {formatCost(status)}
              </dd>
            </div>
            <div>
              <dt>wall clock</dt>
              <dd role="definition" aria-label="wall clock">
                {wall === undefined ? (
                  '—'
                ) : wallLimit === undefined ? (
                  // A Waykeeper: no wall-clock cap (SPEC decision 103), only its time.
                  formatDuration(wall)
                ) : (
                  <Usage
                    used={wall}
                    limit={wallLimit}
                    text={`${formatDuration(wall)} / ${formatDuration(wallLimit)}`}
                  />
                )}
              </dd>
            </div>
            <div>
              <dt>tool calls</dt>
              <dd role="definition" aria-label="tool calls">
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
          onClick={(a) => controls.click('agent', a)}
          extra={
            status?.state === 'interrupted' ? (
              <button type="button" disabled={busy} onClick={controls.recover}>
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
          onClick={(a) => controls.click('work', a)}
        />
      )}
      <ControlFeedback controls={controls} work={work} />
    </article>
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
