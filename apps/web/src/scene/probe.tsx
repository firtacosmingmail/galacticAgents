import { useMemo, useSyncExternalStore } from 'react';
import { sceneWorld, useAppStore } from '../state/store.js';
import { anchorList, onAnchorsChanged } from './anchors.js';
import { useCameraStore } from './camera/store.js';
import { onSatellitesChanged, satelliteIds } from './satellites/registry.js';
import { SCENE_SATELLITES, satelliteList } from './satellites/satellite-model.js';

/**
 * The scene's test hook (P8-05): a hidden, empty element that mirrors what the canvas holds, so the
 * browser smoke tests (`e2e/`) can wait for and assert the scene by its state rather than by its
 * pixels:
 * - `data-bodies`: the ids of the bodies drawn (their registered anchors, `anchors.ts`), sorted;
 * - `data-satellites`: the agent ids of the satellites drawn (the director's published list,
 *   `satellites/registry.ts`, the HQ station included), sorted;
 * - `data-satellite-providers` (P11-10): `agentId:provider` of each satellite on a provider other than
 *   Claude, as the satellites' own list carries it (the ring tint, `look.ts`), sorted;
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
  const agents = useAppStore((s) => sceneWorld(s).agents);
  const statuses = useAppStore((s) => sceneWorld(s).statuses);
  const tasks = useAppStore((s) => sceneWorld(s).tasks);
  const projects = useAppStore((s) => sceneWorld(s).projects);
  const providers = useMemo(
    () =>
      satelliteList({ agents, statuses, tasks, projects }, SCENE_SATELLITES)
        .filter((s) => s.provider !== undefined && s.provider !== 'claude')
        .map((s) => `${s.agentId}:${s.provider}`)
        .sort()
        .join(' '),
    [agents, statuses, tasks, projects],
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
      data-satellite-providers={providers}
      data-camera={camera}
    />
  );
}
