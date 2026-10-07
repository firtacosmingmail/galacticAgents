import { useLayoutEffect, useMemo, useRef } from 'react';
import { sceneWorld, useAppStore } from '../../state/store.js';
import { selectionBody } from '../picking/body-action.js';
import { usePickingStore } from '../picking/store.js';
import { bodyLabels, markDescription, markText, type BodyLabel } from './label-model.js';
import { registerLabel, updateLabel } from './registry.js';
import './labels.css';

/**
 * The domain labels' DOM (P3-07): one absolutely positioned layer over the canvas holding a label
 * per labelled body (`bodyLabels`: hosted work and its state, "moved to …" markers; reserved and
 * free bodies have none). React renders the content when the world changes — a state change shows
 * on the next render, well within a second — and never the position: the projector inside the
 * canvas (`LabelProjector.tsx`) writes each label's transform and visibility directly. A label
 * starts hidden until the projector places it.
 *
 * The labels take no pointer events (CSS): a wheel, a drag or a click on a label reaches the
 * canvas, and picking (`Picking.tsx`, `labelUnder`) treats a click on a label as a click on its
 * body (P3-05) unless a body is under the pointer; the label of the hovered body is highlighted.
 * The labels are pointer-only extras: not in the tab order (the panel's navigation and the
 * scene's `]` / `[` + `Enter` are the keyboard path), and the layer is `aria-hidden` — the panel
 * carries the same work and states for assistive technology.
 *
 * The deliverables mark (P9-11, decision 133): "◆ n" after the state pill when the work has
 * deliverables declared by an agent or added by the user, "▶" while one of its commands runs
 * (breathing gently; held still under reduced motion). Its box is measured with the label, so picking
 * can tell a click on the mark (select the work and open its Deliverables) from one on the rest.
 *
 * No three.js: this module is in the panel's chunk.
 */
export function LabelLayer() {
  const bodies = useAppStore((s) => sceneWorld(s).bodies);
  const projects = useAppStore((s) => sceneWorld(s).projects);
  const tasks = useAppStore((s) => sceneWorld(s).tasks);
  const deliverables = useAppStore((s) => sceneWorld(s).deliverables);
  const selected = useAppStore((s) => selectionBody(sceneWorld(s), s.selection));
  const hovered = usePickingStore((s) => s.hover?.bodyId);
  const labels = useMemo(
    () => bodyLabels({ bodies, projects, tasks, deliverables }, selected),
    [bodies, projects, tasks, deliverables, selected],
  );
  return (
    <div className="scene-labels" aria-hidden="true">
      {labels.map((label) => (
        <SceneLabel key={label.bodyId} label={label} hovered={label.bodyId === hovered} />
      ))}
    </div>
  );
}

const classes = (label: BodyLabel, hovered: boolean) =>
  [
    'scene-label',
    `tone-${label.tone}`,
    label.selected && 'is-selected',
    hovered && 'is-hovered',
    label.kind === 'moved' && 'is-moved',
    label.moon && `moon-${label.moon}`,
    label.mark && 'has-mark',
  ]
    .filter(Boolean)
    .join(' ');

export function SceneLabel({ label, hovered = false }: { label: BodyLabel; hovered?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const markRef = useRef<HTMLSpanElement>(null);
  const { bodyId, title, stateText, moon, partOf, priority, selected, mark } = label;
  const shownMark = mark ? markText(mark) : undefined;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    return registerLabel({ bodyId, el, priority: 0, w: 0, h: 0 });
  }, [bodyId]);
  // Re-measured only when what it shows changes — not on every world change (`label` is a new
  // object each time): offsetWidth forces a layout. `selected` changes the border, `priority`
  // only the registry entry.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const m = markRef.current;
    updateLabel(bodyId, {
      priority,
      w: el.offsetWidth,
      h: el.offsetHeight,
      mark: m
        ? {
            x: m.offsetLeft + el.clientLeft,
            y: m.offsetTop + el.clientTop,
            w: m.offsetWidth,
            h: m.offsetHeight,
          }
        : undefined,
    });
  }, [bodyId, title, stateText, moon, partOf, priority, selected, shownMark]);

  return (
    <div ref={ref} className={classes(label, hovered)} data-body={bodyId}>
      <span className="scene-label-line">
        <span className="scene-label-title">{label.title}</span>
        <span className="scene-label-state">{label.stateText}</span>
        {mark && (
          <span
            ref={markRef}
            className={mark.running ? 'scene-label-mark is-running' : 'scene-label-mark'}
            aria-label={markDescription(mark)}
            title={markDescription(mark)}
          >
            {shownMark}
          </span>
        )}
      </span>
      {label.moon === 'independent' && <span className="scene-label-own">own project</span>}
      {label.partOf !== undefined && (
        <span className="scene-label-part">↳ part of {label.partOf}</span>
      )}
    </div>
  );
}
