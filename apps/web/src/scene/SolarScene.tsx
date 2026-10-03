import { useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bloom, EffectComposer, ToneMapping } from '@react-three/postprocessing';
import { ToneMappingMode } from 'postprocessing';
import { AdditiveBlending, CanvasTexture, SRGBColorSpace, WebGLRenderer, type Group } from 'three';
import { FpsCounter, type FpsSample } from './fps.js';
import { BLOOM_SMOOTHING, SUN_EMISSIVE, type SceneQuality } from './quality.js';
import { generateStarField } from './starfield.js';
import { Bodies } from './bodies/Bodies.js';
import { SUN_ANCHOR_ID } from './anchors.js';
import { attachAnchor } from './bodies/anchor-binding.js';
import { motionEnabled, sceneFrameloop, useReducedMotion } from './bodies/motion.js';
import { Belt } from './belt/Belt.js';
import { CameraRig } from './camera/CameraRig.js';

/**
 * The solar-system scene (P3-01): the R3F canvas on the classic `WebGLRenderer` (decision 20),
 * sRGB output with ACES filmic tone mapping, the star-field skybox and the Sun with bloom. This is
 * the only module of the scene that imports three.js; the panel loads it lazily (`SceneArea`), so
 * three.js stays out of the panel's first chunk and out of jsdom tests.
 *
 * The frame loop is continuous while the decorative orbital motion runs (P3-02) or the fps meter
 * measures; with `prefers-reduced-motion` and no meter it renders on demand (resize, a change).
 * The tier's `shadows` flag turns on the shadow map and the Sun light's shadow (P3-02).
 */
export interface SolarSceneProps {
  quality: SceneQuality;
  /** Called about twice a second with the measured frame rate; turns the frame loop continuous. */
  onFps?: (sample: FpsSample & { dpr: number }) => void;
  /** Called when the browser takes the WebGL context away (driver reset, GPU pressure). */
  onContextLost?: () => void;
}

export const SUN_RADIUS = 6;
/**
 * The Sun light's shadow (P3-02, tiers with `shadows`): one point-light shadow map, PCF filtered,
 * reaching past Neptune's moons in true scale. Its main effect is Saturn's shadow on its rings
 * and moons eclipsed by their planet.
 */
const SHADOW_MAP_SIZE = 1024;
const SHADOW_FAR = 1300;
const BACKGROUND = '#02030a';

export default function SolarScene({ quality, onFps, onContextLost }: SolarSceneProps) {
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
      // sRGB output and ACES filmic tone mapping are R3F's defaults (not `flat`, not `linear`).
      dpr={[1, quality.dprCap]}
      // The shadow map follows `quality.shadows` (PCF, `shadows="percentage"`: three r18x dropped
      // the PCFSoft that `shadows={true}` asks for), together with the Sun light's `castShadow`,
      // so a tier change also changes the lights' state and the materials recompile.
      frameloop={sceneFrameloop({
        motion: motionEnabled(useReducedMotion()),
        fpsMeter: onFps !== undefined,
      })}
      shadows={quality.shadows ? 'percentage' : false}
      camera={{ position: [0, 40, 140], fov: 45, near: 0.1, far: 6000 }}
    >
      <color attach="background" args={[BACKGROUND]} />
      <ambientLight intensity={0.04} />
      {/* The Sun lights the planets (P3-02); decay 0 so spacing does not change their brightness. */}
      <pointLight
        position={[0, 0, 0]}
        intensity={3}
        decay={0}
        castShadow={quality.shadows}
        shadow-mapSize={[SHADOW_MAP_SIZE, SHADOW_MAP_SIZE]}
        shadow-camera-near={SUN_RADIUS}
        shadow-camera-far={SHADOW_FAR}
        shadow-bias={-0.0005}
        shadow-normalBias={0.02}
      />
      <StarField count={quality.stars} />
      <Sun glow={quality.bloom === null} />
      {/* Phase 3 wave 2: each task owns its folder; they meet through `anchors.ts`. */}
      <Bodies />
      <Belt />
      <CameraRig />
      {quality.bloom && (
        <EffectComposer multisampling={quality.antialias ? 4 : 0}>
          <Bloom
            intensity={quality.bloom.intensity}
            luminanceThreshold={quality.bloom.threshold}
            luminanceSmoothing={BLOOM_SMOOTHING}
            mipmapBlur={quality.bloom.mipmapBlur}
          />
          {/* The composer renders without the renderer's tone mapping; it is applied here. */}
          <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
        </EffectComposer>
      )}
      {onFps && <FpsProbe onFps={onFps} />}
      {onContextLost && <ContextLossWatch onLost={onContextLost} />}
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
 * An emissive sphere bright enough (luminance well above the bloom threshold before tone mapping)
 * for the bloom pass to pick up; the stars stay below it. Without bloom (the mobile tier) a sprite
 * with a radial gradient stands in for the glow: one quad, a texture drawn at runtime (no image
 * asset). Registers as the catalogue Sun's anchor (`b-sun`, P3-02).
 */
function Sun({ glow }: { glow: boolean }) {
  const ref = useRef<Group>(null);
  useEffect(
    () => attachAnchor({ bodyId: SUN_ANCHOR_ID, radius: SUN_RADIUS, kind: 'star' }, ref.current),
    [],
  );
  return (
    <group ref={ref} name="sun" userData={{ bodyId: SUN_ANCHOR_ID }}>
      <mesh>
        <sphereGeometry args={[SUN_RADIUS, 64, 32]} />
        <meshStandardMaterial
          color="#000000"
          emissive={SUN_EMISSIVE.color}
          emissiveIntensity={SUN_EMISSIVE.intensity}
        />
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

/**
 * Reports a lost WebGL context. `preventDefault` tells the browser the page handles the loss; the
 * panel then unmounts the scene (list mode with a "Retry", which mounts a fresh canvas). Watches
 * the current canvas, so a canvas recreated for a new tier is watched too; removed on unmount.
 */
function ContextLossWatch({ onLost }: { onLost: () => void }) {
  const canvas = useThree((s) => s.gl.domElement);
  const latest = useRef(onLost);
  useEffect(() => {
    latest.current = onLost;
  });
  useEffect(() => {
    const lost = (event: Event) => {
      event.preventDefault();
      latest.current();
    };
    canvas.addEventListener('webglcontextlost', lost);
    return () => canvas.removeEventListener('webglcontextlost', lost);
  }, [canvas]);
  return null;
}
