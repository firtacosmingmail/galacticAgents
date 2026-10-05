import type { SceneControl } from '../scene/visibility.js';

/**
 * List mode's one-tap way back to the scene on a phone (P7-03). The compact top bar keeps "Show
 * scene" in its menu (decision 67), two taps away; in list mode on a compact screen this row sits
 * where the scene would be, at the top of the stack, with a single "Show scene" button. It says
 * why the panel started in list mode when the user did not choose it (a small screen, a slow
 * connection). Tapping it shows the scene and remembers that in this browser (decision 62).
 */
export function SceneOffer({ scene }: { scene: SceneControl }) {
  const why =
    scene.autoHidden === 'slow-connection'
      ? 'List mode, to spare a slow connection.'
      : scene.autoHidden === 'small-screen'
        ? 'List mode, for a small screen.'
        : 'List mode.';
  return (
    <div className="pnl-scene-offer" role="group" aria-label="solar system">
      <span className="pnl-scene-offer-text">{why}</span>
      <button
        type="button"
        className="pnl-scene-toggle pnl-scene-offer-button"
        onClick={() => scene.setVisible(true)}
      >
        Show scene
      </button>
    </div>
  );
}
