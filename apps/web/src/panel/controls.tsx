import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
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
  /** What had the focus when the confirmation opened: it gets the focus back (P5-04). */
  opener: RefObject<HTMLElement | null>;
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
  const opener = useRef<HTMLElement | null>(null);

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
    click: (scope, a) => {
      if (!a.confirm) return perform(scope, a);
      opener.current = document.activeElement as HTMLElement | null;
      setPending({ scope, action: a });
    },
    recover: () => {
      setPending(undefined);
      if (agentId) void run(() => api.recover(agentId));
    },
    pending,
    opener,
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
        <ConfirmBox
          key={`${c.pending.scope}:${c.pending.action.action}`}
          question={c.pending.action.confirm ?? ''}
          yes={`Yes, ${c.pending.action.label.toLowerCase()}`}
          busy={c.busy}
          opener={c.opener}
          onConfirm={c.confirm}
          onKeep={c.keep}
        />
      )}
      {c.editing && work && (
        <EditForm target={{ kind: work.kind }} item={work.item} busy={c.busy} onSave={c.saveEdit} />
      )}
      <ErrorLine error={c.error} />
    </>
  );
}

/**
 * An inline confirmation (decision 56): the question, the destructive answer and "Keep".
 * P5-04: it takes the focus (on "Keep", the safe answer, decision 81), Escape keeps, and when it
 * closes it gives the focus back to what opened it — or, gone (an action in the closed "More"
 * menu), to "More" or the first button near the confirmation — unless the user has put the focus
 * elsewhere.
 */
export function ConfirmBox({
  question,
  yes,
  busy,
  opener,
  onConfirm,
  onKeep,
}: {
  question: string;
  yes: string;
  busy: boolean;
  opener: RefObject<HTMLElement | null>;
  onConfirm: () => void;
  onKeep: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    const around = el?.parentElement;
    const from = opener.current;
    el?.querySelector<HTMLButtonElement>('button.secondary')?.focus();
    return () => {
      const active = document.activeElement;
      if (active && active !== document.body && active.isConnected) return;
      const usable = (b: HTMLElement | null | undefined) =>
        b?.isConnected && !(b as HTMLButtonElement).disabled ? b : undefined;
      const to =
        usable(from) ??
        usable(around?.querySelector<HTMLElement>('.ctl-more')) ??
        usable(around?.querySelector<HTMLElement>('button:not([disabled])'));
      to?.focus();
    };
  }, [opener]);
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    onKeep();
  };
  return (
    <div className="agc-confirm" role="group" aria-label="confirm" ref={box} onKeyDown={onKeyDown}>
      <span>{question}</span>
      <button type="button" className="danger" disabled={busy} onClick={onConfirm}>
        {yes}
      </button>
      <button type="button" className="secondary" onClick={onKeep}>
        Keep
      </button>
    </div>
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
  const menuId = useId();
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
            aria-controls={open ? menuId : undefined}
            onClick={() => setOpen((o) => !o)}
          >
            More
          </button>
        )}
        {open && (
          <div
            id={menuId}
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

/** What "Restart Harmonizer" asks before it acts (decision 82). */
export const RESTART_HARMONIZER_CONFIRM =
  'Restart the Harmonizer? It is stopped and a fresh one starts, seeded from the database; ' +
  'the questions it asked you are withdrawn and it asks again what still matters.';

/**
 * The Harmonizer's own controls in its dock bar (P5-06; SPEC decision 82): Pause or Resume like
 * any agent's (`POST /api/control` on the agent), "Resume session" only while it is interrupted,
 * and "Restart Harmonizer" behind a confirmation (`POST /api/harmonizer/restart`). Never a plain
 * Stop: the user is never left without a Harmonizer (decision 44 does not replace one the user
 * stopped). The selection stays on the Harmonizer, which is the newest one (`currentHarmonizer`).
 */
/**
 * Focus across a restart (wave-3 review): "Yes, restart" moves focus to the dock bar's heading
 * while the restart runs (the Restart button is disabled meanwhile), and the controls of the new
 * Harmonizer — a remount, keyed by its id — take it back on their Restart button. The dock bar
 * keeps this between the two mounts; a mount long after the restart leaves focus alone.
 */
export interface RestartFocus {
  /** The Harmonizer that was restarted. */
  from: Id;
  since: number;
}
const RESTART_FOCUS_MS = 30_000;

export function HarmonizerControls({
  agentId,
  status,
  name,
  restartFocus,
}: {
  agentId: Id;
  status: StatusRecord | undefined;
  name: string;
  restartFocus?: RefObject<RestartFocus | undefined>;
}) {
  const c = useControls(agentId, undefined);
  const api = useApi();
  const restart = useAction();
  const [confirming, setConfirming] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const restartButton = useRef<HTMLButtonElement>(null);
  const [refocus, setRefocus] = useState(false);
  useEffect(() => {
    // Mounted for the new Harmonizer after "Yes, restart": focus comes back to Restart.
    const pending = restartFocus?.current;
    if (!pending || pending.from === agentId || !restartFocus) return;
    restartFocus.current = undefined;
    if (Date.now() - pending.since < RESTART_FOCUS_MS) restartButton.current?.focus();
  }, [agentId, restartFocus]);
  useEffect(() => {
    // A restart that failed: the same controls, the Restart button enabled again.
    if (!refocus || restart.busy) return;
    setRefocus(false);
    restartButton.current?.focus();
  }, [refocus, restart.busy]);
  const actions = agentActions(status).filter((a) => INLINE.has(a.action));
  const recoverable = status?.state === 'interrupted';
  const busy = c.busy || restart.busy;
  return (
    <div className="ctl">
      <div className="ctl-row" role="group" aria-label={`controls of ${name}`}>
        {actions.length > 0 && (
          <span className="ctl-group">
            <span className="agc-actions-title" aria-hidden="true">
              agent
            </span>
            {actions.map((a) => (
              <ActionButton
                key={a.action}
                action={a}
                busy={busy}
                onClick={(x) => {
                  setConfirming(false);
                  c.click('agent', x);
                }}
                ariaLabel={`${a.label} the Harmonizer`}
              />
            ))}
          </span>
        )}
        {recoverable && (
          <button type="button" className="secondary" disabled={busy} onClick={c.recover}>
            Resume session
          </button>
        )}
        <button
          type="button"
          className="agc-destructive"
          ref={restartButton}
          disabled={busy}
          onClick={(e) => {
            opener.current = e.currentTarget;
            setConfirming(true);
          }}
        >
          Restart Harmonizer
        </button>
      </div>
      {confirming && (
        <ConfirmBox
          question={RESTART_HARMONIZER_CONFIRM}
          yes="Yes, restart"
          busy={busy}
          opener={opener}
          onConfirm={() => {
            setConfirming(false);
            if (restartFocus) restartFocus.current = { from: agentId, since: Date.now() };
            opener.current
              ?.closest('.pnl-dock-bar')
              ?.querySelector<HTMLElement>('.pnl-title')
              ?.focus();
            void restart
              .run(() => api.restartHarmonizer())
              .then((ok) => {
                if (ok) return; // the new Harmonizer's controls take focus when they mount
                if (restartFocus) restartFocus.current = undefined;
                setRefocus(true);
              });
          }}
          onKeep={() => setConfirming(false)}
        />
      )}
      <ControlFeedback controls={c} work={undefined} />
      <ErrorLine error={restart.error} />
    </div>
  );
}
