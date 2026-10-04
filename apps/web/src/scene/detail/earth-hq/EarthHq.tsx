import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  AdditiveBlending,
  Color,
  Matrix4,
  Quaternion,
  Vector3,
  type Group,
  type Mesh,
  type MeshBasicMaterial,
} from 'three';
import type { AgentState } from '@galactic/protocol';
import { sceneWorld, useAppStore } from '../../../state/store.js';
import { getAnchor } from '../../anchors.js';
import { READ_BODIES } from '../../frame-order.js';
import { DECOR_LAYER } from '../../layers.js';
import { motionSeconds, useReducedMotion } from '../../motion.js';
import type { SatelliteFrame } from '../../satellites/director.js';
import { claimHqStation, hqFrame, RingSpin } from '../../satellites/hq/hq-model.js';
import { BEAM } from '../../satellites/look.js';
import { satelliteFrames } from '../../satellites/registry.js';
import { bodyColor, bodyMatrix } from '../../satellites/satellite-mesh.js';
import type { DetailPartProps } from '../parts.js';
import {
  EARTH_HQ_GLOW_CENTER,
  EARTH_HQ_GLOW_RADIUS,
  earthHqCoreGeometry,
  earthHqNavGeometry,
  earthHqRingGeometry,
  earthHqStrobeGeometry,
  glowGeometry,
  type StationDetail,
} from './earth-hq-mesh.js';
import {
  glowLevel,
  navLevel,
  restingPose,
  STATION,
  stationLook,
  strobeLevel,
  type StationLook,
} from './earth-hq-model.js';

/**
 * Earth's HQ station in the detail view (P6-05; SPEC decisions 72, 82, 84): the `'earth-hq'` part
 * (`parts.ts`), mounted in Earth's frame while Earth is shown in detail. While mounted it claims
 * the HQ (`claimHqStation`): the system station's core and ring are hidden, so there is never a
 * double HQ, and this one is drawn in their place — at the Harmonizer's satellite frame, written
 * by the satellites' loop just before (`PLACE_SATELLITES` < `READ_BODIES`), with its size and
 * state colour (`bodyColor`). The frame stays published, so picking, the hover card and the
 * click (select the Harmonizer, open its chat: `activateSatellite`) are the system HQ's, and the
 * system HQ still draws the beam when the Harmonizer scans Earth.
 *
 * Its look (`stationLook`): the habitat ring turns fast while the Harmonizer thinks, slowly while
 * idle or waiting, not at all when halted; red/green navigation lights blink and a white strobe
 * double-flashes; a cyan glow breathes around the node while it thinks. Waiting for the user is
 * the state colour's amber blink, as for every satellite. With no Harmonizer there is no frame:
 * the station rests dark at `restingPose`, unlit and still (the dock offers Restart, decision 82).
 * Under reduced motion nothing turns, blinks or breathes (the lights and the glow are steady:
 * thinking still reads by the glow and the brightness). The glow and lights fade in with the
 * cross-fade.
 *
 * Draw calls: core, ring, navigation lights, strobe (4), plus the glow while thinking (5). The
 * mobile tier draws a simpler model (`simple`) and no glow. Everything is disposed on unmount.
 */
export function EarthHq({ body, quality, mix }: DetailPartProps) {
  const simple = quality.tier === 'mobile';
  const detail: StationDetail = useMemo(() => ({ simple }), [simple]);
  const shapes = useMemo(
    () => ({
      core: earthHqCoreGeometry(detail),
      ring: earthHqRingGeometry(detail),
      nav: earthHqNavGeometry(detail),
      strobe: earthHqStrobeGeometry(detail),
      glow: glowGeometry(),
    }),
    [detail],
  );
  useEffect(() => () => Object.values(shapes).forEach((g) => g.dispose()), [shapes]);
  useLayoutEffect(() => claimHqStation(), []);
  const reducedMotion = useReducedMotion();
  const bloom = quality.bloom !== null;

  const [targets] = useState(() => new EarthHqTargets());
  const station = useRef<Group>(null);
  const ring = useRef<Mesh>(null);
  const core = useRef<Mesh>(null);
  const nav = useRef<Mesh>(null);
  const strobe = useRef<Mesh>(null);
  const glow = useRef<Mesh>(null);
  useLayoutEffect(
    () =>
      targets.register({
        station: station.current,
        core: core.current,
        ring: ring.current,
        nav: nav.current,
        strobe: strobe.current,
        glow: simple ? null : glow.current,
      }),
    [targets, simple],
  );

  useFrame((state) => {
    const anchor = getAnchor(body.bodyId);
    if (!anchor) return;
    const frame = hqFrame(satelliteFrames());
    const statuses = sceneWorld(useAppStore.getState()).statuses;
    writeEarthHq(targets, {
      frame,
      state: frame ? statuses[frame.agentId]?.state : undefined,
      anchor: anchor.object.matrixWorld,
      radius: body.radius,
      cameraQuaternion: state.camera.quaternion,
      now: motionSeconds(),
      mix: mix(),
      reducedMotion,
      bloom,
    });
  }, READ_BODIES);

  return (
    <group name="earth-hq">
      <group ref={station} name="earth-hq-station" matrixAutoUpdate={false} visible={false}>
        <mesh
          ref={core}
          name="earth-hq-core"
          geometry={shapes.core}
          layers={DECOR_LAYER}
          frustumCulled={false}
        >
          <meshBasicMaterial vertexColors toneMapped />
        </mesh>
        <mesh
          ref={ring}
          name="earth-hq-ring"
          geometry={shapes.ring}
          matrixAutoUpdate={false}
          layers={DECOR_LAYER}
          frustumCulled={false}
        >
          <meshBasicMaterial vertexColors toneMapped />
        </mesh>
        <mesh
          ref={nav}
          name="earth-hq-nav"
          geometry={shapes.nav}
          layers={DECOR_LAYER}
          frustumCulled={false}
        >
          <meshBasicMaterial vertexColors toneMapped={false} />
        </mesh>
        <mesh
          ref={strobe}
          name="earth-hq-strobe"
          geometry={shapes.strobe}
          layers={DECOR_LAYER}
          frustumCulled={false}
        >
          <meshBasicMaterial vertexColors toneMapped={false} />
        </mesh>
      </group>
      {!simple && (
        <mesh
          ref={glow}
          name="earth-hq-glow"
          geometry={shapes.glow}
          matrixAutoUpdate={false}
          visible={false}
          layers={DECOR_LAYER}
          frustumCulled={false}
          renderOrder={1}
        >
          <meshBasicMaterial
            vertexColors
            transparent
            blending={AdditiveBlending}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
      )}
    </group>
  );
}

interface StationObjects {
  station: Group | null;
  core: Mesh | null;
  ring: Mesh | null;
  nav: Mesh | null;
  strobe: Mesh | null;
  glow: Mesh | null;
}

/** Where `writeEarthHq` writes: the station's objects, and its ring's integrated angle. */
export class EarthHqTargets implements StationObjects {
  station: Group | null = null;
  core: Mesh | null = null;
  ring: Mesh | null = null;
  nav: Mesh | null = null;
  strobe: Mesh | null = null;
  glow: Mesh | null = null;
  readonly spin = new RingSpin();
  /** The look last written (for tests and the cache below). */
  look: StationLook | undefined;
  private lookKey = '';
  register(objects: StationObjects): () => void {
    Object.assign(this, objects);
    return () => {
      if (this.station === objects.station) Object.assign(this, EMPTY);
    };
  }
  /** The look for a state, recomputed only when the state or the motion preference changes. */
  lookFor(state: AgentState | undefined, reducedMotion: boolean): StationLook {
    const key = `${state ?? '-'}:${reducedMotion}`;
    if (!this.look || key !== this.lookKey) {
      this.look = stationLook(state, reducedMotion);
      this.lookKey = key;
    }
    return this.look;
  }
}

const EMPTY: StationObjects = {
  station: null,
  core: null,
  ring: null,
  nav: null,
  strobe: null,
  glow: null,
};

export interface EarthHqInput {
  /** The Harmonizer's satellite frame (`undefined`: none running). */
  frame: SatelliteFrame | undefined;
  /** The Harmonizer's state (`undefined` without a frame). */
  state: AgentState | undefined;
  /** Earth's anchor world matrix: the detail frame the station is drawn in. */
  anchor: Matrix4;
  /** Earth's visual radius (the resting pose). */
  radius: number;
  cameraQuaternion: Quaternion;
  /** Motion seconds. */
  now: number;
  /** The cross-fade (0 system … 1 detail): the lights and the glow fade in with it. */
  mix: number;
  reducedMotion: boolean;
  bloom: boolean;
}

const inverse = new Matrix4();
const world = new Matrix4();
const spinMatrix = new Matrix4();
const glowMatrix = new Matrix4();
const pos = new Vector3();
const quat = new Quaternion();
const scale = new Vector3();
const anchorQuat = new Quaternion();
const glowPos = new Vector3();
const color = new Color();
const darkColor = new Color(STATION.dark).multiplyScalar(STATION.darkBrightness);
const DOWN = new Vector3(0, -1, 0);
const toCentre = new Vector3();

/** Writes the station's pose, colours, ring, lights and glow for this frame. Pure but for `targets`. */
export function writeEarthHq(targets: EarthHqTargets, input: EarthHqInput): void {
  const { station, core, ring, nav, strobe, glow } = targets;
  if (!station || !core || !ring) return;
  const look = targets.lookFor(input.frame ? input.state : undefined, input.reducedMotion);
  // The pose, in Earth's frame: the Harmonizer's frame, else the resting place.
  inverse.copy(input.anchor).invert();
  if (input.frame) {
    if (!input.frame.visible) {
      station.visible = false;
      if (glow) glow.visible = false;
      return;
    }
    station.matrix.multiplyMatrices(inverse, bodyMatrix(input.frame, world));
  } else {
    const rest = restingPose(input.radius);
    pos.set(...rest.position);
    toCentre.copy(pos).negate().normalize();
    quat.setFromUnitVectors(DOWN, toCentre);
    station.matrix.compose(pos, quat, scale.setScalar(rest.size));
  }
  station.visible = true;
  station.matrixWorldNeedsUpdate = true;

  // Hull colour: the state's tint and pulse (amber blink while waiting), or dark.
  if (input.frame && !look.dark) bodyColor(input.frame, color);
  else color.copy(darkColor);
  (core.material as MeshBasicMaterial).color.copy(color);
  (ring.material as MeshBasicMaterial).color.copy(color);
  ring.matrix.copy(spinMatrix.makeRotationY(targets.spin.advance(input.now, look.ringSpin)));
  ring.matrixWorldNeedsUpdate = true;

  const fade = Math.min(1, Math.max(0, input.mix));
  if (nav) {
    const level = navLevel(look, input.now) * fade;
    nav.visible = level > 0;
    (nav.material as MeshBasicMaterial).color.setScalar(level);
  }
  if (strobe) {
    const level = strobeLevel(look, input.now) * fade;
    strobe.visible = level > 0;
    (strobe.material as MeshBasicMaterial).color.setScalar(level);
  }
  if (glow) {
    const level = glowLevel(look, input.now) * fade;
    glow.visible = level > 0;
    if (glow.visible) {
      // At the node, facing the camera (a billboard in Earth's frame), at the station's scale.
      glowPos.set(...EARTH_HQ_GLOW_CENTER).applyMatrix4(station.matrix);
      input.anchor.decompose(pos, anchorQuat, scale);
      quat.copy(anchorQuat).invert().multiply(input.cameraQuaternion);
      station.matrix.decompose(pos, anchorQuat, scale);
      glowMatrix.compose(glowPos, quat, scale.multiplyScalar(EARTH_HQ_GLOW_RADIUS));
      glow.matrix.copy(glowMatrix);
      glow.matrixWorldNeedsUpdate = true;
      const gain = (input.bloom ? 0.7 : 0.4) * level;
      (glow.material as MeshBasicMaterial).color.setRGB(
        BEAM.color[0] * gain,
        BEAM.color[1] * gain,
        BEAM.color[2] * gain,
      );
    }
  }
}
