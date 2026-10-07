/**
 * How the viewer shows an SVG (wave-3 review B1; TECHNOLOGY §9.5). An SVG is never given a `blob:`
 * URL: a blob URL has the panel's origin, so "Open image in new tab" would render the SVG as a
 * top-level document of that origin — its scripts could read the token from `localStorage` and
 * start runs. Instead:
 *
 * 1. **Rasterised** (preferred): the SVG is decoded as an image from a `data:` URL (an image
 *    context: no script runs, nothing external loads), drawn on a canvas and shown as a PNG
 *    `blob:` — opening that in a tab shows pixels, never a document.
 * 2. **`data:image/svg+xml;base64,…`** when the canvas cannot do it (no 2D context, a tainted
 *    canvas — older Safari taints on any SVG — or the image does not decode in time): a `data:`
 *    document has an opaque origin, so even opened on its own its script reaches no storage of the
 *    panel; and the browsers block top-level navigation to `data:` from a page (Chrome, Firefox,
 *    Safari), so "Open image in new tab" shows nothing or the image in an opaque origin.
 */

/** The longest side of the rasterised picture (device pixels). */
const MAX_SIDE = 4096;
/** The size given to an SVG without an intrinsic one. */
const FALLBACK_SIDE = 1024;
/** How long the decode may take before the `data:` URL stands in. */
const DECODE_MS = 5_000;

/** `data:image/svg+xml;base64,…` of the bytes. */
export function svgDataUrl(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  }
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

function decode(src: string, ms: number): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error('the SVG did not decode'));
    };
    img.src = src;
  });
}

export interface SvgPreview {
  /** A PNG `blob:` URL (`revoke` it), or the SVG's `data:` URL. */
  url: string;
  revoke?: () => void;
}

/** The SVG as a PNG `blob:` URL, else as its `data:` URL — never an SVG `blob:` URL. */
export async function svgPreview(
  bytes: ArrayBuffer,
  doc: Document = document,
): Promise<SvgPreview> {
  const dataUrl = svgDataUrl(bytes);
  const canvas = doc.createElement('canvas');
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  } catch {
    ctx = null;
  }
  if (!ctx) return { url: dataUrl };
  try {
    const img = await decode(dataUrl, DECODE_MS);
    const w = img.naturalWidth || FALLBACK_SIDE;
    const h = img.naturalHeight || FALLBACK_SIDE;
    const ratio = typeof window !== 'undefined' ? Math.max(1, window.devicePixelRatio || 1) : 1;
    const scale = Math.min(ratio, MAX_SIDE / Math.max(w, h));
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!png || png.type !== 'image/png') return { url: dataUrl };
    const url = URL.createObjectURL(png);
    return { url, revoke: () => URL.revokeObjectURL(url) };
  } catch {
    // A tainted canvas (SecurityError), no decode, no blob: the opaque-origin `data:` URL.
    return { url: dataUrl };
  }
}
