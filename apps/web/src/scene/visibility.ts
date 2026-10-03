import { useCallback, useState } from 'react';
import { webglAvailable } from './webgl.js';

/** Per browser: whether the solar-system scene is shown beside the panel (P3-01). */
export const SCENE_VISIBLE_KEY = 'galactic.scene.visible';

export function readSceneVisible(): boolean {
  try {
    return localStorage.getItem(SCENE_VISIBLE_KEY) !== '0';
  } catch {
    return true;
  }
}

export function writeSceneVisible(visible: boolean): void {
  try {
    localStorage.setItem(SCENE_VISIBLE_KEY, visible ? '1' : '0');
  } catch {
    // No storage (private mode): the choice lasts for this page only.
  }
}

/** The scene's state as the panel sees it. */
export interface SceneControl {
  /** The user's choice: shown, or hidden ("list mode"). Remembered in this browser. */
  visible: boolean;
  /** Why the scene cannot run here (no WebGL, it failed to start); the panel stays in list mode. */
  failure: string | undefined;
  /** Whether the scene is mounted: chosen and able to run. */
  shown: boolean;
  setVisible: (visible: boolean) => void;
  /** Reports a scene that failed (to start, or lost its GPU context): list mode until a retry. */
  fail: (reason: string) => void;
  /**
   * Clears a reported failure so the scene mounts again (a fresh canvas and context). Undefined
   * when retrying cannot help: this browser has no WebGL at all.
   */
  retry: (() => void) | undefined;
}

export const NO_WEBGL = 'WebGL is not available in this browser';

export function useScene(): SceneControl {
  const [visible, setVisibleState] = useState(readSceneVisible);
  const [failed, setFailed] = useState<string | undefined>();
  const setVisible = useCallback((next: boolean) => {
    writeSceneVisible(next);
    setVisibleState(next);
  }, []);
  const fail = useCallback((reason: string) => setFailed(reason), []);
  const retry = useCallback(() => setFailed(undefined), []);
  // The WebGL probe runs only once the scene is to be shown: list mode never creates a context.
  const noWebgl = visible && !webglAvailable();
  const failure = noWebgl ? NO_WEBGL : failed;
  return {
    visible,
    failure,
    shown: visible && failure === undefined,
    setVisible,
    fail,
    retry: noWebgl ? undefined : retry,
  };
}
