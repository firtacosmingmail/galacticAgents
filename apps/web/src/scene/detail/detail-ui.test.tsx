// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Object3D } from 'three';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../../state/store.js';
import { HARMONIZER, selectionKey } from '../../state/selection.js';
import { registerAnchor, type BodyAnchor } from '../anchors.js';
import { CameraBreadcrumb } from '../camera/Breadcrumb.js';
import { useCameraStore } from '../camera/store.js';
import { pickingWorld } from '../picking/fixtures.js';
import { PickingOverlay } from '../picking/PickingOverlay.js';
import { activateBody, usePickingStore } from '../picking/store.js';
import { onSceneKey } from '../SceneArea.js';
import { bindCameraToDetail, DETAIL_FRAME_RADII, useDetailStore } from './mode.js';

/**
 * P6-01 through the DOM (no WebGL): the scene area's keys, the breadcrumb and picking with the
 * detail view's store; the bodies are registered anchors, the camera is its store.
 */
let unregister: (() => void)[] = [];

function anchor(bodyId: string, kind: BodyAnchor['kind'] = 'planet'): void {
  unregister.push(registerAnchor({ bodyId, kind, object: new Object3D(), radius: 1 }));
}

const selected = () => selectionKey(useAppStore.getState().selection);
const camera = () => useCameraStore.getState();
const detail = () => useDetailStore.getState();

function Area() {
  return (
    <section tabIndex={0} aria-label="scene" onKeyDown={onSceneKey}>
      <CameraBreadcrumb />
    </section>
  );
}

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  useAppStore.setState({ world: pickingWorld(), route: 'panel', selection: HARMONIZER });
  usePickingStore.setState({ hover: undefined, popover: undefined });
  useCameraStore.setState({
    focusedId: undefined,
    request: undefined,
    flying: false,
    atSystem: false,
  });
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

describe('Enter: select, then go in', () => {
  it('the first Enter selects (P5-01); the second, which would change nothing, enters', () => {
    render(<Area />);
    act(() => void camera().flyTo('b-jupiter'));
    const area = screen.getByRole('region', { name: 'scene' });
    fireEvent.keyDown(area, { key: 'Enter' });
    expect(selected()).toBe('waykeeper:a-wk-old');
    expect(detail().mode.kind).toBe('system');
    fireEvent.keyDown(area, { key: 'Enter' });
    expect(detail().mode).toEqual({ kind: 'detail', bodyId: 'b-jupiter' });
    expect(selected()).toBe('waykeeper:a-wk-old');
    expect(camera().request).toMatchObject({ bodyId: 'b-jupiter', radii: DETAIL_FRAME_RADII });
  });

  it('a body without an agent: the first Enter shows its card, the second closes it and enters', () => {
    render(
      <>
        <Area />
        <PickingOverlay />
      </>,
    );
    act(() => void camera().flyTo('b-mars'));
    const area = screen.getByRole('region', { name: 'scene' });
    fireEvent.keyDown(area, { key: 'Enter' });
    expect(screen.getByRole('dialog', { name: 'Mars' })).toBeTruthy();
    fireEvent.keyDown(area, { key: 'Enter' });
    expect(screen.queryByRole('dialog', { name: 'Mars' })).toBeNull();
    expect(detail().mode).toEqual({ kind: 'detail', bodyId: 'b-mars' });
  });

  it('the Sun has no detail view: Enter keeps showing its card', () => {
    render(
      <>
        <Area />
        <PickingOverlay />
      </>,
    );
    act(() => void camera().flyTo('b-sun'));
    const area = screen.getByRole('region', { name: 'scene' });
    fireEvent.keyDown(area, { key: 'Enter' });
    fireEvent.keyDown(area, { key: 'Enter' });
    expect(detail().mode.kind).toBe('system');
    expect(screen.getByRole('dialog', { name: 'Sun' })).toBeTruthy();
  });
});

describe('Escape unwinds: popover → detail view → camera body → selection → system', () => {
  it('leaves the detail view first, back to the system framing on the body', () => {
    window.history.replaceState(null, '', '/steward/a-st');
    useAppStore.setState({ selection: { kind: 'steward', id: 'a-st' } });
    render(<Area />);
    act(() => void detail().enter('b-ast-7'));
    act(() => usePickingStore.getState().showHere({ x: 1, y: 1 }, ['b-ast-7']));
    const area = screen.getByRole('region', { name: 'scene' });

    fireEvent.keyDown(area, { key: 'Escape' }); // the popover
    expect(usePickingStore.getState().popover).toBeUndefined();
    expect(detail().mode.kind).toBe('detail');

    fireEvent.keyDown(area, { key: 'Escape' }); // the detail view
    expect(detail().mode.kind).toBe('system');
    expect(camera().focusedId).toBe('b-ast-7');
    expect(camera().request).toMatchObject({ kind: 'focus', bodyId: 'b-ast-7' });
    expect(camera().request).not.toHaveProperty('radii');
    expect(selected()).toBe('steward:a-st');

    fireEvent.keyDown(area, { key: 'Escape' }); // the camera's body
    expect(camera().focusedId).toBeUndefined();
    expect(selected()).toBe('steward:a-st');

    fireEvent.keyDown(area, { key: 'Escape' }); // the selection
    expect(selected()).toBe('harmonizer');
  });

  it('Home leaves the detail view and goes to the whole system', () => {
    render(<Area />);
    act(() => void detail().enter('b-jupiter'));
    fireEvent.keyDown(screen.getByRole('region', { name: 'scene' }), { key: 'Home' });
    expect(detail().mode.kind).toBe('system');
    expect(camera().request).toMatchObject({ kind: 'overview' });
  });

  it('] / [ leave it for the next body', () => {
    render(<Area />);
    act(() => void detail().enter('b-jupiter'));
    fireEvent.keyDown(screen.getByRole('region', { name: 'scene' }), { key: ']' });
    expect(detail().mode.kind).toBe('system');
    expect(camera().focusedId).not.toBe('b-jupiter');
  });
});

describe('breadcrumb', () => {
  const nav = () => screen.getByRole('navigation', { name: 'scene location' });

  it('offers "Detail view" on a planet, moon or asteroid, never on the Sun or the overview', () => {
    render(<Area />);
    expect(screen.queryByRole('button', { name: 'Detail view' })).toBeNull();
    act(() => void camera().flyTo('b-sun'));
    expect(screen.queryByRole('button', { name: 'Detail view' })).toBeNull();
    for (const id of ['b-jupiter', 'b-io', 'b-ast-7']) {
      act(() => void camera().flyTo(id));
      expect(screen.getByRole('button', { name: 'Detail view' })).toBeTruthy();
    }
  });

  it('enters; shows "Solar system › Jupiter › Io › Detail"; the body crumb leaves the view', () => {
    render(<Area />);
    act(() => void camera().flyTo('b-io'));
    fireEvent.click(screen.getByRole('button', { name: 'Detail view' }));
    expect(detail().mode).toEqual({ kind: 'detail', bodyId: 'b-io' });
    expect(nav().textContent).toBe('Solar systemJupiterIoDetail');
    expect(screen.getByText('Detail').getAttribute('aria-current')).toBe('location');
    expect(screen.queryByRole('button', { name: 'Detail view' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Io' }));
    expect(detail().mode.kind).toBe('system');
    expect(camera().focusedId).toBe('b-io');
    expect(nav().textContent).toBe('Solar systemJupiterIoDetail view');
  });

  it("the planet's crumb flies to the planet (and leaves the moon's view)", () => {
    render(<Area />);
    act(() => void detail().enter('b-io'));
    fireEvent.click(screen.getByRole('button', { name: 'Jupiter' }));
    expect(detail().mode.kind).toBe('system');
    expect(camera().focusedId).toBe('b-jupiter');
  });

  it('"Solar system" leaves it for the whole system', () => {
    render(<Area />);
    act(() => void detail().enter('b-jupiter'));
    fireEvent.click(screen.getByRole('button', { name: 'Solar system' }));
    expect(detail().mode.kind).toBe('system');
    expect(camera().request).toMatchObject({ kind: 'overview' });
  });
});

describe('selection persists across the transition', () => {
  it('entering and leaving never changes the selection or the URL', () => {
    window.history.replaceState(null, '', '/waykeeper/a-wk-old');
    useAppStore.setState({ selection: { kind: 'waykeeper', id: 'a-wk-old' } });
    render(<Area />);
    act(() => void camera().flyTo('b-jupiter'));
    fireEvent.click(screen.getByRole('button', { name: 'Detail view' }));
    expect(selected()).toBe('waykeeper:a-wk-old');
    fireEvent.keyDown(screen.getByRole('region', { name: 'scene' }), { key: 'Escape' });
    expect(selected()).toBe('waykeeper:a-wk-old');
    expect(window.location.pathname).toBe('/waykeeper/a-wk-old');
  });

  it("a click on the view's body selects without flying out; a click on a moon goes to the moon", () => {
    render(<Area />);
    act(() => void detail().enter('b-jupiter'));
    act(() => void activateBody('b-jupiter', { x: 0, y: 0 }));
    expect(selected()).toBe('waykeeper:a-wk-old');
    expect(detail().mode.kind).toBe('detail');
    expect(camera().request).toMatchObject({ bodyId: 'b-jupiter', radii: DETAIL_FRAME_RADII });

    act(() => void activateBody('b-ast-7', { x: 0, y: 0 }));
    expect(selected()).toBe('steward:a-st');
    expect(detail().mode.kind).toBe('system');
    expect(camera().focusedId).toBe('b-ast-7');
  });

  it("a selection in the panel of the view body's agent keeps the view", () => {
    render(<Area />);
    act(() => void detail().enter('b-jupiter'));
    // What the panel → scene sync does: fly to the selected agent's body.
    act(() => void camera().flyTo('b-jupiter'));
    expect(detail().mode.kind).toBe('detail');
  });
});
