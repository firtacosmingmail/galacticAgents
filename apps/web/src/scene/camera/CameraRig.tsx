import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import type { PerspectiveCamera, Vector3 } from 'three';
import { onAnchorsChanged } from '../anchors.js';
import { PLACE_CAMERA } from '../frame-order.js';
import { useSceneScale } from '../scale.js';
import { CameraDirector } from './director.js';
import type { Pose, Vec3, View } from './flight.js';
import { prefersReducedMotion } from '../motion.js';
import { AnchorWorld, handledOnMount, pendingRequest, useCameraStore } from './store.js';

type Controls = ComponentRef<typeof OrbitControls>;

/** OrbitControls' inertia (lower = longer glide). */
const DAMPING = 0.08;

/**
 * Camera controls and fly-to (P3-04). OrbitControls drag to orbit, right-drag / two fingers to
 * pan and scroll / pinch to zoom, with damping. Flights come from `useCameraStore` (the panel,
 * the breadcrumb, the keyboard, picking later); the `CameraDirector` runs them every frame against
 * the live anchors and this component writes its pose to the camera and the controls' target.
 *
 * The frame loop is continuous while the decorative motion runs and `demand` under reduced
 * motion (`scene/motion.ts`); for the latter, a new request, an anchor change and every frame of a
 * flight call `invalidate()`, and OrbitControls invalidates on user input and while its damping
 * settles.
 *
 * Per frame, a free camera reads no anchor: the world (`AnchorWorld`) reads the focused body's
 * position only while flying to or following it, and keeps the Sun's radius and the system's
 * extent until the anchors or the scale change.
 */
export function CameraRig() {
  const controls = useRef<Controls>(null);
  const [director] = useState(() => new CameraDirector());
  const [world] = useState(() => new AnchorWorld());
  const invalidate = useThree((s) => s.invalidate);
  // A request made before this rig mounted (a previous rig's, now handled or abandoned) is not
  // replayed: the scene hidden and shown, or a tier switch, must not fly to an old body.
  const handled = useRef<number | null>(null);
  if (handled.current === null) handled.current = handledOnMount();
  /** No request handled and no user input yet: the overview follows the bodies as they register. */
  const pristine = useRef(true);
  const snapOverview = useRef(true);

  useEffect(
    () =>
      useCameraStore.subscribe((state, prev) => {
        if (state.request !== prev.request) invalidate();
      }),
    [invalidate],
  );
  useEffect(
    () =>
      onAnchorsChanged(() => {
        world.invalidate();
        if (pristine.current) snapOverview.current = true;
        invalidate();
      }),
    [invalidate, world],
  );
  useEffect(
    () =>
      // The scale toggle moves every body: frame the focused one again, or the new overview.
      useSceneScale.subscribe((state, prev) => {
        if (state.mode === prev.mode) return;
        world.invalidate();
        const cam = useCameraStore.getState();
        if (cam.focusedId) cam.flyTo(cam.focusedId);
        else if (!pristine.current) cam.back();
      }),
    [world],
  );
  useEffect(() => () => useCameraStore.getState().released(), []);

  useFrame((state) => {
    const c = controls.current;
    if (!c) return;
    // The frame state's camera, not a captured one: the frame callback owns its mutation.
    const camera = state.camera as PerspectiveCamera;
    const now = performance.now() / 1000;
    const view: View = {
      fovDeg: camera.fov,
      aspect: state.size.width / Math.max(1, state.size.height),
    };
    const pose: Pose = { position: vec(camera.position), target: vec(c.target) };
    const store = useCameraStore.getState();
    const reduced = prefersReducedMotion();

    const request = pendingRequest(store.request, handled.current ?? 0);
    if (request) {
      handled.current = request.seq;
      pristine.current = false;
      snapOverview.current = false;
      if (request.kind === 'focus') {
        if (director.focus(request.bodyId, pose, view, world, now, reduced)) store.flightStarted();
        else store.released();
      } else {
        director.overview(pose, view, world, now, reduced || request.instant === true);
        store.flightStarted();
      }
    } else if (snapOverview.current && pristine.current) {
      snapOverview.current = false;
      director.overview(pose, view, world, now, true);
    }

    const result = director.step(pose, view, world, now);
    if (!same(result.pose.position, pose.position) || !same(result.pose.target, pose.target)) {
      camera.position.set(...result.pose.position);
      c.target.set(...result.pose.target);
      camera.lookAt(c.target);
    }
    if (result.event === 'arrived') store.arrived();
    else if (result.event === 'overview') store.atOverview();
    else if (result.event === 'left' || result.event === 'lost') store.released();

    const limits = director.limits(result.pose, view, world);
    c.minDistance = limits.minDistance;
    c.maxDistance = limits.maxDistance;
    // A flight owns the camera: no leftover inertia fights it. Reduced motion: no glide at all.
    c.enableDamping = !reduced && director.state !== 'flying';
    const far = Math.max(6000, limits.maxDistance * 2.5);
    if (camera.far < far) {
      camera.far = far;
      camera.updateProjectionMatrix();
    }
    if (result.animating) invalidate();
  }, PLACE_CAMERA); // after the bodies and satellites, before their readers (`frame-order.ts`)

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      dampingFactor={DAMPING}
      onStart={() => {
        pristine.current = false;
        snapOverview.current = false;
        // Grabbing the controls stops a flight where it is; orbit and zoom keep a focus.
        if (director.interrupt()) useCameraStore.getState().released();
      }}
    />
  );
}

function vec(v: Vector3): Vec3 {
  return [v.x, v.y, v.z];
}

function same(a: Vec3, b: Vec3): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}
