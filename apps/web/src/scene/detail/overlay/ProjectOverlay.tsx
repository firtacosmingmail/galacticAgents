import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useFrame, useThree, type RootState } from '@react-three/fiber';
import {
  AdditiveBlending,
  InstancedBufferAttribute,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
  type BufferAttribute,
  type BufferGeometry,
  type Group,
  type InstancedMesh,
  type LineBasicMaterial,
  type LineSegments,
  type Material,
  type Mesh,
  type PerspectiveCamera,
  type Plane,
} from 'three';
import type { Id } from '@galactic/protocol';
import { sceneWorld, useAppStore } from '../../../state/store.js';
import { getAnchor } from '../../anchors.js';
import { anchorPosition } from '../../camera/store.js';
import { PLACE_OVERLAY, READ_BODIES } from '../../frame-order.js';
import { DECOR_LAYER } from '../../layers.js';
import { motionSeconds, useReducedMotion } from '../../motion.js';
import { pixelScale } from '../../picking/pick.js';
import { occluded } from '../../picking/scene-pick.js';
import { hoveredTask, usePickingStore } from '../../picking/store.js';
import { InstanceList } from '../../satellites/activity/activity-model.js';
import { writeList } from '../../satellites/activity/Activities.js';
import { linearRgb } from '../../satellites/look.js';
import { satelliteFrames, getSatellite } from '../../satellites/registry.js';
import {
  CLAIM_AT,
  clearPlacement,
  setPlacement,
  type PlacementOverride,
} from '../../satellites/placement.js';
import { hashId, seedFraction } from '../../satellites/machine.js';
import type { DetailPartProps } from '../parts.js';
import { cutPlanes } from '../cutaway/cut-planes.js';
import {
  cutAway,
  descent,
  MARKER_SIZE,
  markerBrightness,
  markerLook,
  MAX_MARKERS,
  MAX_STAND_INS,
  moonLinks,
  orbitPoint,
  overlayFooting,
  overlayCapacity,
  overlayMarkers,
  parentPlanetOf,
  sameMarkers,
  selectedTaskOf,
  spinAngle,
  STAND_IN,
  standInCut,
  surfacePoint,
  surfaceSlot,
  type MarkerSpec,
  type Vec3,
} from './overlay-model.js';
import {
  buoyGeometry,
  droneGeometry,
  glowGeometry,
  pinGeometry,
  PIN_HEAD_Y,
  robotGeometry,
  ROBOT_LIGHT_Y,
} from './overlay-mesh.js';
import { publishTaskMarkers, taskMarkerFrames, type TaskMarkerFrame } from './task-registry.js';

/**
 * The project overlay (P6-04; registered as `'project-overlay'` in `parts.ts`): in a planet's or
 * moon's detail view, the project's tasks as **markers** — pins on a surface, buoys in orbit
 * around a gas or ice giant — at deterministic slots (`overlay-model.ts`), clickable (picking reads
 * `task-registry.ts`); the Stewards working on the shown body as **surface robots** or **orbital
 * drones**; **sub-project moons** tied to the planet by a tether, their tasks on them; independent
 * moons keep the scene's teal ring (`MoonMarkers`) and no tether.
 *
 * **Markers.** Two instanced solids (pins, buoys) and one instanced glow (the heads, in the task's
 * state colour, pulsing like the satellites — blinking amber when blocked on the user; plus the
 * stand-ins' lights): at most three draw calls whatever the count, hidden when empty. A surface
 * marker rides the planet's spin like its terrain (the per-kind components' tilt and spin), so it
 * goes round to the far side and back; an orbit marker goes round its ring slowly. Markers are
 * never smaller than `MARKER_SIZE.minPx` on screen, nor larger than `MARKER_SIZE.maxPx` (a buoy or
 * drone passing right in front of the camera would otherwise fill the view). They grow in with the cross-fade.
 *
 * **Highlight.** The panel's selection of a Steward rings its task's marker (the selection's
 * blue); the hovered marker gets the faint white ring, as bodies and satellites do. Rings are
 * drawn over everything but hidden while their marker is behind its body.
 *
 * **Stewards.** A Steward orbiting the shown body whose task has a marker is put down by it
 * (`satellites/placement.ts`): beside the pin as a tracked robot on a rocky planet or moon, just
 * outside the buoy as a drone around a giant. Its satellite frame moves there with the cross-fade
 * (it glides down from its orbit while the view fades in, and back up on the way out); from half
 * way the robot or drone replaces the satellite, in the satellite's state colour (its light
 * pulses with the state). Picking, the hover card and ring, and the Phase 4 activity archetypes
 * (gathering drones, transport shuttles to the Waykeeper, building robots or a platform) all read
 * the frame, so they follow it. A flight, a landing or a landed satellite is never taken over.
 *
 * **Cutaway** (P6-03). Surface markers and robots on the shown body are clipped with the body's
 * own planes (`cutaway/cut-planes.ts`): what stands on the removed wedge goes with the crust, and
 * a marker cut away is not a pick target. Orbit markers and drones are never cut.
 *
 * **Order.** Placement at `PLACE_OVERLAY` (after `PLACE_DETAIL` wrote the frame, before the
 * satellites' director reads the overrides); the stand-ins and rings at `READ_BODIES`, after the
 * director placed the frames.
 */
export function ProjectOverlay({ body, quality, mix }: DetailPartProps) {
  if (body.kind === 'asteroid') return null; // a task's own rock: nothing to overlay
  return <ProjectOverlayOf body={body} quality={quality} mix={mix} />;
}

/** The bodies that host projects: planets and moons. */
type OverlayBody = Exclude<DetailPartProps['body'], { kind: 'asteroid' }>;

function ProjectOverlayOf({
  body,
  quality,
  mix,
}: Omit<DetailPartProps, 'body'> & { body: OverlayBody }) {
  const tasks = useAppStore((s) => sceneWorld(s).tasks);
  const bodies = useAppStore((s) => sceneWorld(s).bodies);
  const projects = useAppStore((s) => sceneWorld(s).projects);
  const agents = useAppStore((s) => sceneWorld(s).agents);
  const selection = useAppStore((s) => s.selection);
  const hovered = usePickingStore((s) => hoveredTask(s.hover));
  const reduced = useReducedMotion();
  const invalidate = useThree((s) => s.invalidate);

  const planetMoons = body.kind === 'moon' ? NO_MOONS : body.planet.moons;
  const links = useMemo(
    () =>
      moonLinks(
        { bodies, projects },
        planetMoons.map((m) => m.bodyId),
      ),
    [bodies, projects, planetMoons],
  );
  const subMoons = useMemo(
    () => links.filter((l) => l.role === 'sub-project').map((l) => l.moonId),
    [links],
  );
  const parentPlanet =
    body.kind === 'moon' ? parentPlanetOf({ bodies, projects }, body.bodyId) : undefined;

  const max = MAX_MARKERS[quality.tier];
  // Only the tasks make markers (agents and statuses change on every turn: not deps).
  const latest = useMemo(
    () => overlayMarkers({ tasks }, body, max, subMoons),
    [tasks, body, max, subMoons],
  );
  // A new list only when what is drawn changes (unrelated world changes keep the old one).
  const [markers, setMarkers] = useState(latest);
  if (markers !== latest && !sameMarkers(markers, latest)) setMarkers(latest);
  const selectedTask = selectedTaskOf({ agents }, selection);

  const simple = quality.tier === 'mobile';
  const shapes = useMemo(
    () => ({
      pin: pinGeometry({ simple }),
      buoy: buoyGeometry({ simple }),
      robot: robotGeometry({ simple }),
      drone: droneGeometry({ simple }),
      glow: glowGeometry(),
    }),
    [simple],
  );
  useEffect(
    () => () => Object.values(shapes).forEach((g: BufferGeometry) => g.dispose()),
    [shapes],
  );
  const materials = useMemo(
    () => ({
      solid: new MeshBasicMaterial({ vertexColors: true }),
      // Robots and pins on the shown body: clipped by the cutaway (orbit pieces never are).
      cutSolid: new MeshBasicMaterial({ vertexColors: true }),
      glow: new MeshBasicMaterial({
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
      cutGlow: new MeshBasicMaterial({
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    }),
    [],
  );
  useEffect(
    () => () => Object.values(materials).forEach((m: Material) => m.dispose()),
    [materials],
  );

  const standIns = MAX_STAND_INS[quality.tier];
  // Sized from the markers (every sub-project moon has up to `max` of its own), in steps.
  const capacity = overlayCapacity(markers, body.bodyId, standIns);
  const { pins: nPins, moonPins: nMoonPins, buoys: nBuoys, glow: nGlow, cutGlow: nCut } = capacity;
  const lists = useMemo(
    () => ({
      pins: new InstanceList(nPins),
      moonPins: new InstanceList(nMoonPins),
      buoys: new InstanceList(nBuoys),
      robots: new InstanceList(standIns),
      drones: new InstanceList(standIns),
      glow: new InstanceList(nGlow),
      cutGlow: new InstanceList(nCut),
    }),
    [nPins, nMoonPins, nBuoys, nGlow, nCut, standIns],
  );
  const listsKey = `${nPins}:${nMoonPins}:${nBuoys}:${nGlow}:${nCut}:${standIns}:${simple}`;

  // The markers as picking sees them: one live frame each, published while mounted.
  const frames = useMemo<TaskMarkerFrame[]>(
    () =>
      markers.map((m) => ({
        taskId: m.taskId,
        bodyId: m.bodyId,
        visible: false,
        center: [0, 0, 0],
        radius: 0,
        occluder: 0,
      })),
    [markers],
  );
  // Published and withdrawn in one layout effect, the withdrawal only of this set: when the detail
  // scene swaps bodies in one commit (`DetailScene` is keyed by the body), the old overlay's
  // cleanup runs before the new one publishes, and never empties the new set afterwards.
  useLayoutEffect(() => {
    publishTaskMarkers(frames);
    invalidate();
    return () => {
      if (taskMarkerFrames() === frames) publishTaskMarkers([]);
    };
  }, [frames, invalidate]);
  useEffect(() => invalidate(), [selectedTask, hovered, invalidate]);

  // Steward stand-ins: one placement override per agent put down (kept across frames).
  const [placed] = useState(() => new Map<Id, PlacementOverride>());
  useEffect(
    () => () => {
      for (const [agentId, o] of placed) clearPlacement(agentId, o);
      placed.clear();
    },
    [placed],
  );

  const root = useRef<Group>(null);
  const pins = useRef<InstancedMesh>(null);
  const moonPins = useRef<InstancedMesh>(null);
  const buoys = useRef<InstancedMesh>(null);
  const robots = useRef<InstancedMesh>(null);
  const drones = useRef<InstancedMesh>(null);
  const glow = useRef<InstancedMesh>(null);
  const cutGlow = useRef<InstancedMesh>(null);
  const selectedRing = useRef<Mesh>(null);
  const hoverRing = useRef<Mesh>(null);
  const tethers = useRef<LineSegments>(null);
  const meshes: Meshes = { pins, moonPins, buoys, robots, drones, glow, cutGlow };
  useLayoutEffect(() => {
    initInstances(
      [pins, moonPins, buoys, robots, drones, glow, cutGlow],
      [
        lists.pins,
        lists.moonPins,
        lists.buoys,
        lists.robots,
        lists.drones,
        lists.glow,
        lists.cutGlow,
      ],
    );
    // The instanced meshes are recreated with the lists and shapes (`key`): this runs for each set.
  }, [lists, shapes]);

  const [scratch] = useState(newScratch);
  const ctx: OverlayCtx = {
    body,
    markers,
    frames,
    lists,
    placed,
    s: scratch,
    materials,
    meshes,
    root,
    selectedRing,
    hoverRing,
    tethers,
    mix,
    reduced,
    agents,
    planetMoons,
    subMoons,
    parentPlanet,
    standIns,
    selectedTask,
    hovered,
    tilt: body.kind === 'moon' ? 0 : (body.planet.look.tiltDeg * Math.PI) / 180,
    surfaceRadius: body.kind === 'moon' ? body.moon.radius : body.planet.radius,
    footing: overlayFooting(body),
  };
  // Placement: markers, the picking frames, the stand-ins' overrides; then, after the director,
  // the stand-ins at their frames, the lights and the highlight rings.
  useFrame((state) => placeMarkers(ctx, state), PLACE_OVERLAY);
  useFrame((state) => drawStandIns(ctx, state), READ_BODIES);

  return (
    <group ref={root} name="detail-project-overlay">
      <group key={listsKey}>
        <instancedMesh
          ref={pins}
          name="overlay-pins"
          args={[shapes.pin, materials.cutSolid, lists.pins.capacity]}
          frustumCulled={false}
          layers={DECOR_LAYER}
          visible={false}
        />
        <instancedMesh
          ref={moonPins}
          name="overlay-moon-pins"
          args={[shapes.pin, materials.solid, lists.moonPins.capacity]}
          frustumCulled={false}
          layers={DECOR_LAYER}
          visible={false}
        />
        <instancedMesh
          ref={buoys}
          name="overlay-buoys"
          args={[shapes.buoy, materials.solid, lists.buoys.capacity]}
          frustumCulled={false}
          layers={DECOR_LAYER}
          visible={false}
        />
        <instancedMesh
          ref={robots}
          name="overlay-robots"
          args={[shapes.robot, materials.cutSolid, lists.robots.capacity]}
          frustumCulled={false}
          layers={DECOR_LAYER}
          visible={false}
        />
        <instancedMesh
          ref={drones}
          name="overlay-drones"
          args={[shapes.drone, materials.solid, lists.drones.capacity]}
          frustumCulled={false}
          layers={DECOR_LAYER}
          visible={false}
        />
        <instancedMesh
          ref={glow}
          name="overlay-glow"
          args={[shapes.glow, materials.glow, lists.glow.capacity]}
          frustumCulled={false}
          layers={DECOR_LAYER}
          visible={false}
        />
        <instancedMesh
          ref={cutGlow}
          name="overlay-cut-glow"
          args={[shapes.glow, materials.cutGlow, lists.cutGlow.capacity]}
          frustumCulled={false}
          layers={DECOR_LAYER}
          visible={false}
        />
      </group>
      <lineSegments
        ref={tethers}
        name="overlay-tethers"
        frustumCulled={false}
        layers={DECOR_LAYER}
        visible={false}
      >
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[scratch.tether, 3]} />
        </bufferGeometry>
        <lineBasicMaterial
          color={TETHER.color}
          transparent
          opacity={0}
          depthWrite={false}
          toneMapped={false}
        />
      </lineSegments>
      <mesh
        ref={selectedRing}
        name="overlay-selected-ring"
        visible={false}
        renderOrder={10}
        frustumCulled={false}
        layers={DECOR_LAYER}
      >
        <ringGeometry args={[0.86, 1, 48]} />
        <meshBasicMaterial
          color="#7fb2ff"
          transparent
          opacity={0.95}
          depthTest={false}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      <mesh
        ref={hoverRing}
        name="overlay-hover-ring"
        visible={false}
        renderOrder={10}
        frustumCulled={false}
        layers={DECOR_LAYER}
      >
        <ringGeometry args={[0.9, 1, 48]} />
        <meshBasicMaterial
          color="#ffffff"
          transparent
          opacity={0.6}
          depthTest={false}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}

/** Everything the frame functions read and write, gathered each render. */
interface OverlayCtx {
  body: OverlayBody;
  markers: readonly MarkerSpec[];
  frames: readonly TaskMarkerFrame[];
  lists: Lists;
  placed: Map<Id, PlacementOverride>;
  s: Scratch;
  materials: Materials;
  meshes: Meshes;
  root: RefObject<Group | null>;
  selectedRing: RefObject<Mesh | null>;
  hoverRing: RefObject<Mesh | null>;
  tethers: RefObject<LineSegments | null>;
  mix: () => number;
  reduced: boolean;
  agents: Readonly<Record<Id, { taskId?: Id | undefined }>>;
  planetMoons: readonly { bodyId: Id; radius: number }[];
  subMoons: readonly Id[];
  parentPlanet: Id | undefined;
  standIns: number;
  selectedTask: Id | undefined;
  hovered: Id | undefined;
  tilt: number;
  surfaceRadius: number;
  footing: 'surface' | 'orbit';
}

type Lists = Record<
  'pins' | 'moonPins' | 'buoys' | 'robots' | 'drones' | 'glow' | 'cutGlow',
  InstanceList
>;
type Meshes = Record<keyof Lists, RefObject<InstancedMesh | null>>;
interface Materials {
  solid: MeshBasicMaterial;
  cutSolid: MeshBasicMaterial;
  glow: MeshBasicMaterial;
  cutGlow: MeshBasicMaterial;
}

/** Instance colours from the start (the material compiles with them), nothing drawn yet. */
function initInstances(
  meshes: readonly RefObject<InstancedMesh | null>[],
  lists: readonly InstanceList[],
): void {
  meshes.forEach((ref, i) => {
    const mesh = ref.current;
    const list = lists[i];
    if (!mesh || !list) return;
    mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(list.capacity * 3), 3);
    mesh.count = 0;
    mesh.visible = false;
  });
}

/** `PLACE_OVERLAY`: the markers, their picking frames, the stand-ins' overrides, the tethers. */
function placeMarkers(ctx: OverlayCtx, state: RootState): void {
  const {
    body,
    markers,
    frames,
    lists,
    placed,
    s,
    materials,
    meshes,
    root,
    tethers,
    mix,
    reduced,
    agents,
    planetMoons,
    subMoons,
    parentPlanet,
    standIns,
    tilt,
    surfaceRadius,
    footing,
  } = ctx;
  const group = root.current;
  if (!group) return;
  group.updateWorldMatrix(true, false);
  s.toLocal.copy(group.matrixWorld).invert();
  const now = motionSeconds();
  const t = reduced ? 0 : now;
  const grow = descent(mix());
  const spin = body.kind === 'moon' ? 0 : spinAngle(now, reduced);
  const camera = state.camera as PerspectiveCamera;
  const pxScale = pixelScale(state.size.height, camera.fov ?? 45);
  const planes = cutPlanes();
  clipWith(materials.cutSolid, planes);
  clipWith(materials.cutGlow, planes);
  lists.pins.count = 0;
  lists.moonPins.count = 0;
  lists.buoys.count = 0;
  lists.glow.count = 0;
  lists.cutGlow.count = 0;
  s.byTask.clear();

  for (let i = 0; i < markers.length; i++) {
    const m = markers[i]!;
    const f = frames[i];
    if (!f) continue;
    const own = m.bodyId === body.bodyId;
    // The marker's body centre (local) and radius: the shown body at the origin, or a moon.
    let r = surfaceRadius;
    s.centre[0] = 0;
    s.centre[1] = 0;
    s.centre[2] = 0;
    if (!own) {
      const moon = planetMoons.find((x) => x.bodyId === m.bodyId);
      const anchor = getAnchor(m.bodyId);
      if (!moon || !anchor) {
        f.visible = false;
        continue;
      }
      anchorPosition(anchor, s.worldAt);
      s.v.set(s.worldAt[0], s.worldAt[1], s.worldAt[2]).applyMatrix4(s.toLocal);
      s.centre[0] = s.v.x;
      s.centre[1] = s.v.y;
      s.centre[2] = s.v.z;
      r = moon.radius;
    }
    const orbit = m.footing === 'orbit';
    if (orbit) {
      orbitPoint(m.slot, tilt, t, body.radius, s.local);
      normalTo(s.local, s.axis);
    } else {
      surfacePoint(surfaceSlot(m.slot, s.dir), tilt, own ? spin : 0, 1, s.axis);
      s.local[0] = s.centre[0] + s.axis[0] * r;
      s.local[1] = s.centre[1] + s.axis[1] * r;
      s.local[2] = s.centre[2] + s.axis[2] * r;
    }
    // World position, for the pixel floor, the cut and picking.
    s.v.set(s.local[0], s.local[1], s.local[2]).applyMatrix4(group.matrixWorld);
    const distance = Math.max(1e-6, camera.position.distanceTo(s.v));
    const perPx = distance / pxScale;
    const look = markerLook(m.state);
    const unit = orbit ? MARKER_SIZE.buoy * body.radius * 2 : MARKER_SIZE.mast * r;
    const size = clampPx(unit, perPx) * look.scale * grow;
    s.worldAt[0] = s.v.x;
    s.worldAt[1] = s.v.y;
    s.worldAt[2] = s.v.z;
    const cut = own && !orbit && cutAway(planes, s.worldAt);
    // Its instances fit (they always should: `overlayCapacity`); a marker not drawn is not picked.
    const solids = orbit ? lists.buoys : own ? lists.pins : lists.moonPins;
    const heads = own && !orbit ? lists.cutGlow : lists.glow;
    const room = solids.count < solids.capacity && heads.count < heads.capacity;
    const shown = size > 1e-6 && !cut && room;
    // The picking frame: a little above the pin's foot (never inside its body), or the buoy.
    f.visible = shown;
    if (shown) {
      const lift = orbit ? 0 : size * 0.6;
      s.w.set(
        s.local[0] + s.axis[0] * lift,
        s.local[1] + s.axis[1] * lift,
        s.local[2] + s.axis[2] * lift,
      );
      s.w.applyMatrix4(group.matrixWorld);
      f.center[0] = s.w.x;
      f.center[1] = s.w.y;
      f.center[2] = s.w.z;
      f.radius = size * 0.6;
      f.occluder = orbit ? body.radius * worldScale(group) : r * worldScale(group);
    }
    s.byTask.set(m.taskId, i);
    s.placedAt[i] ??= {
      local: [0, 0, 0],
      axis: [0, 1, 0],
      centre: [0, 0, 0],
      size: 0,
      shown: false,
    };
    const p = s.placedAt[i]!;
    p.local[0] = s.local[0];
    p.local[1] = s.local[1];
    p.local[2] = s.local[2];
    p.axis[0] = s.axis[0];
    p.axis[1] = s.axis[1];
    p.axis[2] = s.axis[2];
    p.centre[0] = s.centre[0];
    p.centre[1] = s.centre[1];
    p.centre[2] = s.centre[2];
    p.size = size;
    p.shown = shown;
    if (!shown) continue;
    // Instances: the pin or buoy, and its glowing head.
    const glow = heads;
    const level = markerBrightness(look, now, reduced, m.taskId);
    solids.push(s.local, s.axis, size, size, size, SOLID_TINT, 1);
    if (orbit) {
      glow.push(s.local, s.axis, size * 0.7, size * 0.7, size * 0.7, look.color, level * GLOW_GAIN);
    } else {
      s.head[0] = s.local[0] + s.axis[0] * size * PIN_HEAD_Y;
      s.head[1] = s.local[1] + s.axis[1] * size * PIN_HEAD_Y;
      s.head[2] = s.local[2] + s.axis[2] * size * PIN_HEAD_Y;
      const h = size * (MARKER_SIZE.head / MARKER_SIZE.mast) * 0.8;
      glow.push(s.head, s.axis, h, h, h, look.color, level * GLOW_GAIN);
    }
  }
  writeOptional(meshes.pins.current, lists.pins);
  writeOptional(meshes.moonPins.current, lists.moonPins);
  writeOptional(meshes.buoys.current, lists.buoys);

  // Stand-ins: the shown body's orbiting Stewards whose task has a marker.
  const k = descent(mix());
  s.seen.clear();
  let n = 0;
  for (const sf of satelliteFrames()) {
    if (n >= standIns) break;
    if (sf.role !== 'steward' || sf.bodyId !== body.bodyId) continue;
    if (sf.mode === 'flying' || sf.mode === 'landing' || sf.mode === 'landed') continue;
    const taskId = agents[sf.agentId]?.taskId;
    const index = taskId === undefined ? undefined : s.byTask.get(taskId);
    const at = index === undefined ? undefined : s.placedAt[index];
    if (!at || markers[index!]?.bodyId !== body.bodyId) continue;
    let o = placed.get(sf.agentId);
    if (!o) {
      o = { position: [0, 0, 0], k: 0, scale: STAND_IN.frameScale };
      placed.set(sf.agentId, o);
      setPlacement(sf.agentId, o);
    }
    s.seen.add(sf.agentId);
    n++;
    standInPoint(at, footing, sf.agentId, surfaceRadius, body.radius, s.local);
    s.v.set(s.local[0], s.local[1], s.local[2]).applyMatrix4(group.matrixWorld);
    o.position[0] = s.v.x;
    o.position[1] = s.v.y;
    o.position[2] = s.v.z;
    o.k = k;
    // A robot on the cutaway's removed wedge: its frame is hidden from picking, rings, activities.
    o.hidden = standInCut(footing, planes, o.position);
  }
  for (const [agentId, o] of placed) {
    if (s.seen.has(agentId)) continue;
    clearPlacement(agentId, o);
    placed.delete(agentId);
  }

  // Tethers: planet → each sub-project moon; a sub-project moon's own view → its planet.
  writeTethers(tethers.current, s, subMoons, parentPlanet, body, surfaceRadius, grow);
}

/** `READ_BODIES`: the stand-ins at their (claimed) frames, their lights, the highlight rings. */
function drawStandIns(ctx: OverlayCtx, state: RootState): void {
  const { body, lists, placed, s, meshes, root, selectedRing, hoverRing, frames, reduced } = ctx;
  const { selectedTask, hovered, surfaceRadius, footing } = ctx;
  const group = root.current;
  if (!group) return;
  const now = motionSeconds();
  const camera = state.camera as PerspectiveCamera;
  const pxScale = pixelScale(state.size.height, camera.fov ?? 45);
  lists.robots.count = 0;
  lists.drones.count = 0;
  for (const agentId of placed.keys()) {
    const f = getSatellite(agentId);
    if (!f || !f.visible || !f.claimed) continue;
    const o = placed.get(agentId)!;
    // From half way down the model replaces the satellite, growing in.
    const grow = Math.min(1, Math.max(0, (o.k - CLAIM_AT) / (1 - CLAIM_AT)));
    s.v.set(f.position[0], f.position[1], f.position[2]).applyMatrix4(s.toLocal);
    s.local[0] = s.v.x;
    s.local[1] = s.v.y;
    s.local[2] = s.v.z;
    normalTo(s.local, s.axis);
    const robot = footing === 'surface';
    s.v.set(f.position[0], f.position[1], f.position[2]);
    const perPx = Math.max(1e-6, camera.position.distanceTo(s.v)) / pxScale;
    const base = robot ? STAND_IN.robot * surfaceRadius : STAND_IN.drone * body.radius;
    // Scaled by the frame's presence: an ended Steward's robot shrinks away with its satellite.
    const unit = clampPx(base, perPx) * grow * f.presence;
    const busy =
      !reduced && (f.mode === 'gathering' || f.mode === 'building' || f.mode === 'transporting');
    const bob = busy
      ? 1 + 0.12 * Math.abs(Math.sin(now * 5 + seedFraction(hashId(agentId), 3) * 6))
      : 1;
    // A robot stands on its tracks (its frame sits a little above the surface).
    if (robot) {
      const drop = (STAND_IN.lift - 1) * surfaceRadius;
      s.local[0] -= s.axis[0] * drop;
      s.local[1] -= s.axis[1] * drop;
      s.local[2] -= s.axis[2] * drop;
    }
    (robot ? lists.robots : lists.drones).push(
      s.local,
      s.axis,
      unit,
      unit * bob,
      unit,
      SOLID_TINT,
      1,
    );
    const lightY = robot ? ROBOT_LIGHT_Y * unit * bob : -0.2 * unit;
    s.head[0] = s.local[0] + s.axis[0] * lightY;
    s.head[1] = s.local[1] + s.axis[1] * lightY;
    s.head[2] = s.local[2] + s.axis[2] * lightY;
    const rgb = linearRgb(f.tint);
    const l = unit * 0.32;
    (robot ? lists.cutGlow : lists.glow).push(
      s.head,
      s.axis,
      l,
      l,
      l,
      rgb,
      f.brightness * GLOW_GAIN,
    );
  }
  writeOptional(meshes.robots.current, lists.robots);
  writeOptional(meshes.drones.current, lists.drones);
  writeOptional(meshes.glow.current, lists.glow);
  writeOptional(meshes.cutGlow.current, lists.cutGlow);

  // Rings: the selected task's marker (the panel's selection) and the hovered one.
  group.getWorldQuaternion(s.q).invert().multiply(camera.quaternion);
  placeRing(selectedRing.current, selectedTask, s, frames, camera, pxScale, group);
  placeRing(
    hoverRing.current,
    hovered !== selectedTask ? hovered : undefined,
    s,
    frames,
    camera,
    pxScale,
    group,
  );
}

/** A moon's view has no moons of its own (a stable empty list for the memos). */
const NO_MOONS: readonly { bodyId: Id; radius: number }[] = [];

/** The solids' instance colour (their vertex colours carry the shading). */
const SOLID_TINT = [1, 1, 1] as const;
/** The heads glow brighter than the state colour (reaching bloom where there is a composer). */
const GLOW_GAIN = 1.5;
/** Sub-project tethers: the Waykeeper's warm white, faint. */
export const TETHER = { color: '#ffe6b0', opacity: 0.45, maxMoons: 8 } as const;
/** The rings around a highlighted marker: its size × this, at least this many pixels. */
const RING_SCALE = 1.9;
const RING_MIN_PX = 9;

interface Placed {
  local: Vec3;
  axis: Vec3;
  centre: Vec3;
  size: number;
  shown: boolean;
}

function newScratch() {
  return {
    toLocal: new Matrix4(),
    v: new Vector3(),
    w: new Vector3(),
    q: new Quaternion(),
    worldAt: [0, 0, 0] as [number, number, number],
    centre: [0, 0, 0] as Vec3,
    local: [0, 0, 0] as Vec3,
    axis: [0, 1, 0] as Vec3,
    dir: [0, 0, 0] as Vec3,
    head: [0, 0, 0] as Vec3,
    eye: [0, 0, 0] as [number, number, number],
    byTask: new Map<Id, number>(),
    placedAt: [] as Placed[],
    seen: new Set<Id>(),
    tether: new Float32Array(TETHER.maxMoons * 6),
    occluder: [{ bodyId: '', center: [0, 0, 0] as [number, number, number], radius: 0 }],
  };
}
type Scratch = ReturnType<typeof newScratch>;

/** A span (world units) kept between `MARKER_SIZE.minPx` and `maxPx` on screen. */
function clampPx(span: number, perPx: number): number {
  return Math.min(Math.max(span, MARKER_SIZE.minPx * perPx), MARKER_SIZE.maxPx * perPx);
}

/** Unit vector from the origin to `p`, into `out` (+y for the origin). */
function normalTo(p: readonly number[], out: Vec3): void {
  const len = Math.hypot(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0);
  if (len < 1e-9) {
    out[0] = 0;
    out[1] = 1;
    out[2] = 0;
    return;
  }
  out[0] = (p[0] ?? 0) / len;
  out[1] = (p[1] ?? 0) / len;
  out[2] = (p[2] ?? 0) / len;
}

/** The group's world scale (the detail frame copies the anchor's matrix: uniform, usually 1). */
function worldScale(group: Group): number {
  const e = group.matrixWorld.elements;
  return Math.hypot(e[0] ?? 1, e[1] ?? 0, e[2] ?? 0) || 1;
}

/**
 * Where a Steward stands in for its task's marker (local): beside the pin on the surface (turned
 * by a seeded angle about the normal, so two Stewards of one task do not overlap), its frame a
 * little above the ground; or just outside the buoy, in orbit.
 */
function standInPoint(
  at: Placed,
  footing: 'surface' | 'orbit',
  agentId: Id,
  surfaceRadius: number,
  anchorRadius: number,
  out: Vec3,
): void {
  if (footing === 'orbit') {
    const up = STAND_IN.above * anchorRadius;
    out[0] = at.local[0] + at.axis[0] * up;
    out[1] = at.local[1] + at.axis[1] * up;
    out[2] = at.local[2] + at.axis[2] * up;
    return;
  }
  const n = at.axis;
  // A tangent at the pin, turned by a seeded angle.
  const ref = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let t1x = (ref[1] ?? 0) * n[2] - (ref[2] ?? 0) * n[1];
  let t1y = (ref[2] ?? 0) * n[0] - (ref[0] ?? 0) * n[2];
  let t1z = (ref[0] ?? 0) * n[1] - (ref[1] ?? 0) * n[0];
  const l = Math.hypot(t1x, t1y, t1z) || 1;
  t1x /= l;
  t1y /= l;
  t1z /= l;
  const t2x = n[1] * t1z - n[2] * t1y;
  const t2y = n[2] * t1x - n[0] * t1z;
  const t2z = n[0] * t1y - n[1] * t1x;
  const a = 2 * Math.PI * seedFraction(hashId(agentId), 11);
  const c = Math.cos(STAND_IN.beside);
  const sn = Math.sin(STAND_IN.beside);
  const dx = n[0] * c + (t1x * Math.cos(a) + t2x * Math.sin(a)) * sn;
  const dy = n[1] * c + (t1y * Math.cos(a) + t2y * Math.sin(a)) * sn;
  const dz = n[2] * c + (t1z * Math.cos(a) + t2z * Math.sin(a)) * sn;
  const r = STAND_IN.lift * surfaceRadius;
  out[0] = at.centre[0] + dx * r;
  out[1] = at.centre[1] + dy * r;
  out[2] = at.centre[2] + dz * r;
}

/** Gives a material the cutaway's planes (once per change: a change recompiles its program). */
function clipWith(material: Material, planes: readonly Plane[] | undefined): void {
  const want = planes ? (planes as Plane[]) : null;
  if (material.clippingPlanes === want) return;
  material.clippingPlanes = want;
  material.clipIntersection = want !== null;
  material.needsUpdate = true;
}

function writeOptional(mesh: InstancedMesh | null, list: InstanceList): void {
  if (mesh) writeList(mesh, list);
}

/**
 * The tethers (one line segment each, one draw call): in a planet's view from its surface toward
 * each sub-project moon; in a sub-project moon's view from the moon toward its planet. Faded
 * with the cross-fade.
 */
function writeTethers(
  line: LineSegments | null,
  s: Scratch,
  subMoons: readonly Id[],
  parentPlanet: Id | undefined,
  body: OverlayBody,
  surfaceRadius: number,
  grow: number,
): void {
  if (!line) return;
  const group = line.parent;
  let n = 0;
  const segment = (from: number, toCentre: Vector3, toRadius: number) => {
    if (n >= TETHER.maxMoons) return;
    const d = toCentre.length();
    if (d <= from + toRadius) return;
    const ux = toCentre.x / d;
    const uy = toCentre.y / d;
    const uz = toCentre.z / d;
    const a = from * 1.04;
    const b = d - toRadius * 1.3;
    s.tether.set([ux * a, uy * a, uz * a, ux * b, uy * b, uz * b], n * 6);
    n++;
  };
  if (group) {
    if (body.kind !== 'moon') {
      for (const moonId of subMoons) {
        const anchor = getAnchor(moonId);
        const moon = body.planet.moons.find((m) => m.bodyId === moonId);
        if (!anchor || !moon) continue;
        anchorPosition(anchor, s.worldAt);
        s.w.set(s.worldAt[0], s.worldAt[1], s.worldAt[2]).applyMatrix4(s.toLocal);
        segment(surfaceRadius, s.w, moon.radius);
      }
    } else if (parentPlanet) {
      const anchor = getAnchor(parentPlanet);
      if (anchor) {
        anchorPosition(anchor, s.worldAt);
        s.w.set(s.worldAt[0], s.worldAt[1], s.worldAt[2]).applyMatrix4(s.toLocal);
        segment(surfaceRadius, s.w, body.parent.radius);
      }
    }
  }
  const position = line.geometry.getAttribute('position') as BufferAttribute;
  position.needsUpdate = true;
  line.geometry.setDrawRange(0, n * 2);
  const material = line.material as LineBasicMaterial;
  material.opacity = TETHER.opacity * grow;
  line.visible = n > 0 && grow > 0.01;
}

/** A highlight ring at a task's marker (facing the camera), hidden when the marker is not seen. */
function placeRing(
  ring: Mesh | null,
  taskId: Id | undefined,
  s: Scratch,
  frames: readonly TaskMarkerFrame[],
  camera: PerspectiveCamera,
  pxScale: number,
  group: Group,
): void {
  if (!ring) return;
  const index = taskId === undefined ? undefined : s.byTask.get(taskId);
  const f = index === undefined ? undefined : frames[index];
  const at = index === undefined ? undefined : s.placedAt[index];
  if (!f || !at || !f.visible) {
    ring.visible = false;
    return;
  }
  // Behind its body (the far side of the planet): no ring (it is drawn over everything).
  s.w.set(at.centre[0], at.centre[1], at.centre[2]).applyMatrix4(group.matrixWorld);
  const o = s.occluder[0]!;
  o.center[0] = s.w.x;
  o.center[1] = s.w.y;
  o.center[2] = s.w.z;
  o.radius = f.occluder;
  s.eye[0] = camera.position.x;
  s.eye[1] = camera.position.y;
  s.eye[2] = camera.position.z;
  if (occluded(s.eye, f.center, s.occluder)) {
    ring.visible = false;
    return;
  }
  s.v.set(f.center[0], f.center[1], f.center[2]);
  const perPx = Math.max(1e-6, camera.position.distanceTo(s.v)) / pxScale;
  s.v.applyMatrix4(s.toLocal);
  ring.position.copy(s.v);
  ring.quaternion.copy(s.q);
  ring.scale.setScalar(Math.max(f.radius * RING_SCALE, RING_MIN_PX * perPx));
  ring.visible = true;
}
