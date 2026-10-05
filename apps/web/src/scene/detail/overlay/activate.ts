import type { Id } from '@galactic/protocol';
import { sceneWorld, useAppStore } from '../../../state/store.js';
import { useCameraStore } from '../../camera/store.js';
import { bodyName } from '../../picking/body-action.js';
import { selectFromScene, usePickingStore, type Point } from '../../picking/store.js';
import { taskInfoDetail, taskSelection } from './overlay-model.js';

/**
 * Clicking a task's marker in the detail view (P6-04): selects what the task's row in the panel's
 * navigation selects — its Steward, the newest live one else the newest (decision 53, the panel's
 * `primaryAgent` rule) — so the panel shows that Steward's view and its task's row lights up. The
 * camera flies to the marker's body: in the body's own view that keeps the detail framing (P6-01);
 * a sub-project moon's task, seen in its planet's view, goes to the moon, as clicking the moon
 * does. A task no Steward has started yet selects nothing: a card says what it is, as for a body.
 * No three.js. Returns whether something was selected.
 */
export function activateTask(taskId: Id, at: Point): boolean {
  const world = sceneWorld(useAppStore.getState());
  const task = world.tasks[taskId];
  if (!task) return false;
  const picking = usePickingStore.getState();
  useCameraStore.getState().flyTo(task.bodyId);
  const selection = taskSelection(world, taskId);
  if (selection) {
    picking.closePopover();
    selectFromScene(selection);
    return true;
  }
  usePickingStore.setState({
    popover: {
      kind: 'info',
      ...at,
      action: {
        kind: 'info',
        bodyId: task.bodyId,
        name: `Task on ${bodyName(world, task.bodyId)}`,
        detail: taskInfoDetail(task),
      },
    },
  });
  return false;
}
