import { useSyncExternalStore } from 'react';
import { anchorList, onAnchorsChanged } from './anchors.js';
import { useCameraStore } from './camera/store.js';
import { onSatellitesChanged, satelliteIds } from './satellites/registry.js';

/**
 * The scene's test hook (P8-05): a hidden, empty element that mirrors what the canvas holds, so the
 * browser smoke tests (`e2e/`) can wait for and assert the scene by its state rather than by its
 * pixels:
 * - `data-bodies`: the ids of the bodies drawn (their registered anchors, `anchors.ts`), sorted;
 * - `data-satellites`: the agent ids of the satellites drawn (the director's published list,
 *   `satellites/registry.ts`, the HQ station included), sorted;
 * - `data-camera`: `flying`, the focused body's id, `system` (resting at the system's framing) or
 *   `free` (the user moved it).
 *
 * Nothing reads it in the app: no text, no role, not in the accessibility tree (`hidden`). No
 * three.js here (the panel's chunk).
 */
export function SceneProbe() {
  const anchors = useSyncExternalStore(onAnchorsChanged, anchorList);
  const satellites = useSyncExternalStore(onSatellitesChanged, satelliteIds);
  const camera = useCameraStore((s) =>
    s.flying ? 'flying' : (s.focusedId ?? (s.atSystem ? 'system' : 'free')),
  );
  return (
    <div
      hidden
      data-testid="scene-probe"
      data-bodies={anchors
        .map((a) => a.bodyId)
        .sort()
        .join(' ')}
      data-satellites={[...satellites].sort().join(' ')}
      data-camera={camera}
    />
  );
}
