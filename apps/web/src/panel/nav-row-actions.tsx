import type { KeyboardEvent } from 'react';
import type { Id, Project, WorkState } from '@galactic/protocol';
import { useAppStore } from '../state/store.js';
import type { WorldState } from '../state/reduce.js';
import { workActions, type CardWork } from './agent-cards-model.js';
import { ActionRow, ControlFeedback, useControls } from './controls.js';
import { useApi } from '../console/hierarchy/shared.js';
import { startReplay } from '../replay/store.js';

/**
 * A navigation row's work actions (P4-12): what the controls strip offers for the task or project
 * (decision 11b, `workActions`) — close, cancel, archive, stop, pin, reopen… — with the same
 * confirmations and the server's refusal shown under them (`useControls`, `POST /api/control`),
 * so leftover work can be cleared from the navigation. Edit stays in the strip and the cards.
 * The row stays open after an action: a cancelled project then offers "Archive now".
 */
export function NavRowActions({
  groupId,
  kind,
  id,
  label,
  onDone,
}: {
  /** The group's element id, for the "⋯" button's `aria-controls`. */
  groupId?: string;
  kind: 'project' | 'task';
  id: Id;
  label: string;
  /** Closes the actions (Escape); focus goes back to the row's "⋯". */
  onDone: () => void;
}) {
  const world = useAppStore((s) => s.world);
  const item = kind === 'project' ? world.projects[id] : world.tasks[id];
  const work = item ? ({ kind, item } as CardWork) : undefined;
  const c = useControls(undefined, work);
  const api = useApi();
  if (!work) return null;
  const actions = workActions(work).filter((a) => a.action !== 'edit');
  const note = work.kind === 'project' ? openTasksNote(world, work.item) : undefined;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape') return;
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
      <ActionRow
        label={`${kind} controls`}
        title={kind}
        actions={actions}
        busy={c.busy}
        onClick={(a) => c.click('work', a)}
      />
      {note && <p className="pnl-row-note">{note}</p>}
      <ControlFeedback controls={c} work={work} />
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
