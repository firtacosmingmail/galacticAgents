import { useId, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  taskTitle,
  WORK_NAME_MAX,
  type Id,
  type Project,
  type Task,
  type WorkState,
} from '@galactic/protocol';
import { useAppStore } from '../state/store.js';
import type { WorldState } from '../state/reduce.js';
import { workActions, type CardWork } from './agent-cards-model.js';
import { ActionRow, ControlFeedback, useControls } from './controls.js';
import { ErrorLine, useAction, useApi } from '../console/hierarchy/shared.js';
import { startReplay } from '../replay/store.js';
import type { Selection } from '../state/selection.js';
import { useDockView } from './status/dock-view.js';
import { requestDockOpen } from './dock-state.js';
import { useDeliverablesFocus } from './deliverables/use-deliverables.js';

/**
 * A navigation row's work actions (P4-12): what the controls strip offers for the task or project
 * (decision 11b, `workActions`) — close, cancel, archive, stop, pin, reopen… — with the same
 * confirmations and the server's refusal shown under them (`useControls`, `POST /api/control`),
 * so leftover work can be cleared from the navigation. Edit stays in the strip and the cards;
 * Rename (P8-24) is here. The row stays open after an action: a cancelled project then offers
 * "Archive now".
 */
export function NavRowActions({
  groupId,
  kind,
  id,
  label,
  selection,
  onDone,
}: {
  /** The group's element id, for the "⋯" button's `aria-controls`. */
  groupId?: string;
  kind: 'project' | 'task';
  id: Id;
  label: string;
  /** The row's agent (its Waykeeper or Steward), where its Deliverables show (P9-09). */
  selection?: Selection | undefined;
  /** Closes the actions (Escape); focus goes back to the row's "⋯". */
  onDone: () => void;
}) {
  const world = useAppStore((s) => s.world);
  const item = kind === 'project' ? world.projects[id] : world.tasks[id];
  const work = item ? ({ kind, item } as CardWork) : undefined;
  const c = useControls(undefined, work);
  const api = useApi();
  const navigate = useAppStore((s) => s.navigate);
  const [renaming, setRenaming] = useState(false);
  if (!work) return null;
  // "⋯ Deliverables" (P9-09): the project's Deliverables view in its Waykeeper's dock, or the
  // task's section of its Steward view, brought into sight with the focus on its title.
  const showDeliverables = () => {
    if (!selection) return;
    navigate({ route: 'panel', selection });
    if (kind === 'project') useDockView.getState().setView('deliverables');
    requestDockOpen();
    useDeliverablesFocus.getState().ask(`${kind}:${id}`);
    onDone();
  };
  const actions = workActions(work).filter((a) => a.action !== 'edit');
  const note = work.kind === 'project' ? openTasksNote(world, work.item) : undefined;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    e.preventDefault();
    const more = e.currentTarget
      .closest('li')
      ?.querySelector<HTMLButtonElement>(':scope > .pnl-row-line > .pnl-row-more');
    onDone();
    more?.focus();
  };
  return (
    <div
      id={groupId}
      className="pnl-row-actions"
      role="group"
      aria-label={`actions for ${label}`}
      onKeyDown={onKeyDown}
    >
      {renaming ? (
        <RenameField work={work} onDone={() => setRenaming(false)} />
      ) : (
        <p className="pnl-row-rename">
          <button type="button" className="secondary" onClick={() => setRenaming(true)}>
            Rename
          </button>
        </p>
      )}
      <ActionRow
        label={`${kind} controls`}
        title={kind}
        actions={actions}
        busy={c.busy}
        onClick={(a) => c.click('work', a)}
      />
      {note && <p className="pnl-row-note">{note}</p>}
      <ControlFeedback controls={c} work={work} />
      {selection && (
        <p className="pnl-row-replay">
          <button type="button" className="secondary" onClick={showDeliverables}>
            Deliverables
          </button>
        </p>
      )}
      {work.kind === 'project' && (
        // The timeline scrubber (P4-07): the project's history replayed in the scene.
        <p className="pnl-row-replay">
          <button
            type="button"
            className="secondary"
            onClick={() => startReplay(api, work.item.id, work.item.name)}
          >
            Replay history
          </button>
        </p>
      )}
    </div>
  );
}

/**
 * Renames a project or a task in place (P8-24, decision 150): Enter saves, Escape or "Keep name"
 * keeps it. A project changes its `name`; a task its display title, never its description (the
 * Steward's brief) — so the field starts empty until the task has a title, and saving it empty
 * names the task by its description again.
 */
export function RenameField({
  work,
  onDone,
}: {
  work: { kind: 'project'; item: Project } | { kind: 'task'; item: Task };
  onDone: () => void;
}) {
  const api = useApi();
  const { run, error, busy } = useAction();
  const current = work.kind === 'project' ? work.item.name : (taskTitle(work.item) ?? '');
  const [text, setText] = useState(current);
  const hintId = useId();
  const name = text.trim();
  const unchanged = name === current;
  const empty = work.kind === 'project' && !name;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (unchanged) return onDone();
    if (empty || busy) return;
    const changes = work.kind === 'project' ? { name } : { title: name || null };
    const ok = await run(() =>
      api.control({
        target: { kind: work.kind, id: work.item.id },
        action: { action: 'edit', changes },
      }),
    );
    if (ok) onDone();
  };
  return (
    <form
      className="pnl-row-rename"
      aria-label={`rename ${work.kind}`}
      onSubmit={(e) => void submit(e)}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        // Escape closes the field only, not the row's actions.
        e.preventDefault();
        onDone();
      }}
    >
      <input
        type="text"
        // The field is what the user asked for: it takes the focus as it opens.
        autoFocus
        aria-label={work.kind === 'project' ? 'project name' : 'task title'}
        aria-describedby={work.kind === 'task' ? hintId : undefined}
        maxLength={WORK_NAME_MAX}
        value={text}
        placeholder={work.kind === 'task' ? 'A short name for this task' : undefined}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
      />
      <button type="submit" disabled={busy || empty}>
        Save
      </button>
      <button type="button" className="secondary" onClick={onDone}>
        Keep name
      </button>
      {work.kind === 'task' && (
        <p id={hintId} className="pnl-row-note">
          Only the name shown here changes; the task's description stays as it is. Leave it empty to
          show the description.
        </p>
      )}
      <ErrorLine error={error} />
    </form>
  );
}

/** Unfinished: still running or waiting (the server's `FINISHED_WORK`, plus not yet approved). */
const DONE: ReadonlySet<WorkState> = new Set<WorkState>([
  'completed',
  'archived',
  'failed',
  'moved',
  'proposed',
]);

/**
 * The server archives a project only once all its tasks are finished (`archiveProject`), and
 * closing a project leaves its tasks as they are; cancelling one marks them failed. Says so when
 * a project has unfinished tasks, so the way to clear it is clear before a refusal.
 */
export function openTasksNote(world: Pick<WorldState, 'tasks'>, project: Project) {
  const open = Object.values(world.tasks).filter(
    (t) => t.projectId === project.id && !DONE.has(t.state),
  ).length;
  if (open === 0 || project.state === 'archived') return undefined;
  const tasks = open === 1 ? '1 unfinished task' : `${open} unfinished tasks`;
  if (DONE.has(project.state))
    return `${tasks} keep this project from being archived: cancel or close them first.`;
  return `${tasks}: Cancel marks them failed so the project can then be archived; Close leaves them open.`;
}
