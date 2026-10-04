// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Object3D } from 'three';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Body } from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import { registerAnchor, SUN_ANCHOR_ID } from '../anchors.js';
import { onSceneKey } from '../SceneArea.js';
import { CameraBreadcrumb } from './Breadcrumb.js';
import { sceneKeyAction } from './keys.js';
import { useCameraStore } from './store.js';

function anchor(bodyId: string, kind: 'star' | 'planet' | 'moon', x: number) {
  const object = new Object3D();
  object.position.set(x, 0, 0);
  return registerAnchor({ bodyId, kind, object, radius: 1 });
}

const bodies: Record<string, Body> = {
  'b-jupiter': { id: 'b-jupiter', kind: 'planet', name: 'Jupiter' },
  'b-europa': { id: 'b-europa', kind: 'moon', name: 'Europa', parentId: 'b-jupiter' },
};

let unregister: (() => void)[] = [];

beforeEach(() => {
  unregister = [
    anchor('b-jupiter', 'planet', 100),
    anchor('b-europa', 'moon', 104),
    anchor(SUN_ANCHOR_ID, 'star', 0),
  ];
  useCameraStore.setState({
    focusedId: undefined,
    flying: false,
    request: undefined,
    atSystem: false,
  });
  const s = useAppStore.getState();
  useAppStore.setState({ world: { ...s.world, bodies: { ...s.world.bodies, ...bodies } } });
});
afterEach(() => {
  cleanup();
  unregister.forEach((u) => u());
});

describe('keyboard shortcuts', () => {
  it('maps ] [ Escape Home and nothing else', () => {
    expect(sceneKeyAction({ key: ']' })).toBe('next');
    expect(sceneKeyAction({ key: '[' })).toBe('previous');
    expect(sceneKeyAction({ key: 'Escape' })).toBe('back');
    expect(sceneKeyAction({ key: 'Home' })).toBe('back');
    expect(sceneKeyAction({ key: 'ArrowRight' })).toBeUndefined();
    expect(sceneKeyAction({ key: 'a' })).toBeUndefined();
  });

  it('ignores modified keys, composition and typing in a field', () => {
    expect(sceneKeyAction({ key: ']', ctrlKey: true })).toBeUndefined();
    expect(sceneKeyAction({ key: ']', metaKey: true })).toBeUndefined();
    expect(sceneKeyAction({ key: ']', altKey: true })).toBeUndefined();
    expect(sceneKeyAction({ key: ']', isComposing: true })).toBeUndefined();
    for (const html of ['<input>', '<textarea></textarea>', '<select></select>']) {
      const host = document.createElement('div');
      host.innerHTML = html;
      expect(sceneKeyAction({ key: ']', target: host.firstElementChild })).toBeUndefined();
    }
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const inner = document.createElement('span');
    editable.append(inner);
    expect(sceneKeyAction({ key: 'Escape', target: inner })).toBeUndefined();
    expect(sceneKeyAction({ key: 'Escape', target: document.createElement('button') })).toBe(
      'back',
    );
  });

  it('drives the camera store from the scene area, and leaves typing alone', () => {
    render(
      <section tabIndex={0} data-testid="area" onKeyDown={onSceneKey}>
        <input aria-label="field" />
      </section>,
    );
    const area = screen.getByTestId('area');
    fireEvent.keyDown(area, { key: ']' });
    expect(useCameraStore.getState().focusedId).toBe(SUN_ANCHOR_ID);
    fireEvent.keyDown(area, { key: ']' });
    expect(useCameraStore.getState().focusedId).toBe('b-jupiter');
    fireEvent.keyDown(screen.getByLabelText('field'), { key: '[' });
    expect(useCameraStore.getState().focusedId).toBe('b-jupiter');
    fireEvent.keyDown(area, { key: 'Escape' });
    expect(useCameraStore.getState().focusedId).toBeUndefined();
    expect(useCameraStore.getState().request).toMatchObject({ kind: 'overview' });
  });
});

describe('breadcrumb', () => {
  it('shows "Solar system" alone at the overview', () => {
    render(<CameraBreadcrumb />);
    const nav = screen.getByRole('navigation', { name: 'scene location' });
    expect(nav.textContent).toBe('Solar system');
    expect(screen.getByRole('button', { name: 'Solar system' }).getAttribute('aria-current')).toBe(
      'location',
    );
  });

  it('names the focused moon under its planet; the crumbs fly back', () => {
    render(<CameraBreadcrumb />);
    act(() => void useCameraStore.getState().flyTo('b-europa'));
    const nav = screen.getByRole('navigation', { name: 'scene location' });
    expect(nav.textContent).toBe('Solar systemJupiterEuropa');
    expect(screen.getByText('Europa').getAttribute('aria-current')).toBe('location');

    fireEvent.click(screen.getByRole('button', { name: 'Jupiter' }));
    expect(useCameraStore.getState().focusedId).toBe('b-jupiter');
    expect(nav.textContent).toBe('Solar systemJupiter');

    fireEvent.click(screen.getByRole('button', { name: 'Solar system' }));
    expect(useCameraStore.getState().focusedId).toBeUndefined();
    expect(nav.textContent).toBe('Solar system');
  });

  it('calls the Sun anchor "Sun" when the world has no Sun body', () => {
    render(<CameraBreadcrumb />);
    act(() => void useCameraStore.getState().flyTo(SUN_ANCHOR_ID));
    expect(screen.getByText('Sun').getAttribute('aria-current')).toBe('location');
  });
});
