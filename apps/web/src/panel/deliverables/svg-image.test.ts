import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { svgDataUrl, svgPreview } from './svg-image.js';

/** Wave-3 review B1: an SVG never gets a `blob:` URL — a PNG of it, or its `data:` URL. */

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="2"><script>x()</script></svg>';
const bytes = () => new TextEncoder().encode(SVG).buffer as ArrayBuffer;

/** An `Image` that decodes at once (jsdom never loads one). */
class DecodingImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 4;
  naturalHeight = 2;
  set src(_: string) {
    queueMicrotask(() => this.onload?.());
  }
}

function fakeDoc(canvas: Partial<HTMLCanvasElement>): Document {
  return { createElement: () => canvas } as unknown as Document;
}

let created: Blob[];
beforeEach(() => {
  created = [];
  URL.createObjectURL = vi.fn((b: Blob | MediaSource) => {
    created.push(b as Blob);
    return `blob:http://localhost/${created.length}`;
  });
  URL.revokeObjectURL = vi.fn();
  vi.stubGlobal('Image', DecodingImage);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('svgPreview', () => {
  it('rasterises to a PNG blob when the canvas can', async () => {
    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage }) as unknown as CanvasRenderingContext2D,
      toBlob: (cb: BlobCallback) => cb(new Blob(['png'], { type: 'image/png' })),
    } as unknown as HTMLCanvasElement;
    const shown = await svgPreview(bytes(), fakeDoc(canvas));
    expect(shown.url).toMatch(/^blob:/);
    expect(created.map((b) => b.type)).toEqual(['image/png']);
    expect(drawImage).toHaveBeenCalledOnce();
    shown.revoke?.();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(shown.url);
  });

  it('falls back to the data: URL on a tainted canvas or without a 2D context — never an SVG blob', async () => {
    const tainted = {
      getContext: () => ({ drawImage: () => {} }) as unknown as CanvasRenderingContext2D,
      toBlob: () => {
        throw new DOMException('tainted', 'SecurityError');
      },
    } as unknown as HTMLCanvasElement;
    expect((await svgPreview(bytes(), fakeDoc(tainted))).url).toBe(svgDataUrl(bytes()));
    const none = { getContext: () => null } as unknown as HTMLCanvasElement;
    expect((await svgPreview(bytes(), fakeDoc(none))).url).toBe(svgDataUrl(bytes()));
    expect(created.filter((b) => b.type === 'image/svg+xml')).toEqual([]);
    expect(created).toEqual([]);
  });

  it('encodes the bytes as base64 image/svg+xml', () => {
    const url = svgDataUrl(bytes());
    expect(url.startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(atob(url.split(',')[1]!)).toBe(SVG);
  });
});
