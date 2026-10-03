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
 */
export function SceneArea({ onFailure }: { onFailure: (reason: string) => void }) {
  const quality = sceneQuality(useQualityTier());
  const [showFps] = useState(fpsMeterEnabled);
  const [sample, setSample] = useState<(FpsSample & { dpr: number }) | undefined>();
  return (
    <section
      className="pnl-scene"
      aria-label="solar system"
      data-tier={quality.tier}
      tabIndex={0}
      aria-keyshortcuts={SCENE_SHORTCUTS}
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
      <CameraBreadcrumb />
      {showFps && <FpsMeter sample={sample} tier={quality.tier} />}
      <ScaleToggle />
    </section>
  );
}

/** The camera's keyboard shortcuts while the scene area has focus (typing in a field is ignored). */
export function onSceneKey(event: KeyboardEvent<HTMLElement>) {
  const action = sceneKeyAction({
    key: event.key,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    isComposing: event.nativeEvent.isComposing,
    target: event.target,
  });
  if (!action) return;
  event.preventDefault();
  const camera = useCameraStore.getState();
  if (action === 'back') camera.back();
  else if (action === 'next') camera.next();
  else camera.previous();
}

/** The canvas's drag handling may swallow the click's focus: give it to the area explicitly. */
function focusScene(event: PointerEvent<HTMLElement>) {
  const area = event.currentTarget;
  if (event.target instanceof HTMLButtonElement) return;
  if (!area.contains(document.activeElement)) area.focus({ preventScroll: true });
}

/** The development frame-rate readout (`?fps=1`), drawn over the canvas as ordinary DOM. */
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
