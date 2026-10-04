/**
 * Where the cutaway's label layer (DOM, over the canvas, `CutawayLabels.tsx`) meets the cutaway
 * part inside the canvas (`Cutaway.tsx`), like the domain labels' registry (P3-07): the layer
 * registers one element per band; the part writes their position, visibility and opacity straight
 * into their style on each frame the cut is open. No three.js, no React state.
 */
const elements = new Map<number, HTMLElement>();

/** Registers band `index`'s label element; returns the cleanup. A new element starts hidden. */
export function registerCutawayLabel(index: number, el: HTMLElement): () => void {
  elements.set(index, el);
  return () => {
    if (elements.get(index) === el) elements.delete(index);
  };
}

export function cutawayLabel(index: number): HTMLElement | undefined {
  return elements.get(index);
}

/** Shows a label with its left-middle at (x, y) CSS pixels from the canvas's top-left. */
export function placeCutawayLabel(el: HTMLElement, x: number, y: number, opacity: number): void {
  el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(0, -50%)`;
  el.style.opacity = opacity.toFixed(2);
  el.style.visibility = 'visible';
}

/** Hides every label (the cut closed, the part unmounted). */
export function hideCutawayLabels(): void {
  for (const el of elements.values()) el.style.visibility = 'hidden';
}
