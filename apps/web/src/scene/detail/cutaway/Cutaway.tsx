import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Plane,
  Vector3,
  type Group,
  type Material,
  type Mesh,
  type Object3D,
} from 'three';
import { READ_BODIES } from '../../frame-order.js';
import { useReducedMotion } from '../../motion.js';
import type { DetailPartProps } from '../parts.js';
import { displayRadii, type Layer } from './layers.js';
import { cutawayTarget, isCutMesh } from './target.js';
import { cutawayLabel, hideCutawayLabels, placeCutawayLabel } from './label-registry.js';
import { useCutawayStore } from './store.js';
import {
  azimuthOf,
  easeOpen,
  faceGeometry,
  labelPoint,
  mixGate,
  spreadVertically,
  stepOpen,
  WEDGE_ANGLE,
  WEDGE_TURN,
  wedgeAbout,
  wedgePlanes,
} from './wedge.js';

/**
 * The cutaway part of the detail view (P6-03; registered as `'cutaway'` in `parts.ts`): with the
 * switch on (`store.ts`), a quarter wedge of the body is cut away, facing the camera, and the two
 * cut faces show the body's layers (`layers.ts`) as flat-coloured concentric bands, each labelled
 * over the canvas (`CutawayLabels`, positioned from here through `label-registry.ts`).
 *
 * **How.** The body's own sphere meshes (the per-kind components' — P6-02's — under the group whose
 * `userData.bodyId` is the body's, a moon's subtree excepted) get two world-space clipping planes
 * with `clipIntersection`, so only the wedge between them is removed; the outer surface keeps its
 * material, maps and eclipse shading. A mesh is cut when its geometry is a `SphereGeometry`, or
 * when it says `userData.cutaway = true`; `userData.cutaway = false` keeps it whole (rings and
 * other geometry are never cut). The faces are two half discs of vertex-coloured triangles (one
 * draw call each, unlit), turned to the planes' azimuths. Materials are re-scanned every frame the
 * cut is open (a body's material may be swapped when its near maps arrive) and given back their
 * planes when it closes or the view is left.
 *
 * **Motion.** The wedge opens and closes over `OPEN_S` (instant with reduced motion), and only once
 * the cross-fade has brought the detail view in (`mixGate`); it follows the camera round the axis.
 */
export function Cutaway({ body, quality, mix }: DetailPartProps) {
  const target = cutawayTarget(body);
  if (!target) return null;
  return (
    <CutawayOf
      bodyId={body.bodyId}
      layers={target.layers}
      radius={target.radius}
      tiltDeg={target.tiltDeg}
      segments={Math.max(32, quality.lod.levels[0]?.planetSegments[1] ?? 32)}
      mix={mix}
    />
  );
}

const DEG = Math.PI / 180;
/** Minimum vertical distance between two labels' centres, CSS pixels. */
const LABEL_GAP = 19;
/** The label's left edge sits this far right of its point (the swatch next to its band). */
const LABEL_OFFSET_PX = 6;

/** What the part writes to each frame, allocated once. */
interface Scratch {
  open: number;
  last: number | undefined;
  planes: [Plane, Plane];
  v: Vector3;
  point: [number, number, number];
  xs: number[];
  ys: number[];
  visible: boolean[];
}

const newScratch = (): Scratch => ({
  open: 0,
  last: undefined,
  planes: [new Plane(), new Plane()],
  v: new Vector3(),
  point: [0, 0, 0],
  xs: [],
  ys: [],
  visible: [],
});

function CutawayOf({
  bodyId,
  layers,
  radius,
  tiltDeg,
  segments,
  mix,
}: {
  bodyId: string;
  layers: readonly Layer[];
  radius: number;
  tiltDeg: number;
  segments: number;
  mix: () => number;
}) {
  const getState = useThree((s) => s.get);
  const invalidate = useThree((s) => s.invalidate);
  const reduced = useReducedMotion();
  const on = useCutawayStore((s) => s.on);
  const root = useRef<Group>(null);
  const frame = useRef<Group>(null);
  const faceA = useRef<Mesh>(null);
  const faceB = useRef<Mesh>(null);
  const radii = useMemo(() => displayRadii(layers), [layers]);
  const scratch = useRef<Scratch | undefined>(undefined);
  const [clipped] = useState(() => new Set<Material>());

  const geometry = useMemo(() => {
    const colors = layers.map((l) => {
      const c = new Color(l.color);
      return [c.r, c.g, c.b] as const;
    });
    const face = faceGeometry(radii, colors, segments);
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(face.positions, 3));
    g.setAttribute('color', new BufferAttribute(face.colors, 3));
    g.computeBoundingSphere();
    return g;
  }, [layers, radii, segments]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  // Material clipping planes need the renderer's local clipping (off by default; costs nothing
  // for materials without planes).
  useEffect(() => {
    const renderer = getState().gl;
    const previous = renderer.localClippingEnabled;
    renderer.localClippingEnabled = true;
    return () => {
      renderer.localClippingEnabled = previous;
    };
  }, [getState]);
  // The switch changed: draw (the on-demand loop of reduced motion renders only when asked).
  useEffect(() => invalidate(), [on, invalidate]);
  useEffect(
    () => () => {
      unclip(clipped);
      hideCutawayLabels();
    },
    [clipped],
  );

  useFrame(({ camera, size }) => {
    const g = frame.current;
    const a = faceA.current;
    const b = faceB.current;
    if (!g || !a || !b) return;
    const s = (scratch.current ??= newScratch());
    const now = performance.now() / 1000;
    const dt = s.last === undefined ? 0 : Math.min(0.1, now - s.last);
    s.last = now;
    const target = on ? 1 : 0;
    s.open = stepOpen(s.open, target, dt, reduced);
    if (s.open !== target) invalidate();
    const shown = easeOpen(s.open) * mixGate(mix());

    if (shown <= 0.001) {
      a.visible = false;
      b.visible = false;
      unclip(clipped);
      hideCutawayLabels();
      return;
    }

    g.updateWorldMatrix(true, false);
    const eye = g.worldToLocal(s.v.copy(camera.position));
    const wedge = wedgeAbout(azimuthOf(eye.x, eye.z) + WEDGE_TURN, WEDGE_ANGLE * shown);
    a.rotation.y = -wedge.a;
    b.rotation.y = -wedge.b;
    a.visible = true;
    b.visible = true;

    const normals = wedgePlanes(wedge);
    for (const [i, plane] of s.planes.entries()) {
      const n = normals[i]!;
      plane.normal.set(n[0], n[1], n[2]);
      plane.constant = 0;
      plane.applyMatrix4(g.matrixWorld);
    }
    const bodyGroup = root.current?.parent ? findBodyGroup(root.current.parent, bodyId) : undefined;
    if (bodyGroup) clipBody(bodyGroup, bodyId, s.planes, clipped);

    // Labels on the cut face drawn further right on screen, so they read away from the body.
    const project = (azimuth: number, outer: number, inner: number) => {
      const p = labelPoint(outer, inner, azimuth, s.point);
      const v = g
        .localToWorld(s.v.set(p[0] * radius, p[1] * radius, p[2] * radius))
        .project(camera);
      return v;
    };
    const right = project(wedge.a, 0.6, 0.4).x >= project(wedge.b, 0.6, 0.4).x ? wedge.a : wedge.b;
    s.xs.length = 0;
    s.ys.length = 0;
    s.visible.length = 0;
    for (const [i, outer] of radii.entries()) {
      const v = project(right, outer, radii[i + 1] ?? 0);
      s.visible.push(v.z > -1 && v.z < 1);
      s.xs.push(((v.x + 1) / 2) * size.width + LABEL_OFFSET_PX);
      s.ys.push(((1 - v.y) / 2) * size.height);
    }
    spreadVertically(s.ys, LABEL_GAP);
    for (const [i] of radii.entries()) {
      const el = cutawayLabel(i);
      if (!el) continue;
      if (s.visible[i]) placeCutawayLabel(el, s.xs[i]!, s.ys[i]!, shown);
      else el.style.visibility = 'hidden';
    }
  }, READ_BODIES);

  return (
    <group ref={root} name="detail-cutaway">
      <group ref={frame} rotation={[0, 0, tiltDeg * DEG]}>
        <mesh ref={faceA} geometry={geometry} scale={radius} visible={false} frustumCulled={false}>
          <meshBasicMaterial vertexColors side={DoubleSide} toneMapped={false} />
        </mesh>
        <mesh ref={faceB} geometry={geometry} scale={radius} visible={false} frustumCulled={false}>
          <meshBasicMaterial vertexColors side={DoubleSide} toneMapped={false} />
        </mesh>
      </group>
    </group>
  );
}

/** The body's own group in the detail frame: the object whose `userData.bodyId` is the body's. */
function findBodyGroup(frame: Object3D, bodyId: string): Object3D | undefined {
  let found: Object3D | undefined;
  frame.traverse((o) => {
    if (!found && o.userData.bodyId === bodyId) found = o;
  });
  return found;
}

/** Gives the body's sphere materials the wedge's planes; another body's subtree (a moon) is skipped. */
function clipBody(group: Object3D, bodyId: string, planes: Plane[], clipped: Set<Material>): void {
  const visit = (o: Object3D) => {
    if (o !== group && typeof o.userData.bodyId === 'string' && o.userData.bodyId !== bodyId)
      return;
    if (isCutMesh(o)) {
      const list = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of list) {
        if (m.clippingPlanes !== planes) m.clippingPlanes = planes;
        m.clipIntersection = true;
        clipped.add(m);
      }
    }
    for (const child of o.children) visit(child);
  };
  visit(group);
}

function unclip(clipped: Set<Material>): void {
  for (const m of clipped) {
    m.clippingPlanes = null;
    m.clipIntersection = false;
  }
  clipped.clear();
}
