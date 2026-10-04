// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Object3D } from 'three';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../../../state/store.js';
import { HARMONIZER } from '../../../state/selection.js';
import { registerAnchor, type BodyAnchor } from '../../anchors.js';
import { CameraBreadcrumb } from '../../camera/Breadcrumb.js';
import { useCameraStore } from '../../camera/store.js';
import { pickingWorld } from '../../picking/fixtures.js';
import { onSceneKey } from '../../SceneArea.js';
import { bindCameraToDetail, useDetailStore } from '../mode.js';
import { CutawayLabels } from './CutawayToggle.js';
import { cutawayLabel, hideCutawayLabels, placeCutawayLabel } from './label-registry.js';
import { CUTAWAY_STORAGE_KEY, useCutawayStore } from './store.js';

/**
 * P6-03 through the DOM (no WebGL): the "Cutaway" toggle in the breadcrumb, its accessibility and
 * session memory, and the layer labels' layer. The bodies are registered anchors.
 */
let unregister: (() => void)[] = [];

function anchor(bodyId: string, kind: BodyAnchor['kind'] = 'planet'): void {
  unregister.push(registerAnchor({ bodyId, kind, object: new Object3D(), radius: 1 }));
}

function Area() {
  return (
    <section tabIndex={0} aria-label="scene" onKeyDown={onSceneKey}>
      <CutawayLabels />
      <CameraBreadcrumb />
    </section>
  );
}

const enter = (bodyId: string) =>
  act(() => void useDetailStore.getState().enter(bodyId, { reducedMotion: true }));
const toggle = () => screen.queryByRole('button', { name: 'Cutaway' });

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  sessionStorage.clear();
  useCutawayStore.setState({ on: false });
  useAppStore.setState({ world: pickingWorld(), route: 'panel', selection: HARMONIZER });
  useCameraStore.setState({ focusedId: undefined, request: undefined, flying: false });
  useDetailStore.getState().reset();
  anchor('b-sun', 'star');
  anchor('b-earth');
  anchor('b-moon', 'moon');
  anchor('b-mars');
  anchor('b-jupiter');
  anchor('b-io', 'moon');
  anchor('b-ast-7', 'asteroid');
  unregister.push(bindCameraToDetail());
});

afterEach(() => {
  cleanup();
  unregister.forEach((u) => u());
  unregister = [];
  useDetailStore.getState().reset();
});

describe('the Cutaway toggle', () => {
  it('appears only in the detail view of a body with layer data', () => {
    render(<Area />);
    act(() => void useCameraStore.getState().flyTo('b-earth'));
    expect(screen.getByRole('button', { name: 'Detail view' })).toBeTruthy();
    expect(toggle()).toBeNull(); // the system view
    enter('b-earth');
    expect(toggle()).toBeTruthy();
    enter('b-jupiter');
    expect(toggle()).toBeTruthy(); // a gas giant
    enter('b-moon');
    expect(toggle()).toBeTruthy();
    for (const id of ['b-io', 'b-ast-7']) {
      enter(id);
      expect(useDetailStore.getState().mode).toEqual({ kind: 'detail', bodyId: id });
      expect(toggle(), id).toBeNull();
    }
    act(() => void useDetailStore.getState().exit());
    expect(toggle()).toBeNull();
  });

  it('is a pressed/unpressed button in the tab order, described by the layers it shows', () => {
    render(<Area />);
    enter('b-earth');
    const button = toggle()!;
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.getAttribute('tabindex')).toBeNull();
    button.focus();
    expect(document.activeElement).toBe(button);
    const description = document.getElementById(button.getAttribute('aria-describedby')!)!;
    expect(description.textContent).toMatch(
      /^Earth's layers, from the surface inward: crust .*mantle .*outer core .*inner core/,
    );
    fireEvent.click(button);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(useCutawayStore.getState().on).toBe(true);
    fireEvent.click(button);
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('Enter on the focused toggle does not reach the scene (no select, no detail change)', () => {
    render(<Area />);
    enter('b-earth');
    const button = toggle()!;
    button.focus();
    fireEvent.keyDown(button, { key: 'Enter' });
    expect(useDetailStore.getState().mode).toEqual({ kind: 'detail', bodyId: 'b-earth' });
    expect(useAppStore.getState().selection).toBe(HARMONIZER);
  });

  it('is remembered for the session, across bodies', () => {
    render(<Area />);
    enter('b-earth');
    fireEvent.click(toggle()!);
    expect(sessionStorage.getItem(CUTAWAY_STORAGE_KEY)).toBe('on');
    enter('b-jupiter');
    expect(toggle()!.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(toggle()!);
    expect(sessionStorage.getItem(CUTAWAY_STORAGE_KEY)).toBeNull();
  });
});

describe('the layer labels', () => {
  it('one hidden, aria-hidden label per layer while the cutaway is on; none otherwise', () => {
    const { container } = render(<Area />);
    enter('b-jupiter');
    expect(container.querySelector('.scene-cutaway-labels')).toBeNull();
    act(() => useCutawayStore.getState().setOn(true));
    const layer = container.querySelector('.scene-cutaway-labels')!;
    expect(layer.getAttribute('aria-hidden')).toBe('true');
    const labels = [...layer.querySelectorAll('.scene-cutaway-label')];
    expect(labels.map((l) => l.textContent)).toEqual([
      'Molecular hydrogen',
      'Metallic hydrogen',
      'Core',
    ]);
    // Registered for the canvas part to position; hidden until placed.
    expect(cutawayLabel(0)).toBe(labels[0]);
    placeCutawayLabel(cutawayLabel(1)!, 10, 20, 0.5);
    expect((labels[1] as HTMLElement).style.visibility).toBe('visible');
    expect((labels[1] as HTMLElement).style.transform).toContain('translate3d(10.0px, 20.0px, 0)');
    hideCutawayLabels();
    expect((labels[1] as HTMLElement).style.visibility).toBe('hidden');
    enter('b-io');
    expect(container.querySelector('.scene-cutaway-labels')).toBeNull();
    expect(cutawayLabel(0)).toBeUndefined();
  });
});
