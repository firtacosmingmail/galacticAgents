import { AdditiveBlending, Group, Mesh, MeshBasicMaterial, SphereGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import { PICK_TARGET_NAME } from '../belt/belt-model.js';
import { outlineMeshes, sameMeshes } from './outline.js';

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
