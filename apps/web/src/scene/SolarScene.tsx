import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bloom, EffectComposer, Outline, ToneMapping } from '@react-three/postprocessing';
import { ToneMappingMode, type OutlineEffect } from 'postprocessing';
import {
  AdditiveBlending,
  CanvasTexture,
  SRGBColorSpace,
  WebGLRenderer,
  type Camera,
  type Group,
  type Points,
} from 'three';
import { FpsCounter, type FpsSample } from './fps.js';
import { BLOOM_SMOOTHING, contextAntialias, SUN_EMISSIVE, type SceneQuality } from './quality.js';
import { centreOnCamera, generateStarField } from './starfield.js';
import { Bodies } from './bodies/Bodies.js';
import { SUN_ANCHOR_ID } from './anchors.js';
import { attachAnchor } from './anchor-binding.js';
import { motionEnabled, sceneFrameloop, useReducedMotion } from './motion.js';
import { Belt } from './belt/Belt.js';
import { CameraRig } from './camera/CameraRig.js';
import { cappedFrameloop, FrameCap } from './frame-cap.js';
import { Picking } from './picking/Picking.js';
import { LabelProjector } from './labels/LabelProjector.js';
import { MoonMarkers } from './labels/MoonMarkers.js';
import { DECOR_LAYER, showDecor } from './layers.js';
import { Satellites } from './satellites/Satellites.js';
import { Activities } from './satellites/activity/Activities.js';

/**
 * The solar-system scene (P3-01): the R3F canvas on the classic `WebGLRenderer` (decision 20),
 * sRGB output with ACES filmic tone mapping, the star-field skybox and the Sun with bloom, and the
 * wave 2 parts (bodies, belt, camera rig). The panel loads this module lazily (`SceneArea`), so
 * three.js and everything that imports it at runtime (this module and the parts under it) stay
 * out of the panel's first chunk; modules the panel imports directly (`scale.ts`, `motion.ts`,
 * `anchors.ts`, `camera/store.ts`) use type-only three imports.
 *
 * The frame loop is continuous while the decorative orbital motion runs (P3-02) or the fps meter
 * measures; with `prefers-reduced-motion` and no meter it renders on demand (resize, a change).
 * The tier's `shadows` flag turns on the bodies' eclipse shadows (P3-10, `bodies/eclipse.ts`):
 * computed in the bodies' shaders, there is no shadow map.
 *
 * Picking (P3-05) listens on the canvas and draws the hover / selection rings; on tiers with a
 * composer the selected body also gets the outline effect (the composer then runs with
 * `autoClear={false}`, which the outline needs; the render pass still clears).
 *
 * Domain labels (P3-07): the label layer is DOM over the canvas (`SceneArea`); `LabelProjector`
 * places all of it in one throttled pass (`quality.labelHz`), and `MoonMarkers` rings the moons
 * that host an independent project.
 */
export interface SolarSceneProps {
  quality: SceneQuality;
  /** Called about twice a second with the measured frame rate; turns the frame loop continuous. */
  onFps?: (sample: FpsSample & { dpr: number }) => void;
  /** Called when the browser takes the WebGL context away (driver reset, GPU pressure). */
  onContextLost?: () => void;
}

export const SUN_RADIUS = 6;
const BACKGROUND = '#02030a';

/** The selection outline (P3-05): the panel's accent, hidden edges dimmer, no pulse. */
const OUTLINE = { visible: '#7fb2ff', hidden: '#2b4a80', strength: 4 } as const;

export default function SolarScene({ quality, onFps, onContextLost }: SolarSceneProps) {
  // A capped tier (P3-06 `maxFps`, mobile) renders on demand, driven by `FrameCap`.
  const { frameloop, capFps } = cappedFrameloop(
    sceneFrameloop({ motion: motionEnabled(useReducedMotion()), fpsMeter: onFps !== undefined }),
    quality.maxFps,
    onFps !== undefined,
  );
  const outline = useRef<OutlineEffect>(null);
  return (
    <Canvas
      // `antialias` is a context parameter: a tier that changes it gets a new context. With a
      // composer the composer multisamples and the context does not (`contextAntialias`, P3-08).
      key={contextAntialias(quality) ? 'aa' : 'no-aa'}
      gl={(defaults) =>
        new WebGLRenderer({
          ...defaults,
          canvas: defaults.canvas as HTMLCanvasElement,
          antialias: contextAntialias(quality),
          powerPreference: 'high-performance',
        })
      }
      // sRGB output and ACES filmic tone mapping are R3F's defaults (not `flat`, not `linear`).
      dpr={[1, quality.dprCap]}
      // The canvas follows its box; dragging the dock's handle (P4-10) changes that box on every
      // pointer move. Debounced, the renderer and the composer are resized once the drag pauses
      // (the canvas is stretched by CSS meanwhile), not on every frame of it.
      resize={{ debounce: { resize: 50, scroll: 50 } }}
      frameloop={frameloop}
      // No shadow map (P3-10): the Sun is a point light, whose cube shadow magnified an inner
      // planet's shadow over a whole outer planet; the bodies compute their eclipses themselves.
      camera={{ position: [0, 40, 140], fov: 45, near: 0.1, far: 6000 }}
      // The camera sees the decorations' layer too (P3-08, `layers.ts`).
      onCreated={({ camera }) => showDecor(camera)}
    >
      <color attach="background" args={[BACKGROUND]} />
      <ambientLight intensity={0.04} />
      {/* The Sun lights the planets (P3-02); decay 0 so spacing does not change their brightness. */}
      <pointLight position={[0, 0, 0]} intensity={3} decay={0} />
      <StarField count={quality.stars} />
      <Sun glow={quality.bloom === null} />
      {/* Phase 3 wave 2: each task owns its folder; they meet through `anchors.ts`. */}
      <Bodies quality={quality} sunRadius={SUN_RADIUS} />
      <Belt rocks={quality.beltRocks} />
      {/* P4-01: a satellite per live Waykeeper / Steward, on its work's body (`satellites/`). */}
      <Satellites quality={quality} />
      <Activities quality={quality} />
      <CameraRig />
      <Picking outline={quality.bloom ? outline : undefined} />
      <MoonMarkers />
      <LabelProjector hz={quality.labelHz} />
      {quality.bloom && (
        <EffectComposer multisampling={quality.antialias ? 4 : 0} autoClear={false}>
          <Outline
            ref={outline}
            visibleEdgeColor={OUTLINE.visible}
            hiddenEdgeColor={OUTLINE.hidden}
            edgeStrength={OUTLINE.strength}
            xRay
          />
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
      {capFps !== null && <FrameCap fps={capFps} />}
      {onFps && <FpsProbe onFps={onFps} />}
      {onContextLost && <ContextLossWatch onLost={onContextLost} />}
    </Canvas>
  );
}

/**
 * The sky: a shell of points centred on the camera, moved to it just before it is drawn, so the
 * stars surround the viewer at any zoom and in either scale (the true-scale overview sits farther
 * from the Sun than the shell's radius) and show no parallax, like a skybox.
 */
function StarField({ count }: { count: number }) {
  const { positions, colors } = useMemo(() => generateStarField(count), [count]);
  const ref = useRef<Points>(null);
  const follow = useCallback((_gl: unknown, _scene: unknown, camera: Camera) => {
    if (ref.current) centreOnCamera(ref.current, camera);
  }, []);
  return (
    // A new geometry per count: buffer attributes cannot grow in place.
    <points
      key={count}
      ref={ref}
      frustumCulled={false}
      onBeforeRender={follow}
      layers={DECOR_LAYER}
    >
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
