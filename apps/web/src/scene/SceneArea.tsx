import {
  Component,
  lazy,
  Suspense,
  useState,
  type ErrorInfo,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import type { QualityTier } from '@galactic/protocol';
import { useSettingsData } from '../panel/settings/SettingsData.js';
import { CameraBreadcrumb } from './camera/Breadcrumb.js';
import { sceneKeyAction, SCENE_SHORTCUTS } from './camera/keys.js';
import { useCameraStore } from './camera/store.js';
import { fpsMeterEnabled, type FpsSample } from './fps.js';
import { sceneQuality } from './quality.js';
import { ScaleToggle } from './bodies/ScaleToggle.js';
import { PickingOverlay } from './picking/PickingOverlay.js';
import { LabelLayer } from './labels/LabelLayer.js';
import { SatelliteLegend } from './legend/Legend.js';
import { activateBody, deselectFromScene, usePickingStore } from './picking/store.js';
import { useSelectionSync } from './picking/sync.js';
import { bodyAction } from './picking/body-action.js';
import { useDetailStore } from './detail/mode.js';
import { CutawayLabels } from './detail/cutaway/CutawayToggle.js';
import { sceneWorld, useAppStore } from '../state/store.js';
import { selectionKey } from '../state/selection.js';
import './scene.css';

/** The reason reported when the browser takes the scene's WebGL context away. */
export const CONTEXT_LOST = 'the GPU context was lost';

/** The three.js part, fetched on first show: its own chunk, never in jsdom unless mocked. */
const SolarScene = lazy(() => import('./SolarScene.js'));

/** The quality tier the settings hold (decision 51); the default until they are read. */
export function useQualityTier(): QualityTier | undefined {
  return useSettingsData().response?.settings.qualityTier;
}

/**
 * The scene's slot in the panel (P3-01): the centre of the layout. Mounting it creates the WebGL
 * context; unmounting it (list mode) releases the context and stops the frame loop. A scene that
 * fails to start (no context, a lost driver) or loses its GPU context while running reports
 * through `onFailure` and the panel falls back to list mode (with a "Retry").
 *
 * The area takes keyboard focus (a click on the scene gives it focus too) for the camera's
 * shortcuts (P3-04): `]` / `[` next / previous body, `Escape` / `Home` back to the whole system.
 * The breadcrumb over the scene shows where the camera is.
 *
 * Picking (P3-05): `Enter` on the area selects the body the camera is on (as a click would); a
 * second `Enter`, which would change nothing, enters its detail view (P6-01);
 * `Escape` closes the picking popover first, then leaves the detail view (P6-01); with no popover
 * and the camera on no body, it deselects (back to the Harmonizer, P5-01). The hover label and the popover are drawn here, over
 * the canvas; while the scene is shown, a selection made in the panel flies the camera to the
 * selected agent's body (`useSelectionSync`).
 *
 * Labels (P3-07): the domain labels' layer (`LabelLayer`) sits over the canvas, under the scene
 * chrome (fps meter, breadcrumb, scale toggle) and picking's hover label and popover — the
 * stacking order is in `scene.css`; the projector inside the canvas positions it. The cutaway's
 * layer labels (P6-03, `CutawayLabels`) share that slot.
 *
 * Legend (P4-02): what the satellites' colours and pulses mean, top-right, collapsible.
 */
export function SceneArea({ onFailure }: { onFailure: (reason: string) => void }) {
  const quality = sceneQuality(useQualityTier());
  const [showFps] = useState(fpsMeterEnabled);
  const [sample, setSample] = useState<(FpsSample & { dpr: number }) | undefined>();
  useSelectionSync();
  return (
    <section
      className="pnl-scene"
      aria-label="solar system"
      data-tier={quality.tier}
      tabIndex={0}
      aria-keyshortcuts={`${SCENE_SHORTCUTS} Enter`}
      onKeyDown={onSceneKey}
      onPointerDown={focusScene}
    >
      <SceneErrorBoundary onError={onFailure}>
        <Suspense fallback={<p className="pnl-scene-loading">Loading the solar system…</p>}>
          <SolarScene
            quality={quality}
            onContextLost={() => onFailure(CONTEXT_LOST)}
            {...(showFps ? { onFps: setSample } : {})}
          />
        </Suspense>
      </SceneErrorBoundary>
      <LabelLayer />
      <CutawayLabels />
      <PickingOverlay />
      <CameraBreadcrumb />
      {showFps && <FpsMeter sample={sample} tier={quality.tier} />}
      <ScaleToggle />
      <SatelliteLegend />
    </section>
  );
}

/** The camera's keyboard shortcuts while the scene area has focus (typing in a field is ignored). */
export function onSceneKey(event: KeyboardEvent<HTMLElement>) {
  if (pickingKey(event)) return;
  const action = sceneKeyAction({
    key: event.key,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    isComposing: event.nativeEvent.isComposing,
    target: event.target,
  });
  if (!action) return;
  const camera = useCameraStore.getState();
  // Escape unwinds one step at a time (P5-01): the popover (above), the camera's body, then the
  // selection — back to the Harmonizer, the camera staying — and only then the system's framing.
  // Home always goes back to the system. An Escape that changes nothing here (the Harmonizer
  // selected, the camera resting at the system's framing) is not taken: it reaches the replay
  // bar's document listener, which exits a replay (`escapeExitsReplay` skips a handled key).
  if (action === 'back' && event.key === 'Escape') {
    // P6-01: the detail view is left first, back to the system view framed on its body.
    if (useDetailStore.getState().exit()) {
      event.preventDefault();
      return;
    }
    if (!camera.focusedId && deselectFromScene()) {
      event.preventDefault();
      return;
    }
    if (camera.focusedId === undefined && !camera.flying && camera.atSystem) return;
  }
  event.preventDefault();
  if (action === 'back') camera.back();
  else if (action === 'next') camera.next();
  else camera.previous();
}

/**
 * Picking's keys (P3-05): `Escape` closes an open popover (before the camera's "back"); `Enter` on
 * the area itself (not on a button or field inside it) activates the body the camera is focused
 * on — selects who works there, or shows what it is. True when the key was handled.
 */
function pickingKey(event: KeyboardEvent<HTMLElement>): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) return false;
  const picking = usePickingStore.getState();
  if (event.key === 'Escape' && picking.popover) {
    event.preventDefault();
    picking.closePopover();
    event.currentTarget.focus({ preventScroll: true });
    return true;
  }
  if (event.key !== 'Enter' || event.target !== event.currentTarget) return false;
  const bodyId = useCameraStore.getState().focusedId;
  if (!bodyId) return false;
  event.preventDefault();
  // P6-01: an Enter that would change nothing — the body's agent is already selected, or its
  // card is already open — goes into the detail view instead.
  if (enterChangesNothing(bodyId) && useDetailStore.getState().enter(bodyId)) {
    picking.closePopover();
    return true;
  }
  const area = event.currentTarget;
  activateBody(bodyId, { x: area.clientWidth / 2, y: area.clientHeight / 2 }, { fly: false });
  return true;
}

/**
 * Whether activating `bodyId` (Enter on the camera's body) would change nothing: it selects the
 * agent already selected, or shows the info card already open for it (P6-01: the second Enter
 * enters the detail view).
 */
export function enterChangesNothing(bodyId: string): boolean {
  const app = useAppStore.getState();
  const action = bodyAction(sceneWorld(app), bodyId);
  if (action.kind === 'select')
    return selectionKey(action.selection) === selectionKey(app.selection);
  const popover = usePickingStore.getState().popover;
  return popover?.kind === 'info' && popover.action.bodyId === bodyId;
}

/** The canvas's drag handling may swallow the click's focus: give it to the area explicitly. */
function focusScene(event: PointerEvent<HTMLElement>) {
  const area = event.currentTarget;
  if (event.target instanceof HTMLButtonElement) return;
  if (!area.contains(document.activeElement)) area.focus({ preventScroll: true });
}

/** The development frame-rate readout (`?show_fps=true`), drawn over the canvas as ordinary DOM. */
export function FpsMeter({
  sample,
  tier,
}: {
  sample: (FpsSample & { dpr: number }) | undefined;
  tier: QualityTier;
}) {
  return (
    <output className="pnl-scene-fps" aria-label="frame rate">
      {sample
        ? `${sample.fps.toFixed(0)} fps · ${sample.frameMs.toFixed(1)} ms · dpr ${sample.dpr} · ${tier}`
        : `… fps · ${tier}`}
    </output>
  );
}

class SceneErrorBoundary extends Component<
  { onError: (reason: string) => void; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, _info: ErrorInfo) {
    console.warn('The 3D scene could not start; staying in list mode.', error);
    this.props.onError(error.message || 'the 3D scene could not start');
  }

  override render() {
    return this.state.failed ? null : this.props.children;
  }
}
