import { TRUE_SIZE_EXAGGERATION, useSceneScale } from '../scale.js';
import './scale-toggle.css';

/** What the scene's scale note says in each mode (corner case 25: say the layout is not real). */
export const SCALE_NOTES = {
  fake: 'Readable layout — distances and sizes not to scale',
  true: `True distances — sizes and moon orbits enlarged ×${TRUE_SIZE_EXAGGERATION}, Sun not to scale`,
} as const;

/**
 * The "true scale" toggle (P3-02), drawn over the scene as ordinary DOM (not in the canvas), with
 * a note saying which layout is shown. The label stays the same and `aria-pressed` carries the
 * state. Imports no three.js: it lives in the panel's first chunk.
 */
export function ScaleToggle() {
  const mode = useSceneScale((s) => s.mode);
  const setMode = useSceneScale((s) => s.setMode);
  const trueScale = mode === 'true';
  return (
    <div className="pnl-scene-scale">
      <button
        type="button"
        aria-pressed={trueScale}
        onClick={() => setMode(trueScale ? 'fake' : 'true')}
      >
        True scale
      </button>
      <span className="pnl-scene-scale-note">{SCALE_NOTES[mode]}</span>
    </div>
  );
}
