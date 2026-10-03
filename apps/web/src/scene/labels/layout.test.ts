import { describe, expect, it } from 'vitest';
import { Matrix4, PerspectiveCamera } from 'three';
import {
  declutter,
  labelRect,
  LABEL_GAP_PX,
  movedEnough,
  occluded,
  onScreen,
  projectToScreen,
  Throttle,
  type LabelBox,
} from './layout.js';

function viewProjection(camera: PerspectiveCamera): number[] {
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    .elements;
}

describe('projectToScreen', () => {
  const camera = new PerspectiveCamera(45, 800 / 600, 0.1, 1000);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  const m = viewProjection(camera);

  it('matches three.js and puts the look-at point at the centre', () => {
    const p = projectToScreen(m, [0, 0, 0], 800, 600)!;
    expect(p.x).toBeCloseTo(400);
    expect(p.y).toBeCloseTo(300);
    expect(p.depth).toBeCloseTo(10);
    const q = projectToScreen(m, [1, 2, -3], 800, 600)!;
    const v = camera.position.clone().set(1, 2, -3).project(camera);
    expect(q.x).toBeCloseTo(((v.x + 1) / 2) * 800);
    expect(q.y).toBeCloseTo(((1 - v.y) / 2) * 600);
    expect(q.y).toBeLessThan(300); // +y is up on screen
  });

  it('a point behind the camera has no screen position', () => {
    expect(projectToScreen(m, [0, 0, 20], 800, 600)).toBeUndefined();
    expect(projectToScreen(m, [0, 0, 10], 800, 600)).toBeUndefined();
  });
});

describe('occlusion behind the Sun (and planets)', () => {
  const sun = { bodyId: 'b-sun', center: [0, 0, 0] as [number, number, number], radius: 6 };

  it('hides a body straight behind the Sun, not one beside it or in front', () => {
    expect(occluded([0, 0, 50], [0, 0, -40], 'b-x', [sun])).toBe(true);
    expect(occluded([0, 0, 50], [20, 0, -40], 'b-x', [sun])).toBe(false);
    expect(occluded([0, 0, 50], [0, 0, 20], 'b-x', [sun])).toBe(false);
  });

  it('never hides a body behind itself, and ignores occluders behind the eye', () => {
    expect(occluded([0, 0, 50], [0, 0, 0], 'b-sun', [sun])).toBe(false);
    expect(occluded([0, 0, 10], [0, 0, 30], 'b-x', [sun])).toBe(false);
  });

  it('a moon behind its planet is hidden; in front of it, shown', () => {
    const planet = {
      bodyId: 'b-jupiter',
      center: [100, 0, 0] as [number, number, number],
      radius: 4,
    };
    expect(occluded([100, 0, 40], [100, 0, -8], 'b-io', [planet])).toBe(true);
    expect(occluded([100, 0, 40], [100, 0, 8], 'b-io', [planet])).toBe(false);
  });
});

const box = (bodyId: string, x: number, y: number, priority: number, depth = 10): LabelBox => ({
  bodyId,
  x,
  y,
  r: 5,
  w: 80,
  h: 16,
  priority,
  depth,
});

describe('label placement and de-clutter', () => {
  it('a label sits centred above its body', () => {
    const r = labelRect(box('a', 100, 100, 1));
    expect(r).toEqual({
      left: 60,
      right: 140,
      bottom: 100 - 5 - LABEL_GAP_PX,
      top: 100 - 5 - LABEL_GAP_PX - 16,
    });
  });

  it('off-screen labels are culled', () => {
    expect(onScreen(box('a', 100, 100, 1), 800, 600)).toBe(true);
    expect(onScreen(box('a', -50, 100, 1), 800, 600)).toBe(false);
    expect(onScreen(box('a', 850, 100, 1), 800, 600)).toBe(false);
    expect(onScreen(box('a', 100, 700, 1), 800, 600)).toBe(false);
    expect(onScreen(box('a', 100, -20, 1), 800, 600)).toBe(false);
    expect(onScreen(box('a', -30, 100, 1), 800, 600)).toBe(true); // partly visible
    expect(onScreen(box('a', 100, 15, 1), 800, 600)).toBe(true); // label partly above the top
  });

  it('a label pushed above the viewport is hidden, unless pinned (selected, focused): clamped', () => {
    // The body's top is on screen (y 8, radius 5), its label entirely above the top edge.
    expect(labelRect(box('a', 100, 8, 1)).bottom).toBeLessThan(0);
    expect(onScreen(box('a', 100, 8, 1), 800, 600)).toBe(false);
    const pinned = { ...box('a', 100, 8, 5), pinTop: true };
    expect(onScreen(pinned, 800, 600)).toBe(true);
    expect(labelRect(pinned)).toMatchObject({ top: 0, bottom: 16 });
    // Pinning changes nothing for a label that fits, nor for a body above the viewport.
    expect(labelRect({ ...box('a', 100, 100, 5), pinTop: true })).toEqual(
      labelRect(box('a', 100, 100, 5)),
    );
    expect(onScreen({ ...box('a', 100, -20, 5), pinTop: true }, 800, 600)).toBe(false);
  });

  it('keeps every label that does not overlap', () => {
    const shown = declutter([box('a', 100, 100, 1), box('b', 300, 100, 1), box('c', 100, 300, 1)]);
    expect([...shown].sort()).toEqual(['a', 'b', 'c']);
  });

  it('selected > blocked on user > in progress > others when labels overlap', () => {
    const selected = box('sel', 100, 100, 5);
    const blocked = box('blk', 110, 104, 4);
    const active = box('act', 300, 100, 3);
    const other = box('oth', 310, 102, 2);
    const done = box('don', 320, 98, 1);
    const shown = declutter([done, other, active, blocked, selected]);
    expect([...shown].sort()).toEqual(['act', 'sel']);
    // Without the selected one, the blocked label shows.
    expect([...declutter([blocked, other, done])].sort()).toEqual(['blk', 'oth']);
  });

  it('equal priority: the nearer body wins, then the id (stable)', () => {
    expect([...declutter([box('far', 100, 100, 2, 50), box('near', 105, 100, 2, 20)])]).toEqual([
      'near',
    ]);
    expect([...declutter([box('b', 100, 100, 2), box('a', 105, 100, 2)])]).toEqual(['a']);
  });
});

describe('DOM write threshold', () => {
  it('rewrites only when moved more than half a pixel', () => {
    expect(movedEnough(undefined, 10, 10)).toBe(true);
    expect(movedEnough({ x: 10, y: 10 }, 10.4, 9.6)).toBe(false);
    expect(movedEnough({ x: 10, y: 10 }, 10.6, 10)).toBe(true);
    expect(movedEnough({ x: 10, y: 10 }, 10, 9.4)).toBe(true);
  });
});

describe('Throttle', () => {
  it('30 Hz on a 60 Hz display: every other frame', () => {
    const t = new Throttle(30);
    const frames = Array.from({ length: 60 }, (_, i) => i * (1000 / 60));
    const due = frames.filter((now) => t.due(now)).length;
    expect(due).toBe(30);
  });

  it('15 Hz on the capped 30 fps loop: every other frame', () => {
    const t = new Throttle(15);
    const frames = Array.from({ length: 30 }, (_, i) => i * (1000 / 30));
    expect(frames.filter((now) => t.due(now)).length).toBe(15);
  });

  it('a forced update goes through at once, then the rate resumes', () => {
    const t = new Throttle(30);
    expect(t.due(0)).toBe(true);
    expect(t.due(5)).toBe(false);
    expect(t.wait(5)).toBeGreaterThan(20);
    t.force();
    expect(t.wait(6)).toBe(0);
    expect(t.due(6)).toBe(true);
    expect(t.due(10)).toBe(false);
    t.setRate(15);
    expect(t.due(40)).toBe(false);
    expect(t.due(72)).toBe(true);
  });
});
