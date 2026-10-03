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
  /** Reports a scene that failed to start: list mode for the rest of this page's life. */
  fail: (reason: string) => void;
}

export const NO_WEBGL = 'WebGL is not available in this browser';

export function useScene(): SceneControl {
  const [visible, setVisibleState] = useState(readSceneVisible);
  const [failure, setFailure] = useState<string | undefined>(() =>
    webglAvailable() ? undefined : NO_WEBGL,
  );
  const setVisible = useCallback((next: boolean) => {
    writeSceneVisible(next);
    setVisibleState(next);
  }, []);
  const fail = useCallback((reason: string) => setFailure(reason), []);
  return { visible, failure, shown: visible && failure === undefined, setVisible, fail };
}
