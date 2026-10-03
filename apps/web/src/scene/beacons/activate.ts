import type { Id } from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import { revealQuestion } from '../../panel/inbox-reveal.js';
import { usePickingStore } from '../picking/store.js';
import { beaconFor, beaconHq } from './beacon-model.js';

/**
 * Clicking a beacon (P4-05): opens its first question (the inbox's order: permissions first,
 * oldest first) in the inbox — the card scrolled into view, focused and briefly highlighted
 * (`revealQuestion`). It changes nothing else: no selection, no camera flight (the question's
 * agent is one "open agent" click away on the card). An open popover closes. The panel's main
 * view is the only place the scene shows (decision 62), so no navigation is needed; if the route
 * is elsewhere anyway, the panel's main view comes back first, keeping the selection.
 * Returns the question opened, `undefined` when the body has no beacon (any more).
 */
export function activateBeacon(bodyId: Id): Id | undefined {
  const store = useAppStore.getState();
  const world = { ...store.world, hqBodyId: beaconHq(store.world) };
  const questionId = beaconFor(world, bodyId)?.questionIds[0];
  usePickingStore.getState().closePopover();
  if (!questionId) return undefined;
  if (store.route !== 'panel') store.navigate({ route: 'panel', selection: store.selection });
  revealQuestion(questionId);
  return questionId;
}
