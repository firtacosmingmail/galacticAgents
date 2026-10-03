/**
 * Telling a click from a drag on the canvas (P3-05): OrbitControls turns every drag into a camera
 * move, so a pointer that travelled more than `CLICK_SLOP_PX` between press and release is a drag
 * and picks nothing. Only the primary button, one pointer at a time (a second finger makes it a
 * pinch), and not after a long press (`CLICK_MAX_MS`: a held press is a look, not a click).
 */
export const CLICK_SLOP_PX = 4;
export const CLICK_MAX_MS = 800;

interface Press {
  pointerId: number;
  x: number;
  y: number;
  at: number;
  travelled: number;
}

export class ClickTracker {
  private press: Press | undefined;
  private cancelled = false;

  down(e: { pointerId: number; button: number; x: number; y: number; at: number }): void {
    if (this.press) {
      // A second pointer: a pinch or a two-finger pan, never a click.
      this.cancelled = true;
      return;
    }
    this.cancelled = e.button !== 0;
    this.press = { pointerId: e.pointerId, x: e.x, y: e.y, at: e.at, travelled: 0 };
  }

  move(e: { pointerId: number; x: number; y: number }): void {
    const p = this.press;
    if (!p || p.pointerId !== e.pointerId) return;
    p.travelled = Math.max(p.travelled, Math.hypot(e.x - p.x, e.y - p.y));
  }

  /** The release; true when the press was a click. */
  up(e: { pointerId: number; x: number; y: number; at: number }): boolean {
    const p = this.press;
    if (!p || p.pointerId !== e.pointerId) return false;
    this.move(e);
    this.press = undefined;
    const click = !this.cancelled && p.travelled <= CLICK_SLOP_PX && e.at - p.at <= CLICK_MAX_MS;
    this.cancelled = false;
    return click;
  }

  /** The pointer was lost (`pointercancel`, the window lost focus). */
  cancel(): void {
    this.press = undefined;
    this.cancelled = false;
  }
}
