import { useLayoutEffect, useRef } from 'react';
import { sceneWorld, useAppStore } from '../../../state/store.js';
import { useDetailStore } from '../mode.js';
import { cutawayLayers, layersDescription, type Layer } from './layers.js';
import { registerCutawayLabel } from './label-registry.js';
import { useCutawayStore } from './store.js';
import './cutaway.css';

/**
 * The cutaway's DOM (P6-03; no three.js — this is in the panel's chunk): the toggle in the
 * scene's breadcrumb and the layer labels over the canvas. Both exist only in the detail view of
 * a body with layer data (`layers.ts`); the switch itself is session-wide (`store.ts`).
 */

/** The detail view's body when it has layer data: its name and layers. */
export function useCutawayTarget():
  { bodyId: string; name: string; layers: readonly Layer[] } | undefined {
  const mode = useDetailStore((s) => s.mode);
  const body = useAppStore((s) =>
    mode.kind === 'detail' ? sceneWorld(s).bodies[mode.bodyId] : undefined,
  );
  const layers = cutawayLayers(body);
  return body && layers ? { bodyId: body.id, name: body.name, layers } : undefined;
}

/**
 * "Cutaway" after the breadcrumb's trail in a detail view (where "Detail view" stood before going
 * in): a toggle button (`aria-pressed`), in the tab order like the crumbs (decision 81), described
 * for screen readers by the list of layers it shows. Renders nothing elsewhere.
 */
export function CutawayToggle() {
  const target = useCutawayTarget();
  const on = useCutawayStore((s) => s.on);
  const toggle = useCutawayStore((s) => s.toggle);
  if (!target) return null;
  const descriptionId = `cutaway-desc-${target.bodyId}`;
  return (
    <li className="pnl-scene-crumbs-action">
      <button
        type="button"
        aria-pressed={on}
        aria-describedby={descriptionId}
        onClick={toggle}
        title={on ? `Close ${target.name}'s cutaway` : `Cut ${target.name} open to show its layers`}
      >
        Cutaway
      </button>
      <span id={descriptionId} className="pnl-visually-hidden">
        {layersDescription(target.name, target.layers)}
      </span>
    </li>
  );
}

/**
 * The layer labels over the canvas: one per band, positioned by the cutaway part inside the canvas
 * (`label-registry.ts`); hidden until it places them. Paint-only and `aria-hidden` (the toggle's
 * description carries the same names), like the domain labels.
 */
export function CutawayLabels() {
  const target = useCutawayTarget();
  const on = useCutawayStore((s) => s.on);
  if (!target || !on) return null;
  return (
    <div className="scene-cutaway-labels" aria-hidden="true" data-body={target.bodyId}>
      {target.layers.map((layer, i) => (
        <CutawayLabel key={`${target.bodyId}:${i}`} index={i} layer={layer} />
      ))}
    </div>
  );
}

function CutawayLabel({ index, layer }: { index: number; layer: Layer }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    return el ? registerCutawayLabel(index, el) : undefined;
  }, [index]);
  return (
    <div ref={ref} className="scene-cutaway-label">
      <span className="scene-cutaway-swatch" style={{ background: layer.color }} />
      {layer.name}
    </div>
  );
}
