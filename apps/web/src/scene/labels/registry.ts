/**
 * Where the label layer (DOM, outside the canvas) meets the label projector (inside it) (P3-07):
 * the layer registers each label's element with its priority and measured size; the projector
 * reads them on each update and writes positions straight into the elements' style. No three.js,
 * no React state: positions never go through a render.
 *
 * `labelStats` counts the projector's updates and DOM writes (for the perf notes and tests).
 *
 * The labels take no pointer events (CSS): picking (`Picking.tsx`) asks `labelAt` which shown
 * label is under the pointer, so wheel, drag and click all reach the canvas first.
 */
export interface LabelEntry {
  bodyId: string;
  el: HTMLElement;
  priority: number;
  /** The element's size in CSS pixels, measured when its content changes. */
  w: number;
  h: number;
  /**
   * The deliverables mark's box inside the label (decision 133), in CSS pixels from the label's
   * top-left, measured with the label; absent when the label shows no mark.
   */
  mark?: MarkBox | undefined;
  /** What the projector last wrote (owned by it): position and visibility. */
  written?: { x: number; y: number } | undefined;
  shown?: boolean | undefined;
}

export interface MarkBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

const sameMark = (a: MarkBox | undefined, b: MarkBox | undefined) =>
  a === b ||
  (a !== undefined && b !== undefined && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

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
export function updateLabel(
  bodyId: string,
  patch: Pick<LabelEntry, 'priority' | 'w' | 'h'> & { mark?: MarkBox | undefined },
): void {
  const entry = entries.get(bodyId);
  if (!entry) return;
  const mark = patch.mark;
  if (
    entry.priority === patch.priority &&
    entry.w === patch.w &&
    entry.h === patch.h &&
    sameMark(entry.mark, mark)
  )
    return;
  entry.priority = patch.priority;
  entry.w = patch.w;
  entry.h = patch.h;
  entry.mark = mark;
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

/**
 * The body whose shown label covers the point (CSS pixels from the canvas's top-left), from what
 * the projector last wrote: the label's bottom centre at `written`, its measured size around it.
 * De-clutter keeps shown labels apart; should two still meet, the higher priority wins (the one
 * drawn on top).
 */
export function labelAt(x: number, y: number): string | undefined {
  return labelHitAt(x, y)?.bodyId;
}

/** A shown label under the point, and whether the point is on its deliverables mark. */
export interface LabelHit {
  bodyId: string;
  onMark: boolean;
}

/** `labelAt`, also telling whether the point is on the label's deliverables mark (decision 133). */
export function labelHitAt(x: number, y: number): LabelHit | undefined {
  let best: LabelEntry | undefined;
  for (const entry of entries.values()) {
    const at = entry.written;
    if (!entry.shown || !at) continue;
    const inside =
      x >= at.x - entry.w / 2 && x <= at.x + entry.w / 2 && y >= at.y - entry.h && y <= at.y;
    if (inside && (!best || entry.priority > best.priority)) best = entry;
  }
  if (!best?.written) return undefined;
  const mark = best.mark;
  const left = best.written.x - best.w / 2;
  const top = best.written.y - best.h;
  const onMark =
    mark !== undefined &&
    x >= left + mark.x &&
    x <= left + mark.x + mark.w &&
    y >= top + mark.y &&
    y <= top + mark.y + mark.h;
  return { bodyId: best.bodyId, onMark };
}

/** Hides every label (the projector unmounted: the scene hidden, the context lost). */
export function hideAll(): void {
  for (const entry of entries.values()) setShown(entry, false);
}
