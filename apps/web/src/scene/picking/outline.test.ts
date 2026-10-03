import {
  AdditiveBlending,
  Group,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  SphereGeometry,
} from 'three';
import { describe, expect, it } from 'vitest';
import { PICK_TARGET_NAME } from '../belt/belt-model.js';
import { DECOR_LAYER, showDecor, withoutDecor } from '../layers.js';
import {
  bodyInView,
  depthPassWithoutDecor,
  OUTLINE_VIEW_MARGIN,
  outlineMeshes,
  sameMeshes,
  viewScratch,
} from './outline.js';

const geometry = new SphereGeometry(1, 4, 4);
const mesh = (name: string, visible = true) => {
  const m = new Mesh(geometry, new MeshBasicMaterial({ visible }));
  m.name = name;
  return m;
};

describe('outlineMeshes (what the selection outline draws)', () => {
  it("takes the body's meshes, not its moons', its halo nor the invisible pick target", () => {
    const planet = new Group();
    planet.userData = { bodyId: 'b-jupiter' };
    const tilt = new Group();
    const surface = mesh('surface');
    const rings = mesh('rings');
    const moon = new Group();
    moon.userData = { bodyId: 'b-io' };
    moon.add(mesh('io-surface'));
    tilt.add(surface, rings, moon);
    planet.add(tilt);
    expect(outlineMeshes(planet, 'b-jupiter')).toEqual([surface, rings]);
    expect(outlineMeshes(moon, 'b-io').map((m) => m.name)).toEqual(['io-surface']);

    const asteroid = new Group();
    asteroid.userData = { bodyId: 'b-ast-7', kind: 'asteroid', hostId: 't-1' };
    const rock = mesh('rock');
    const pick = mesh(PICK_TARGET_NAME);
    pick.userData = { ...asteroid.userData };
    const halo = mesh('halo');
    (halo.material as MeshBasicMaterial).blending = AdditiveBlending;
    asteroid.add(rock, halo, pick, mesh('hidden', false));
    expect(outlineMeshes(asteroid, 'b-ast-7')).toEqual([rock]);
  });

  it('follows a mesh swapped inside the anchor (an LOD tier)', () => {
    const planet = new Group();
    planet.userData = { bodyId: 'b-mars' };
    const low = mesh('low');
    planet.add(low);
    const before = outlineMeshes(planet, 'b-mars');
    planet.remove(low);
    const high = mesh('high');
    planet.add(high);
    const after = outlineMeshes(planet, 'b-mars');
    expect(sameMeshes(before, after)).toBe(false);
    expect(after).toEqual([high]);
    expect(sameMeshes(after, outlineMeshes(planet, 'b-mars'))).toBe(true);
  });
});

describe('outline cost (P3-08)', () => {
  const camera = new PerspectiveCamera(45, 4 / 3, 0.1, 1000);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  const at = (x: number, y: number, z: number) => {
    const o = new Object3D();
    o.position.set(x, y, z);
    return o;
  };

  it('knows whether a body is on screen, with a margin for its edges and rings', () => {
    const scratch = viewScratch();
    expect(bodyInView(camera, at(0, 0, 0), 1, scratch)).toBe(true);
    expect(bodyInView(camera, at(0, 0, 20), 1, scratch)).toBe(false); // behind the camera
    expect(bodyInView(camera, at(40, 0, 0), 1, scratch)).toBe(false); // far to the side
    // Above the top edge by more than its radius, but within its rings' reach: still outlined.
    const edge = Math.tan((22.5 * Math.PI) / 180) * 10;
    expect(bodyInView(camera, at(0, edge + 1.5, 0), 1, scratch)).toBe(true);
    expect(bodyInView(camera, at(0, edge + 1 + OUTLINE_VIEW_MARGIN, 0), 1, scratch)).toBe(false);
  });

  it("renders the depth pass without the decorations' layer, patched once, and restores it", () => {
    const cam = new PerspectiveCamera();
    showDecor(cam);
    const seen: number[] = [];
    const depthPass = { render: (..._args: never[]) => seen.push(cam.layers.mask) };
    const effect = { camera: cam, depthPass };
    depthPassWithoutDecor(effect);
    depthPassWithoutDecor(effect); // idempotent
    depthPass.render();
    expect(seen).toEqual([1]); // layer 0 only
    expect(cam.layers.isEnabled(DECOR_LAYER)).toBe(true);
    // An effect without those internals is left alone.
    expect(() => depthPassWithoutDecor({})).not.toThrow();
  });

  it('restores the camera even when the pass throws', () => {
    const cam = new PerspectiveCamera();
    showDecor(cam);
    expect(() =>
      withoutDecor(cam, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(cam.layers.isEnabled(DECOR_LAYER)).toBe(true);
  });

  it('hides a decoration from the camera inside withoutDecor only', () => {
    const cam = new PerspectiveCamera();
    showDecor(cam);
    const line = new Object3D();
    line.layers.set(DECOR_LAYER);
    expect(line.layers.test(cam.layers)).toBe(true);
    expect(withoutDecor(cam, () => line.layers.test(cam.layers))).toBe(false);
    expect(new Object3D().layers.test(cam.layers)).toBe(true);
  });
});
