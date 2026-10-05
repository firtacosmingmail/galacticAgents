// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { BufferGeometry } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent, Body, Project, Task } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { emptyWorld } from '../../../state/reduce.js';
import { useAppStore } from '../../../state/store.js';
import { HARMONIZER } from '../../../state/selection.js';
import { useCameraStore } from '../../camera/store.js';
import { QUALITY_TIERS } from '../../quality.js';
import { hoveredBody, hoveredTask, usePickingStore } from '../../picking/store.js';
import { resolveDetailBody } from '../detail-body.js';

/*
 * P6-04 in the DOM: the overlay part publishes one picking frame per task while mounted and
 * frees everything on unmount; a click on a marker selects the task's Steward (the panel's rule)
 * or shows what the task is; a task hover names the task without hovering its body.
 */

vi.mock('@react-three/fiber', () => ({
  useFrame: () => {},
  useThree: (select: (s: unknown) => unknown) => select({ invalidate: () => {} }),
}));

const { ProjectOverlay } = await import('./ProjectOverlay.js');
const { taskMarkerFrames } = await import('./task-registry.js');
const { activateTask } = await import('./activate.js');

const bodies: Record<string, Body> = {
  'b-mars': {
    id: 'b-mars',
    kind: 'planet',
    name: 'Mars',
    meta: { orbit: 4 },
    host: { kind: 'project', id: 'p-mars' },
  },
  'b-venus': {
    id: 'b-venus',
    kind: 'planet',
    name: 'Venus',
    meta: { orbit: 2 },
    host: { kind: 'project', id: 'p-venus' },
  },
  'b-ast-7': {
    id: 'b-ast-7',
    kind: 'asteroid',
    name: '7 Iris',
    host: { kind: 'task', id: 't-ast' },
    meta: { number: 7 },
  },
};
const project: Project = { ...fx.project, id: 'p-mars', name: 'CSV tool', bodyId: 'b-mars' };
const venusProject: Project = { ...fx.project, id: 'p-venus', name: 'Docs', bodyId: 'b-venus' };
const task = (id: string, n: number): Task => ({
  ...fx.task,
  id,
  projectId: 'p-mars',
  bodyId: 'b-mars',
  description: `Task ${id}`,
  createdAt: `2026-10-01T10:0${n}:00.000Z`,
});
const steward: Agent = { ...fx.agent, id: 'a-s1', taskId: 't-1', bodyId: 'b-mars' };

function seed() {
  useAppStore.setState({
    world: {
      ...emptyWorld(),
      bodies,
      projects: { 'p-mars': project, 'p-venus': venusProject },
      tasks: {
        't-1': task('t-1', 1),
        't-2': task('t-2', 2),
        't-v': { ...task('t-v', 3), projectId: 'p-venus', bodyId: 'b-venus' },
      },
      agents: { 'a-s1': steward },
      statuses: { 'a-s1': { ...fx.status, agentId: 'a-s1' } },
    },
    selection: HARMONIZER,
  });
}

const mars = () => resolveDetailBody(bodies, 'b-mars', 'fake')!;
const venus = () => resolveDetailBody(bodies, 'b-venus', 'fake')!;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  usePickingStore.setState({ hover: undefined, popover: undefined });
  window.history.replaceState(null, '', '/');
});

describe('the ProjectOverlay part', () => {
  it('publishes a picking frame per task while mounted (StrictMode too), none after', () => {
    seed();
    const dispose = vi.spyOn(BufferGeometry.prototype, 'dispose');
    const view = render(
      <StrictMode>
        <ProjectOverlay body={mars()} quality={QUALITY_TIERS.high} mix={() => 1} />
      </StrictMode>,
    );
    expect(taskMarkerFrames().map((f) => f.taskId)).toEqual(['t-1', 't-2']);
    expect(view.container.querySelector('[name="overlay-pins"]')).not.toBeNull();
    expect(view.container.querySelector('[name="overlay-selected-ring"]')).not.toBeNull();
    dispose.mockClear();
    view.unmount();
    expect(taskMarkerFrames()).toEqual([]);
    expect(dispose.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it('a body swap in one commit keeps the new body’s frames (the old cleanup runs first)', () => {
    seed();
    // `DetailScene` is keyed by the body: one commit unmounts Mars's overlay and mounts Venus's.
    const view = render(
      <ProjectOverlay key="b-mars" body={mars()} quality={QUALITY_TIERS.high} mix={() => 1} />,
    );
    expect(taskMarkerFrames().map((f) => f.taskId)).toEqual(['t-1', 't-2']);
    view.rerender(
      <ProjectOverlay key="b-venus" body={venus()} quality={QUALITY_TIERS.high} mix={() => 1} />,
    );
    expect(taskMarkerFrames().map((f) => f.taskId)).toEqual(['t-v']);
    view.unmount();
    expect(taskMarkerFrames()).toEqual([]);
  });

  it('a new task adds a frame; the mobile tier mounts too; an asteroid draws nothing', () => {
    seed();
    const view = render(
      <ProjectOverlay body={mars()} quality={QUALITY_TIERS.mobile} mix={() => 1} />,
    );
    useAppStore.setState((s) => ({
      world: { ...s.world, tasks: { ...s.world.tasks, 't-3': task('t-3', 3) } },
    }));
    view.rerender(<ProjectOverlay body={mars()} quality={QUALITY_TIERS.mobile} mix={() => 1} />);
    expect(taskMarkerFrames().map((f) => f.taskId)).toEqual(['t-1', 't-2', 't-3']);
    view.unmount();
    const rock = resolveDetailBody(bodies, 'b-ast-7', 'fake')!;
    const none = render(<ProjectOverlay body={rock} quality={QUALITY_TIERS.high} mix={() => 1} />);
    expect(none.container.innerHTML).toBe('');
  });
});

describe('clicking a task marker (activateTask)', () => {
  it('selects the task’s Steward, flies to its body and updates the URL', () => {
    seed();
    const flyTo = vi.spyOn(useCameraStore.getState(), 'flyTo');
    expect(activateTask('t-1', { x: 10, y: 10 })).toBe(true);
    expect(useAppStore.getState().selection).toEqual({ kind: 'steward', id: 'a-s1' });
    expect(window.location.pathname).toBe('/steward/a-s1');
    expect(flyTo).toHaveBeenCalledWith('b-mars');
    expect(usePickingStore.getState().popover).toBeUndefined();
  });

  it('a task no Steward has started selects nothing and shows what it is', () => {
    seed();
    expect(activateTask('t-2', { x: 10, y: 20 })).toBe(false);
    expect(useAppStore.getState().selection).toEqual(HARMONIZER);
    const popover = usePickingStore.getState().popover;
    expect(popover?.kind).toBe('info');
    if (popover?.kind !== 'info') return;
    expect(popover.action.name).toBe('Task on Mars');
    expect(popover.action.detail).toContain('Task t-2');
    expect(popover.action.detail).toContain('no Steward yet');
    expect(activateTask('t-unknown', { x: 0, y: 0 })).toBe(false);
  });
});

describe('a task hover', () => {
  it('names the task and hovers no body; the same hover is not re-set', () => {
    const picking = usePickingStore.getState();
    picking.setHover({ kind: 'task', taskId: 't-1', name: 'Task t-1 · in progress', others: 0 });
    const first = usePickingStore.getState().hover;
    expect(hoveredTask(first)).toBe('t-1');
    expect(hoveredBody(first)).toBeUndefined();
    picking.setHover({ kind: 'task', taskId: 't-1', name: 'Task t-1 · in progress', others: 0 });
    expect(usePickingStore.getState().hover).toBe(first);
    picking.setHover({ bodyId: 'b-mars', name: 'Mars', others: 0 });
    expect(hoveredTask(usePickingStore.getState().hover)).toBeUndefined();
  });
});
