import type { Id } from '@galactic/protocol';
import { sceneWorld, useAppStore } from '../../state/store.js';
import { revealQuestion } from '../../panel/inbox-reveal.js';
import { useCameraStore } from '../camera/store.js';
import { usePickingStore, selectFromScene } from '../picking/store.js';
import { satelliteSelection } from '../picking/satellite-card.js';
import { beaconHq, questionBody, waitsForUser } from './beacon-model.js';

/**
 * Clicking a beacon (P4-05, P4-13: Cosmin's answer — a click goes to the asker): one question's
 * beacon
 * - **selects the asking agent** — `waykeeper:<id>`, `steward:<id>`, or the Harmonizer for its own
 *   questions (decision 53; the same mapping as clicking its satellite, `satelliteSelection`), so the
 *   panel shows that agent's conversation or view;
 * - **flies the camera to the beacon's body** (the asker's body: its task's or project's body, Earth
 *   for the Harmonizer) — the scene made the selection, so the panel → scene sync does not fly a
 *   second time (`selectFromScene`);
 * - **opens the question in the inbox** — the card scrolled into view, focused and briefly
 *   highlighted (`revealQuestion`, which also brings a hidden inbox back).
 * An open popover closes. When the asker is not loaded (the question placed by its recorded
 * origin), the selection stays and the camera still flies; when the route is elsewhere, the panel's
 * main view comes back. Returns the question opened, `undefined` when it waits no more (answered
 * meanwhile): then nothing else happens.
 */
export function activateBeacon(questionId: Id): Id | undefined {
  const store = useAppStore.getState();
  usePickingStore.getState().closePopover();
  const q = sceneWorld(store).questions[questionId];
  if (!q || !waitsForUser(q)) return undefined;
  const bodyId = questionBody({ ...sceneWorld(store), hqBodyId: beaconHq(sceneWorld(store)) }, q);
  if (bodyId) useCameraStore.getState().flyTo(bodyId);
  const selection = satelliteSelection(sceneWorld(store), q.originAgentId);
  if (selection) selectFromScene(selection);
  else if (store.route !== 'panel') store.navigate({ route: 'panel', selection: store.selection });
  revealQuestion(questionId);
  return questionId;
}
