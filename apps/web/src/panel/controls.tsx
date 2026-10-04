import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ControlBody, Id, StatusRecord } from '@galactic/protocol';
import { EditForm } from '../console/hierarchy/WorkTree.js';
import { ErrorLine, useAction, useApi } from '../console/hierarchy/shared.js';
import { agentActions, workActions, type CardAction, type CardWork } from './agent-cards-model.js';
import './agent-cards.css';

/**
 * The control actions of decision 11b as UI, shared by the managed-agents cards (P25-04) and the
 * main area's controls strip (P4-09): one hook that sends them through `POST /api/control`, asks
 * inline before the destructive ones (decision 56), toggles the edit form and keeps the refusal to
 * show; and the pieces that render them (the action row, the confirmation, the edit form).
 */

/** Which target an action goes to: the agent itself, or the task or project it runs. */
export type ControlScope = 'agent' | 'work';

export interface Controls {
  busy: boolean;
  /** The last refusal (or failure), shown by `ControlFeedback`. */
  error: string | undefined;
  /** A click on an action: destructive ones ask first, the others go straight out. */
  click: (scope: ControlScope, a: CardAction) => void;
  /** Recovers an interrupted agent's session ("Resume session"). */
  recover: () => void;
  pending: { scope: ControlScope; action: CardAction } | undefined;
  confirm: () => void;
  keep: () => void;
  editing: boolean;
  saveEdit: (changes: Extract<ControlBody['action'], { action: 'edit' }>['changes']) => void;
}

export function useControls(agentId: Id | undefined, work: CardWork | undefined): Controls {
  const api = useApi();
  const { run, error, busy } = useAction();
  const [pending, setPending] = useState<Controls['pending']>();
  const [editing, setEditing] = useState(false);

  const send = (scope: ControlScope, body: ControlBody['action']) =>
    run(() =>
      api.control({
        target:
          scope === 'work' && work
            ? { kind: work.kind, id: work.item.id }
            : { kind: 'agent', id: agentId! },
        action: body,
      }),
    );
  const perform = (scope: ControlScope, a: CardAction) => {
    setPending(undefined);
    if (a.action === 'edit') return setEditing((e) => !e);
    if (a.action === 'pin') return void send(scope, { action: 'pin', pinned: !work?.item.pinned });
    void send(scope, { action: a.action } as ControlBody['action']);
  };
  return {
    busy,
    error,
    click: (scope, a) => (a.confirm ? setPending({ scope, action: a }) : perform(scope, a)),
    recover: () => {
      setPending(undefined);
      if (agentId) void run(() => api.recover(agentId));
    },
    pending,
    confirm: () => pending && perform(pending.scope, pending.action),
    keep: () => setPending(undefined),
    editing,
    saveEdit: (changes) =>
      void send('work', { action: 'edit', changes }).then((ok) => ok && setEditing(false)),
  };
}

/** The pending confirmation, the edit form and the refusal, under the buttons. */
export function ControlFeedback({
  controls: c,
  work,
}: {
  controls: Controls;
  work: CardWork | undefined;
}) {
  return (
    <>
      {c.pending && (
        <div className="agc-confirm" role="group" aria-label="confirm">
          <span>{c.pending.action.confirm}</span>
          <button type="button" className="danger" disabled={c.busy} onClick={c.confirm}>
            Yes, {c.pending.action.label.toLowerCase()}
          </button>
          <button type="button" className="secondary" onClick={c.keep}>
            Keep
          </button>
        </div>
      )}
      {c.editing && work && (
        <EditForm target={{ kind: work.kind }} item={work.item} busy={c.busy} onSave={c.saveEdit} />
      )}
      <ErrorLine error={c.error} />
    </>
  );
}

export function ActionButton({
  action: a,
  busy,
  onClick,
  ariaLabel,
}: {
  action: CardAction;
  busy: boolean;
  onClick: (a: CardAction) => void;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      disabled={busy}
      className={a.confirm ? 'agc-destructive' : 'secondary'}
      aria-label={ariaLabel}
      onClick={() => onClick(a)}
    >
      {a.label}
    </button>
  );
}

/** One titled row of actions ("agent", "task", "project"), as on a card. */
export function ActionRow({
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
        <ActionButton key={a.action} action={a} busy={busy} onClick={onClick} />
      ))}
      {extra}
    </div>
  );
}

/** Room kept between the menu and the viewport's edges (px). */
const MENU_MARGIN = 8;

/**
 * Places the open "More" menu (P4-10): below its row unless there is not enough room below and
 * more room above (a dock bar low on the screen: minimised at the bottom, or the stacked layout),
 * then upwards; capped to the room on that side, and shifted sideways to stay on screen. Written
 * on the element (`data-placement`, inline styles), which React does not manage.
 */
export function placeMenu(menu: HTMLElement, anchor: HTMLElement): 'above' | 'below' {
  menu.style.maxHeight = '';
  menu.style.right = '';
  const row = anchor.getBoundingClientRect();
  const height = menu.getBoundingClientRect().height;
  const below = window.innerHeight - row.bottom - MENU_MARGIN;
  const above = row.top - MENU_MARGIN;
  const placement = below < height && above > below ? 'above' : 'below';
  menu.dataset['placement'] = placement;
  menu.style.maxHeight = `${Math.max(0, Math.floor(placement === 'above' ? above : below))}px`;
  const box = menu.getBoundingClientRect();
  const width = window.innerWidth || document.documentElement.clientWidth;
  if (box.left < MENU_MARGIN) menu.style.right = `${box.left - MENU_MARGIN}px`;
  else if (box.right > width - MENU_MARGIN)
    menu.style.right = `${box.right - (width - MENU_MARGIN)}px`;
  return placement;
}

/** Pause and resume stay in the strip; everything else goes into its "More" menu. */
const INLINE: ReadonlySet<CardAction['action']> = new Set(['pause', 'resume']);

/**
 * The main area's controls strip (P4-09): the selected agent's own controls, reachable whether or
 * not the managed-agents cards are shown. In a Waykeeper's conversation, its project's work
 * actions and the Waykeeper's agent actions; in a Steward's view, its task's work actions only
 * (the view has the agent's controls already). Compact: pause / resume inline, the rest in a
 * "More" menu; same confirmations and refusal display as the cards.
 */
export function ControlsStrip({
  agentId,
  status,
  work,
  withAgent,
  name,
}: {
  agentId: Id;
  status: StatusRecord | undefined;
  work: CardWork | undefined;
  /** Whether the strip carries the agent's own actions too (not in the Steward view). */
  withAgent: boolean;
  /** The agent's name, for the accessible labels. */
  name: string;
}) {
  const c = useControls(agentId, work);
  const [open, setOpen] = useState(false);
  const stripRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Opens where it fits (see `placeMenu`), before it is painted.
  useLayoutEffect(() => {
    if (open && menuRef.current && rowRef.current) placeMenu(menuRef.current, rowRef.current);
  }, [open]);

  // A click or tap outside closes the menu; Escape closes it and returns focus to "More".
  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      if (!stripRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      stripRef.current?.querySelector<HTMLButtonElement>('.ctl-more')?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const groups: { scope: ControlScope; title: string; actions: CardAction[] }[] = [];
  if (work) groups.push({ scope: 'work', title: work.kind, actions: workActions(work) });
  if (withAgent) groups.push({ scope: 'agent', title: 'agent', actions: agentActions(status) });
  const recoverable = withAgent && status?.state === 'interrupted';
  const overflow = groups
    .map((g) => ({ ...g, actions: g.actions.filter((a) => !INLINE.has(a.action)) }))
    .filter((g) => g.actions.length > 0);
  if (groups.every((g) => g.actions.length === 0) && !recoverable) return null;

  const pick = (scope: ControlScope, a: CardAction) => {
    setOpen(false);
    c.click(scope, a);
  };
  return (
    <div className="ctl" ref={stripRef}>
      <div className="ctl-row" role="group" aria-label={`controls of ${name}`} ref={rowRef}>
        {groups.map((g) => {
          const inline = g.actions.filter((a) => INLINE.has(a.action));
          if (inline.length === 0) return null;
          return (
            <span key={g.scope} className="ctl-group">
              <span className="agc-actions-title" aria-hidden="true">
                {g.title}
              </span>
              {inline.map((a) => (
                <ActionButton
                  key={a.action}
                  action={a}
                  busy={c.busy}
                  onClick={(x) => pick(g.scope, x)}
                  ariaLabel={`${a.label} the ${g.title}`}
                />
              ))}
            </span>
          );
        })}
        {recoverable && (
          <button type="button" className="secondary" disabled={c.busy} onClick={c.recover}>
            Resume session
          </button>
        )}
        {overflow.length > 0 && (
          <button
            type="button"
            className="secondary ctl-more"
            aria-expanded={open}
            aria-haspopup="true"
            onClick={() => setOpen((o) => !o)}
          >
            More
          </button>
        )}
        {open && (
          <div
            className="ctl-menu"
            role="group"
            aria-label="more controls"
            ref={menuRef}
            data-escape-layer=""
          >
            {overflow.map((g) => (
              <ActionRow
                key={g.scope}
                label={`${g.title} controls`}
                title={g.title}
                actions={g.actions}
                busy={c.busy}
                onClick={(a) => pick(g.scope, a)}
              />
            ))}
          </div>
        )}
      </div>
      <ControlFeedback controls={c} work={work} />
    </div>
  );
}
