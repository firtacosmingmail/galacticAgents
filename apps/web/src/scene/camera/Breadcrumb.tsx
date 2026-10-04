import { sceneWorld, useAppStore } from '../../state/store.js';
import { SUN_ANCHOR_ID } from '../anchors.js';
import { breadcrumbTrail, detailKind, useDetailStore } from '../detail/mode.js';
import { SCENE_SHORTCUTS } from './keys.js';
import { useCameraStore } from './store.js';

/**
 * "Solar system › Jupiter › Europa" over the scene (P3-04): ordinary DOM outside the canvas. The
 * first crumb always flies back to the whole system, from any camera state; a moon's planet flies
 * to the planet. Names come from the world's bodies; an unknown body shows its id.
 *
 * The detail view (P6-01): with the camera on a planet, moon or asteroid, a "Detail view" button
 * follows the trail and goes in (the camera flies close, the sub-scene fades in); in the detail
 * view the trail ends "› Jupiter › Detail", and the body's crumb goes back out to the system view
 * framed on the body (as `Escape` does).
 */
export function CameraBreadcrumb() {
  const focusedId = useCameraStore((s) => s.focusedId);
  const back = useCameraStore((s) => s.back);
  const flyTo = useCameraStore((s) => s.flyTo);
  const mode = useDetailStore((s) => s.mode);
  const bodies = useAppStore((s) => sceneWorld(s).bodies);
  const nameOf = (id: string) => bodies[id]?.name ?? (id === SUN_ANCHOR_ID ? 'Sun' : id);
  const trail = breadcrumbTrail(bodies, focusedId, mode, nameOf);
  const canEnter =
    mode.kind === 'system' &&
    focusedId !== undefined &&
    detailKind(bodies[focusedId]) !== undefined;
  return (
    <nav
      className="pnl-scene-crumbs"
      aria-label="scene location"
      aria-keyshortcuts={SCENE_SHORTCUTS}
    >
      <ol>
        {trail.map((crumb) => {
          if (crumb.kind === 'system')
            return (
              <li key="system">
                <button
                  type="button"
                  onClick={back}
                  title="Back to the whole system (Esc)"
                  {...(crumb.current ? { 'aria-current': 'location' as const } : {})}
                >
                  {crumb.label}
                </button>
              </li>
            );
          if (crumb.kind === 'detail')
            return (
              <li key="detail">
                <span aria-current="location">{crumb.label}</span>
              </li>
            );
          if (crumb.current)
            return (
              <li key={crumb.bodyId}>
                <span aria-current="location">{crumb.label}</span>
              </li>
            );
          return (
            <li key={crumb.bodyId}>
              <button
                type="button"
                onClick={() =>
                  crumb.leavesDetail ? useDetailStore.getState().exit() : flyTo(crumb.bodyId)
                }
                {...(crumb.leavesDetail ? { title: 'Back to the system view (Esc)' } : {})}
              >
                {crumb.label}
              </button>
            </li>
          );
        })}
        {canEnter && (
          <li className="pnl-scene-crumbs-action">
            <button
              type="button"
              onClick={() => useDetailStore.getState().enter(focusedId)}
              title="Go close: the detail view (Enter again, or zoom in)"
            >
              Detail view
            </button>
          </li>
        )}
      </ol>
    </nav>
  );
}
