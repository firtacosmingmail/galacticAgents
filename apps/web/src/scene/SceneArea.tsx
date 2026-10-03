import { Component, lazy, Suspense, useState, type ErrorInfo, type ReactNode } from 'react';
import type { QualityTier } from '@galactic/protocol';
import { useSettingsData } from '../panel/settings/SettingsData.js';
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
 */
export function SceneArea({ onFailure }: { onFailure: (reason: string) => void }) {
  const quality = sceneQuality(useQualityTier());
  const [showFps] = useState(fpsMeterEnabled);
  const [sample, setSample] = useState<(FpsSample & { dpr: number }) | undefined>();
  return (
    <section className="pnl-scene" aria-label="solar system" data-tier={quality.tier}>
      <SceneErrorBoundary onError={onFailure}>
        <Suspense fallback={<p className="pnl-scene-loading">Loading the solar system…</p>}>
          <SolarScene
            quality={quality}
            onContextLost={() => onFailure(CONTEXT_LOST)}
            {...(showFps ? { onFps: setSample } : {})}
          />
        </Suspense>
      </SceneErrorBoundary>
      {showFps && <FpsMeter sample={sample} tier={quality.tier} />}
      <ScaleToggle />
    </section>
  );
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
