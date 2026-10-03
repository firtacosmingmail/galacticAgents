import {
  AdditiveBlending,
  Frustum,
  Matrix4,
  Sphere,
  type Camera,
  type Material,
  type Mesh,
  type Object3D,
} from 'three';
import { PICK_TARGET_NAME } from '../belt/belt-model.js';
import { withoutDecor } from '../layers.js';

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

/**
 * Margin on a body's radius for the on-screen test: the outline's edges reach a few pixels past
 * the body, and Saturn's and Uranus's rings reach ≈ 2.3 planet radii.
 */
export const OUTLINE_VIEW_MARGIN = 2.5;

export interface ViewScratch {
  frustum: Frustum;
  matrix: Matrix4;
  sphere: Sphere;
}

export const viewScratch = (): ViewScratch => ({
  frustum: new Frustum(),
  matrix: new Matrix4(),
  sphere: new Sphere(),
});

/**
 * Whether a body (its anchor object and visual radius) is at least partly inside the camera's view
 * (P3-08). The outline costs a depth pass over the scene on every frame its selection is not
 * empty, and an off-screen body has no edges to draw: its selection is emptied until it comes
 * back. Allocation-free with a reused `scratch`.
 */
export function bodyInView(
  camera: Camera,
  object: Object3D,
  radius: number,
  scratch: ViewScratch,
): boolean {
  camera.updateMatrixWorld();
  scratch.matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  scratch.frustum.setFromProjectionMatrix(scratch.matrix);
  object.getWorldPosition(scratch.sphere.center);
  scratch.sphere.radius = radius * OUTLINE_VIEW_MARGIN;
  return scratch.frustum.intersectsSphere(scratch.sphere);
}

/** The parts of postprocessing's `OutlineEffect` that `depthPassWithoutDecor` touches (untyped there). */
export interface OutlineDepthPassOwner {
  camera: Pick<Camera, 'layers'>;
  depthPass: { render: (...args: never[]) => unknown };
}

const PATCHED = Symbol('depthPassWithoutDecor');

/**
 * Makes the outline's depth pass skip the decorations (`layers.ts`, P3-08): the pass only decides
 * which of the outline's edges are hidden behind something, so orbit lines, the star field, the
 * belt's background rocks, halos and rings have no business in it. Idempotent per effect; an
 * effect without those internals (another postprocessing version) is left as it is.
 */
export function depthPassWithoutDecor(effect: Partial<OutlineDepthPassOwner>): void {
  const pass = effect.depthPass as
    (OutlineDepthPassOwner['depthPass'] & { [PATCHED]?: true }) | undefined;
  const camera = effect.camera;
  if (!pass || typeof pass.render !== 'function' || !camera?.layers || pass[PATCHED]) return;
  const render = pass.render.bind(pass) as (...args: unknown[]) => unknown;
  // The effect's camera at render time (postprocessing's `mainCamera` setter replaces it).
  pass.render = ((...args: unknown[]) =>
    withoutDecor(effect.camera ?? camera, () => render(...args))) as typeof pass.render;
  pass[PATCHED] = true;
}
