import { useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Bloom, EffectComposer, ToneMapping } from '@react-three/postprocessing';
import { ToneMappingMode } from 'postprocessing';
import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  CanvasTexture,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three';
import { FpsCounter, type FpsSample } from './fps.js';
import type { SceneQuality } from './quality.js';
import { generateStarField } from './starfield.js';

/**
 * The solar-system scene (P3-01): the R3F canvas on the classic `WebGLRenderer` (decision 20),
 * sRGB output with ACES filmic tone mapping, the star-field skybox and the Sun with bloom. This is
 * the only module of the scene that imports three.js; the panel loads it lazily (`SceneArea`), so
 * three.js stays out of the panel's first chunk and out of jsdom tests.
 *
 * Nothing moves yet, so the canvas renders on demand (resize, a setting change); the fps meter
 * switches it to a continuous loop so the meter measures a real frame rate.
 */
export interface SolarSceneProps {
  quality: SceneQuality;
  /** Called about twice a second with the measured frame rate; turns the frame loop continuous. */
  onFps?: (sample: FpsSample & { dpr: number }) => void;
}

export const SUN_RADIUS = 6;
const BACKGROUND = '#02030a';

export default function SolarScene({ quality, onFps }: SolarSceneProps) {
  return (
    <Canvas
      // `antialias` is a context parameter: a tier that changes it gets a new context.
      key={quality.antialias ? 'aa' : 'no-aa'}
      gl={(defaults) =>
        new WebGLRenderer({
          ...defaults,
          canvas: defaults.canvas as HTMLCanvasElement,
          antialias: quality.antialias,
          powerPreference: 'high-performance',
        })
      }
      onCreated={({ gl }) => {
        gl.outputColorSpace = SRGBColorSpace;
        gl.toneMapping = ACESFilmicToneMapping;
      }}
      dpr={[1, quality.dprCap]}
      // PCF: three r18x dropped PCFSoftShadowMap, which R3F's `shadows={true}` asks for.
      shadows={quality.shadows ? 'percentage' : false}
      frameloop={onFps ? 'always' : 'demand'}
      camera={{ position: [0, 40, 140], fov: 45, near: 0.1, far: 6000 }}
    >
      <color attach="background" args={[BACKGROUND]} />
      <ambientLight intensity={0.04} />
      {/* The Sun lights the planets (P3-02); decay 0 so spacing does not change their brightness. */}
      <pointLight position={[0, 0, 0]} intensity={3} decay={0} castShadow={quality.shadows} />
      <StarField count={quality.stars} />
      <Sun glow={quality.bloom === null} />
      {quality.bloom && (
        <EffectComposer multisampling={quality.antialias ? 4 : 0}>
          <Bloom
            intensity={quality.bloom.intensity}
            luminanceThreshold={quality.bloom.threshold}
            luminanceSmoothing={0.2}
            mipmapBlur={quality.bloom.mipmapBlur}
          />
          {/* The composer renders without the renderer's tone mapping; it is applied here. */}
          <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
        </EffectComposer>
      )}
      {onFps && <FpsProbe onFps={onFps} />}
    </Canvas>
  );
}

function StarField({ count }: { count: number }) {
  const { positions, colors } = useMemo(() => generateStarField(count), [count]);
  return (
    // A new geometry per count: buffer attributes cannot grow in place.
    <points key={count} frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[colors, 3]} />
      </bufferGeometry>
      <pointsMaterial
        vertexColors
        size={1.6}
        sizeAttenuation={false}
        depthWrite={false}
        toneMapped={false}
      />
    </points>
  );
}

/**
 * An emissive sphere bright enough (well above 1 before tone mapping) for the bloom pass to pick
 * up. Without bloom (the mobile tier) a sprite with a radial gradient stands in for the glow: one
 * quad, a texture drawn at runtime (no image asset).
 */
function Sun({ glow }: { glow: boolean }) {
  return (
    <group name="sun">
      <mesh>
        <sphereGeometry args={[SUN_RADIUS, 64, 32]} />
        <meshStandardMaterial color="#000000" emissive="#ffa630" emissiveIntensity={3.2} />
      </mesh>
      {glow && <SunGlow />}
    </group>
  );
}

function SunGlow() {
  const texture = useMemo(() => {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      g.addColorStop(0, 'rgba(255, 200, 120, 1)');
      g.addColorStop(0.25, 'rgba(255, 150, 50, 0.55)');
      g.addColorStop(0.6, 'rgba(255, 110, 20, 0.12)');
      g.addColorStop(1, 'rgba(255, 90, 0, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
    }
    const t = new CanvasTexture(canvas);
    t.colorSpace = SRGBColorSpace;
    return t;
  }, []);
  useEffect(() => () => texture.dispose(), [texture]);
  return (
    <sprite scale={SUN_RADIUS * 6}>
      <spriteMaterial
        map={texture}
        blending={AdditiveBlending}
        depthWrite={false}
        transparent
        toneMapped={false}
      />
    </sprite>
  );
}

function FpsProbe({ onFps }: { onFps: NonNullable<SolarSceneProps['onFps']> }) {
  const counter = useRef(new FpsCounter());
  useFrame((state) => {
    const sample = counter.current.tick(performance.now());
    if (sample) onFps({ ...sample, dpr: state.viewport.dpr });
  });
  return null;
}
