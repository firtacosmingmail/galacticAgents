/**
 * Whether this browser can create a WebGL context (decision 20: WebGL only). Probed once per page
 * on a throwaway canvas before the scene's code is even loaded; a failure keeps the panel in list
 * mode with a note. A context that fails later (inside R3F) is caught by the scene's error
 * boundary instead.
 *
 * jsdom (the test environment) has no WebGL and reports `getContext` as "not implemented" on the
 * console, so it is answered without probing.
 */
let cached: boolean | undefined;

export function webglAvailable(): boolean {
  if (cached !== undefined) return cached;
  cached = probe();
  return cached;
}

function probe(): boolean {
  if (typeof document === 'undefined') return false;
  if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) return false;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return false;
    // Give the probe's context back at once: browsers cap live contexts.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}
