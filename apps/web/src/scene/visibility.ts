import { useCallback, useState } from 'react';
import { webglAvailable } from './webgl.js';
import { listModeReason, liveProbe, type DeviceProbe, type ListModeReason } from './device.js';

/** Per browser: whether the solar-system scene is shown beside the panel (P3-01). */
export const SCENE_VISIBLE_KEY = 'galactic.scene.visible';

/** The remembered choice: shown, hidden, or `undefined` (never chosen in this browser). */
export function readSceneChoice(): boolean | undefined {
  try {
    const value = localStorage.getItem(SCENE_VISIBLE_KEY);
    return value === null ? undefined : value !== '0';
  } catch {
    return undefined;
  }
}

/**
 * Whether the scene starts shown: the remembered choice; with none, shown — except on a small
 * screen or a slow connection (P7-03, `device.ts`), where the panel starts in list mode and offers
 * the scene with one tap.
 */
export function readSceneVisible(probe: DeviceProbe = liveProbe()): boolean {
  return readSceneChoice() ?? listModeReason(probe) === undefined;
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
  /**
   * Why the scene is hidden without the user having chosen so (P7-03: a small screen, a slow
   * connection); `undefined` once the user chose, or when the scene is shown.
   */
  autoHidden: ListModeReason | undefined;
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
  const [initial] = useState(() => {
    const chosen = readSceneChoice();
    const reason = chosen === undefined ? listModeReason() : undefined;
    return { visible: chosen ?? reason === undefined, reason };
  });
  const [visible, setVisibleState] = useState(initial.visible);
  const [chose, setChose] = useState(false);
  const [failed, setFailed] = useState<string | undefined>();
  const setVisible = useCallback((next: boolean) => {
    writeSceneVisible(next);
    setVisibleState(next);
    setChose(true);
  }, []);
  const fail = useCallback((reason: string) => setFailed(reason), []);
  const retry = useCallback(() => setFailed(undefined), []);
  // The WebGL probe runs only once the scene is to be shown: list mode never creates a context.
  const noWebgl = visible && !webglAvailable();
  const failure = noWebgl ? NO_WEBGL : failed;
  return {
    visible,
    autoHidden: !visible && !chose ? initial.reason : undefined,
    failure,
    shown: visible && failure === undefined,
    setVisible,
    fail,
    retry: noWebgl ? undefined : retry,
  };
}
