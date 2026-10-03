import { useLayoutEffect, useState } from 'react';
import { Vector4, type Object3D, type WebGLProgramParametersWithUniforms } from 'three';
import { MAX_ECLIPSE_CASTERS, patchEclipseShader, type EclipseReceiver } from './eclipse.js';

/**
 * The three.js side of the eclipse shadows (P3-10, rules and shader in `eclipse.ts`): one
 * `EclipseSystem` per planet knows where its casters' meshes are; each receiving mesh fills its
 * material's uniforms from it just before it is drawn (`onBeforeRender`: every world matrix is
 * up to date then, whatever order the orbit callbacks ran in).
 */
export class EclipseSystem {
  private readonly meshes = new Map<string, Object3D>();

  /** Registers a caster's mesh (or forgets it, with `null`); returns the cleanup. */
  register(bodyId: string, mesh: Object3D | null): () => void {
    if (!mesh) return () => {};
    this.meshes.set(bodyId, mesh);
    return () => {
      if (this.meshes.get(bodyId) === mesh) this.meshes.delete(bodyId);
    };
  }

  get(bodyId: string): Object3D | undefined {
    return this.meshes.get(bodyId);
  }
}

/** Every patched material shares one program (the patch does not depend on the receiver). */
const cacheKey = () => 'eclipse-p3-10';

/** Logged once per page: a failed patch would otherwise log on every material compile. */
let warnedPatchFailure = false;

export interface EclipseInputs {
  system: EclipseSystem;
  receiver: EclipseReceiver | undefined;
  enabled: boolean;
  sunRadius: number;
}

/**
 * One receiver's uniforms and callbacks. They stay the same objects for the receiver's life: a
 * compiled material keeps the uniforms it was given (a level-of-detail material swap compiles
 * again and gets the same ones); the inputs are read when the mesh is drawn.
 */
export class EclipseBinding {
  readonly uniforms = {
    eclipseCasters: {
      value: Array.from({ length: MAX_ECLIPSE_CASTERS }, () => new Vector4()),
    },
    eclipseCount: { value: 0 },
    eclipseSunRadius: { value: 0 },
  };
  private inputs: EclipseInputs | undefined;

  update(inputs: EclipseInputs): void {
    this.inputs = inputs;
    this.uniforms.eclipseSunRadius.value = inputs.sunRadius;
  }

  /** For the material: adds the uniforms and patches the shader. */
  readonly onBeforeCompile = (shader: WebGLProgramParametersWithUniforms): void => {
    Object.assign(shader.uniforms, this.uniforms);
    // This runs inside `renderer.render`, in R3F's frame loop, where a throw never reaches the
    // scene's error boundary and repeats every frame. If three renamed an anchor chunk (the unit
    // test fails loudly on that), draw the body without eclipses rather than break the scene.
    try {
      const patched = patchEclipseShader(shader.vertexShader, shader.fragmentShader);
      shader.vertexShader = patched.vertexShader;
      shader.fragmentShader = patched.fragmentShader;
    } catch (error) {
      if (!warnedPatchFailure) {
        warnedPatchFailure = true;
        console.error('Eclipse shading disabled: could not patch the shader.', error);
      }
    }
  };

  readonly customProgramCacheKey = cacheKey;

  /** For the mesh: writes the casters' current world positions and radii into the uniforms. */
  readonly onBeforeRender = (): void => {
    const inputs = this.inputs;
    let n = 0;
    if (inputs?.enabled && inputs.receiver) {
      for (const c of inputs.receiver.casters) {
        const mesh = inputs.system.get(c.bodyId);
        if (!mesh || n >= MAX_ECLIPSE_CASTERS) continue;
        const e = mesh.matrixWorld.elements;
        this.uniforms.eclipseCasters.value[n]!.set(e[12]!, e[13]!, e[14]!, c.radius);
        n++;
      }
    }
    this.uniforms.eclipseCount.value = n;
  };
}

/**
 * The binding of one receiver. `enabled` follows the tier's `shadows`: off, the count is 0 and the
 * shader's loop does nothing (no recompile when the tier changes).
 */
export function useEclipse(
  system: EclipseSystem,
  receiver: EclipseReceiver | undefined,
  enabled: boolean,
  sunRadius: number,
): EclipseBinding {
  const [binding] = useState(() => new EclipseBinding());
  useLayoutEffect(
    () => binding.update({ system, receiver, enabled, sunRadius }),
    [binding, system, receiver, enabled, sunRadius],
  );
  return binding;
}
