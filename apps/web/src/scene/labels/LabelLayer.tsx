import { useLayoutEffect, useMemo, useRef, type MouseEvent } from 'react';
import { useAppStore } from '../../state/store.js';
import { selectionBody } from '../picking/body-action.js';
import { activateBody } from '../picking/store.js';
import { bodyLabels, type BodyLabel } from './label-model.js';
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
 * Clicking a label does what clicking its body does (`activateBody`, P3-05). The labels are not
 * in the tab order (the panel's navigation and the scene's `]` / `[` + `Enter` are the keyboard
 * path), and the layer is hidden from assistive technology, which reads the same work in the panel.
 *
 * No three.js: this module is in the panel's chunk.
 */
export function LabelLayer() {
  const bodies = useAppStore((s) => s.world.bodies);
  const projects = useAppStore((s) => s.world.projects);
  const tasks = useAppStore((s) => s.world.tasks);
  const selected = useAppStore((s) => selectionBody(s.world, s.selection));
  const labels = useMemo(
    () => bodyLabels({ bodies, projects, tasks }, selected),
    [bodies, projects, tasks, selected],
  );
  return (
    <div className="scene-labels" aria-hidden="true">
      {labels.map((label) => (
        <SceneLabel key={label.bodyId} label={label} />
      ))}
    </div>
  );
}

const classes = (label: BodyLabel) =>
  [
    'scene-label',
    `tone-${label.tone}`,
    label.selected && 'is-selected',
    label.kind === 'moved' && 'is-moved',
    label.moon && `moon-${label.moon}`,
  ]
    .filter(Boolean)
    .join(' ');

export function SceneLabel({ label }: { label: BodyLabel }) {
  const ref = useRef<HTMLDivElement>(null);
  const { bodyId, title, stateText, moon, partOf, priority, selected } = label;
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
    updateLabel(bodyId, { priority, w: el.offsetWidth, h: el.offsetHeight });
  }, [bodyId, title, stateText, moon, partOf, priority, selected]);

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const area = event.currentTarget.offsetParent?.getBoundingClientRect();
    activateBody(bodyId, {
      x: event.clientX - (area?.left ?? 0),
      y: event.clientY - (area?.top ?? 0),
    });
  };

  return (
    <div
      ref={ref}
      className={classes(label)}
      data-body={bodyId}
      title={tooltip(label)}
      onClick={onClick}
    >
      <span className="scene-label-line">
        <span className="scene-label-title">{label.title}</span>
        <span className="scene-label-state">{label.stateText}</span>
      </span>
      {label.moon === 'independent' && <span className="scene-label-own">own project</span>}
      {label.partOf !== undefined && (
        <span className="scene-label-part">↳ part of {label.partOf}</span>
      )}
    </div>
  );
}

function tooltip(label: BodyLabel): string {
  const extra =
    label.moon === 'independent'
      ? ' · a project of its own'
      : label.partOf !== undefined
        ? ` · sub-project of ${label.partOf}`
        : '';
  return `${label.fullTitle} · ${label.stateText}${extra}`;
}
