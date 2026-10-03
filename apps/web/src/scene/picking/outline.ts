import { AdditiveBlending, type Material, type Mesh, type Object3D } from 'three';
import { PICK_TARGET_NAME } from '../belt/belt-model.js';

/**
 * The meshes the selection outline draws for a body (P3-05): every mesh in its anchor's subtree,
 * whatever mesh the body currently draws (an LOD tier, P3-06), except
 * - other bodies nested inside it (a planet's anchor carries its moons: their own anchors, marked
 *   by a different `userData.bodyId`, are not descended into),
 * - never-drawn meshes (a task asteroid's invisible pick target, a `visible: false` material),
 * - glows (additive materials: a task asteroid's halo would outline a disc around the rock).
 * Only used inside the canvas (the scene's chunk).
 */
export function outlineMeshes(root: Object3D, bodyId: string): Mesh[] {
  const out: Mesh[] = [];
  const visit = (object: Object3D) => {
    if (object !== root) {
      const owner = (object.userData as { bodyId?: unknown } | undefined)?.bodyId;
      if (typeof owner === 'string' && owner !== bodyId) return;
    }
    const mesh = object as Mesh;
    if (mesh.isMesh && mesh.name !== PICK_TARGET_NAME && drawn(mesh.material)) out.push(mesh);
    for (const child of object.children) visit(child);
  };
  visit(root);
  return out;
}

function drawn(material: Material | Material[]): boolean {
  const solid = (m: Material) => m.visible && m.blending !== AdditiveBlending;
  return Array.isArray(material) ? material.some(solid) : solid(material);
}

/** Whether two mesh lists hold the same meshes in the same order (no outline update needed). */
export function sameMeshes(a: readonly Object3D[], b: readonly Object3D[]): boolean {
  return a.length === b.length && a.every((m, i) => m === b[i]);
}
