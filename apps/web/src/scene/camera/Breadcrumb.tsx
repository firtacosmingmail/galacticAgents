import { useAppStore } from '../../state/store.js';
import { SUN_ANCHOR_ID } from '../anchors.js';
import { SCENE_SHORTCUTS } from './keys.js';
import { useCameraStore } from './store.js';

/**
 * "Solar system › Jupiter › Europa" over the scene (P3-04): ordinary DOM outside the canvas. The
 * first crumb always flies back to the whole system, from any camera state; a moon's planet flies
 * to the planet. Names come from the world's bodies; an unknown body shows its id.
 */
export function CameraBreadcrumb() {
  const focusedId = useCameraStore((s) => s.focusedId);
  const back = useCameraStore((s) => s.back);
  const flyTo = useCameraStore((s) => s.flyTo);
  const body = useAppStore((s) => (focusedId ? s.world.bodies[focusedId] : undefined));
  const parent = useAppStore((s) => (body?.parentId ? s.world.bodies[body.parentId] : undefined));
  return (
    <nav
      className="pnl-scene-crumbs"
      aria-label="scene location"
      aria-keyshortcuts={SCENE_SHORTCUTS}
    >
      <ol>
        <li>
          <button
            type="button"
            onClick={back}
            title="Back to the whole system (Esc)"
            {...(focusedId ? {} : { 'aria-current': 'location' as const })}
          >
            Solar system
          </button>
        </li>
        {parent && (
          <li>
            <button type="button" onClick={() => flyTo(parent.id)}>
              {parent.name}
            </button>
          </li>
        )}
        {focusedId && (
          <li>
            <span aria-current="location">
              {body?.name ?? (focusedId === SUN_ANCHOR_ID ? 'Sun' : focusedId)}
            </span>
          </li>
        )}
      </ol>
    </nav>
  );
}
