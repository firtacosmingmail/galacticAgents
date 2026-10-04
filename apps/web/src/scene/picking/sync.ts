import { useEffect } from 'react';
import { sceneWorld, useAppStore } from '../../state/store.js';
import { sameSelection, type Selection } from '../../state/selection.js';
import { getAnchor, onAnchorsChanged } from '../anchors.js';
import { useCameraStore } from '../camera/store.js';
import { selectionBody } from './body-action.js';
import { isSceneSelection, usePickingStore } from './store.js';

/**
 * Panel → scene (P3-05): when the selection changes outside the scene (the navigation, a card's
 * "open agent", a notification, back / forward), the camera flies to the selected agent's body.
 * The rules, so the scene never fights the user's camera:
 * - only on a selection *change* the user made: never on a snapshot or an event (the world
 *   changing only retries a flight still waiting for its body);
 * - not for a selection the scene made (it has flown already), not for the Harmonizer (going back
 *   to the default conversation leaves the camera where it is), not when the camera is already
 *   on that body;
 * - on load, only for a deep link (`/waykeeper/<id>`, `/steward/<id>`): the first scene of the
 *   page flies there once the body is drawn; a plain load keeps the overview, and showing the
 *   scene again later does not fly;
 * - a flight waiting for its body (the snapshot or the anchor not there yet) is dropped when the
 *   user moves the camera or selects something else.
 * - a selection that came with a switch back to the panel's main view from a page without the
 *   scene (the settings or history page: a history row's agent link, a notification clicked
 *   there, back / forward onto an agent's URL) flies like a deep link: the scene mounts with it
 *   (P5-01). Changing the selection in list mode and showing the scene later still does not fly,
 *   nor does such a return made while the scene was hidden (the panel drops the deep link when
 *   its main view renders in list mode, `dropDeepLink`);
 * - during a replay (P4-07) the flight goes to the agent's body in the replayed world; an agent
 *   that has no body there yet does not wait for one (the camera would jump mid-playback when it
 *   appears): the flight is dropped (P5-01).
 * A selection change from outside the scene also closes the picking popover.
 */
export interface SyncDeps {
  bodyFor: (selection: Selection) => string | undefined;
  hasAnchor: (bodyId: string) => boolean;
  focusedId: () => string | undefined;
  flyTo: (bodyId: string) => void;
  /** Whether the scene shows a replay (P4-07): a flight then never waits for its body. */
  replaying?: () => boolean;
}

export class SelectionSync {
  private pending: Selection | undefined;
  private readonly deps: SyncDeps;

  constructor(deps: SyncDeps) {
    this.deps = deps;
  }

  /** The scene mounted showing `selection`; `deepLink` is the page's linked selection, if any. */
  start(selection: Selection, deepLink: Selection | undefined): void {
    this.pending =
      deepLink && deepLink.kind !== 'harmonizer' && sameSelection(selection, deepLink)
        ? selection
        : undefined;
    this.retry();
  }

  selectionChanged(selection: Selection, fromScene: boolean): void {
    this.pending = fromScene || selection.kind === 'harmonizer' ? undefined : selection;
    this.retry();
    // A replay's world is the past: an agent not in it yet has no body to wait for.
    if (this.pending && this.deps.replaying?.() && !this.deps.bodyFor(this.pending)) {
      this.pending = undefined;
    }
  }

  /** The world or the anchors changed: a waiting flight may go now. */
  retry(): void {
    const selection = this.pending;
    if (!selection) return;
    const bodyId = this.deps.bodyFor(selection);
    if (!bodyId || !this.deps.hasAnchor(bodyId)) return;
    this.pending = undefined;
    if (this.deps.focusedId() !== bodyId) this.deps.flyTo(bodyId);
  }

  /** The user moved the camera: a waiting flight would now fight them. */
  userMoved(): void {
    this.pending = undefined;
  }

  get waiting(): boolean {
    return this.pending !== undefined;
  }
}

/**
 * The page's deep-linked selection, once: consumed by the first scene that sees it through. Also
 * set by a navigation that comes back to the panel's main view with a new selection (P5-01), and
 * dropped by any other selection change.
 */
let deepLink: Selection | undefined = useAppStore.getState().selection;

useAppStore.subscribe((state, prev) => {
  if (state.selection === prev.selection) return;
  const entering = prev.route !== 'panel' && state.route === 'panel';
  deepLink =
    entering && !sameSelection(state.selection, prev.selection) ? state.selection : undefined;
});

/**
 * The panel's main view rendered without the scene (list mode): a deep link captured now (a page
 * load, a return from the settings or history page) is not for a scene shown later — showing the
 * scene never flies (P5-01, wave-1 review). Called by the panel.
 */
export function dropDeepLink(): void {
  deepLink = undefined;
}

/** For tests: what the page "loaded with". */
export function setDeepLinkForTest(selection: Selection | undefined): void {
  deepLink = selection;
}

let active: SelectionSync | undefined;

/** The scene's input (a press, a wheel): drops a flight still waiting for its body. */
export function noteUserCameraInput(): void {
  if (active?.waiting) deepLink = undefined;
  active?.userMoved();
}

/** Runs the panel → scene sync while the scene is shown (`SceneArea`). */
export function useSelectionSync(): void {
  useEffect(() => {
    const sync = new SelectionSync({
      bodyFor: (selection) => selectionBody(sceneWorld(useAppStore.getState()), selection),
      hasAnchor: (bodyId) => getAnchor(bodyId) !== undefined,
      focusedId: () => useCameraStore.getState().focusedId,
      flyTo: (bodyId) => {
        deepLink = undefined;
        useCameraStore.getState().flyTo(bodyId);
      },
      replaying: () => useAppStore.getState().replayWorld !== undefined,
    });
    active = sync;
    sync.start(useAppStore.getState().selection, deepLink);
    const stopApp = useAppStore.subscribe((state, prev) => {
      if (state.selection !== prev.selection) {
        deepLink = undefined;
        // A body's info popover is about the old view; the scene's own selection closed it.
        if (!isSceneSelection(state.selection)) usePickingStore.getState().closePopover();
        sync.selectionChanged(state.selection, isSceneSelection(state.selection));
      } else if (sceneWorld(state) !== sceneWorld(prev)) {
        sync.retry();
      }
    });
    const stopAnchors = onAnchorsChanged(() => sync.retry());
    return () => {
      stopApp();
      stopAnchors();
      if (active === sync) active = undefined;
    };
  }, []);
}
