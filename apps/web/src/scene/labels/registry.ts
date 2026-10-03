/**
 * Where the label layer (DOM, outside the canvas) meets the label projector (inside it) (P3-07):
 * the layer registers each label's element with its priority and measured size; the projector
 * reads them on each update and writes positions straight into the elements' style. No three.js,
 * no React state: positions never go through a render.
 *
 * `labelStats` counts the projector's updates and DOM writes (for the perf notes and tests).
 */
export interface LabelEntry {
  bodyId: string;
  el: HTMLElement;
  priority: number;
  /** The element's size in CSS pixels, measured when its content changes. */
  w: number;
  h: number;
  /** What the projector last wrote (owned by it): position and visibility. */
  written?: { x: number; y: number } | undefined;
  shown?: boolean | undefined;
}

const entries = new Map<string, LabelEntry>();
const listeners = new Set<() => void>();

export const labelStats = { updates: 0, writes: 0 };

export function resetLabelStats(): void {
  labelStats.updates = 0;
  labelStats.writes = 0;
}

const changed = () => listeners.forEach((l) => l());

/** Registers a label's element; returns the cleanup. A new element starts hidden (CSS). */
export function registerLabel(
  entry: Pick<LabelEntry, 'bodyId' | 'el' | 'priority' | 'w' | 'h'>,
): () => void {
  const registered: LabelEntry = { ...entry };
  entries.set(entry.bodyId, registered);
  changed();
  return () => {
    if (entries.get(entry.bodyId) === registered) {
      entries.delete(entry.bodyId);
      changed();
    }
  };
}

/** A label's content changed: its priority and measured size. */
export function updateLabel(bodyId: string, patch: Pick<LabelEntry, 'priority' | 'w' | 'h'>): void {
  const entry = entries.get(bodyId);
  if (!entry) return;
  if (entry.priority === patch.priority && entry.w === patch.w && entry.h === patch.h) return;
  Object.assign(entry, patch);
  changed();
}

export function labelEntries(): Iterable<LabelEntry> {
  return entries.values();
}

/** Called when a label is added, removed or changes size or priority (not when it moves). */
export function onLabelsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Shows or hides a label (counted as a write when it changes). */
export function setShown(entry: LabelEntry, shown: boolean): void {
  if (entry.shown === shown) return;
  entry.shown = shown;
  entry.el.style.visibility = shown ? 'visible' : 'hidden';
  labelStats.writes++;
  if (!shown) entry.written = undefined;
}

/** Moves a label so its bottom centre sits at (x, y). */
export function writePosition(entry: LabelEntry, x: number, y: number): void {
  entry.written = { x, y };
  entry.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`;
  labelStats.writes++;
}

/** Hides every label (the projector unmounted: the scene hidden, the context lost). */
export function hideAll(): void {
  for (const entry of entries.values()) setShown(entry, false);
}
