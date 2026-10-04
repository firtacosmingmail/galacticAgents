import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import {
  AdditiveBlending,
  Color,
  type BufferGeometry,
  type Mesh,
  type MeshBasicMaterial,
} from 'three';
import type { AgentState, Id } from '@galactic/protocol';
import { DECOR_LAYER } from '../../layers.js';
import type { SatelliteFrame } from '../director.js';
import { beamColor, beamMatrix, bodyColor, bodyMatrix } from '../satellite-mesh.js';
import { hqCoreGeometry, hqRingGeometry, hqRingMatrix } from './hq-mesh.js';
import { hqClaimed, hqFrame, hqRingSpeed, RingSpin } from './hq-model.js';

/**
 * The Harmonizer's HQ station (P4-02): its core, its turning ring and its beam (shown while it
 * scans Earth, like any working agent's satellite). Matrices and colours are written by the
 * satellites' frame loop (`writeHq`, called from `Satellites.tsx` right after the director's
 * update), so the station is never a frame behind its own published frame (picking, hover card).
 * Three draw calls at most (two between scans). On `DECOR_LAYER` like the satellites.
 * In Earth's detail view the core and ring give way to the detailed station (P6-05,
 * `detail/earth-hq/`, `claimHqStation`); only the beam is still drawn here then.
 */
export class HqTargets {
  core: Mesh | null = null;
  ring: Mesh | null = null;
  beam: Mesh | null = null;
  readonly spin = new RingSpin();
  register(core: Mesh | null, ring: Mesh | null, beam: Mesh | null): () => void {
    this.core = core;
    this.ring = ring;
    this.beam = beam;
    return () => {
      if (this.core === core) this.core = null;
      if (this.ring === ring) this.ring = null;
      if (this.beam === beam) this.beam = null;
    };
  }
}

const color = new Color();

/** Writes the HQ's frame (if any) into its meshes; `state` is the Harmonizer's agent state. */
export function writeHq(
  frames: readonly SatelliteFrame[],
  targets: HqTargets,
  options: { bloom: boolean; now: number; reducedMotion: boolean; state: AgentState | undefined },
): void {
  const { core, ring, beam } = targets;
  const f = hqFrame(frames);
  if (!f || !core || !ring) return;
  // P6-05: Earth's detail station draws the HQ while it is shown (`claimHqStation`); the beam
  // stays drawn here.
  const drawn = f.visible && !hqClaimed();
  core.visible = drawn;
  ring.visible = drawn;
  if (beam) beam.visible = f.visible && f.beam > 0;
  if (!f.visible) return;
  bodyMatrix(f, core.matrix);
  core.matrixWorldNeedsUpdate = true;
  const speed = options.state ? hqRingSpeed(options.state, options.reducedMotion) : 0;
  hqRingMatrix(core.matrix, targets.spin.advance(options.now, speed), ring.matrix);
  ring.matrixWorldNeedsUpdate = true;
  bodyColor(f, color);
  (core.material as MeshBasicMaterial).color.copy(color);
  (ring.material as MeshBasicMaterial).color.copy(color);
  if (beam?.visible) {
    beamMatrix(f, beam.matrix);
    beam.matrixWorldNeedsUpdate = true;
    (beam.material as MeshBasicMaterial).color.copy(beamColor(f, options.bloom, color));
  }
}

export function HqStation({
  agentId,
  beamShape,
  targets,
}: {
  agentId: Id;
  beamShape: BufferGeometry;
  targets: HqTargets;
}) {
  const shapes = useMemo(() => ({ core: hqCoreGeometry(), ring: hqRingGeometry() }), []);
  useEffect(() => () => Object.values(shapes).forEach((g) => g.dispose()), [shapes]);
  const core = useRef<Mesh>(null);
  const ring = useRef<Mesh>(null);
  const beam = useRef<Mesh>(null);
  useLayoutEffect(
    () => targets.register(core.current, ring.current, beam.current),
    [agentId, targets],
  );
  return (
    <group name="hq-station">
      <mesh
        ref={core}
        name={`hq:${agentId}`}
        geometry={shapes.core}
        matrixAutoUpdate={false}
        visible={false}
        layers={DECOR_LAYER}
        userData={{ agentId }}
      >
        <meshBasicMaterial vertexColors toneMapped />
      </mesh>
      <mesh
        ref={ring}
        name={`hq-ring:${agentId}`}
        geometry={shapes.ring}
        matrixAutoUpdate={false}
        visible={false}
        layers={DECOR_LAYER}
      >
        <meshBasicMaterial vertexColors toneMapped />
      </mesh>
      <mesh
        ref={beam}
        name={`hq-beam:${agentId}`}
        geometry={beamShape}
        matrixAutoUpdate={false}
        visible={false}
        layers={DECOR_LAYER}
      >
        <meshBasicMaterial
          vertexColors
          transparent
          blending={AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}
