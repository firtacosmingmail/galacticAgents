// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Object3D } from 'three';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerAnchor, type BodyAnchor } from '../anchors.js';
import { useCameraStore } from '../camera/store.js';
import { onSceneKey } from '../SceneArea.js';
import { useAppStore } from '../../state/store.js';
import { HARMONIZER, selectionKey } from '../../state/selection.js';
import { pickingWorld } from './fixtures.js';
import { PickingOverlay } from './PickingOverlay.js';
import { activateBody, selectFromScene, usePickingStore } from './store.js';
import { setDeepLinkForTest, useSelectionSync } from './sync.js';

const AT = { x: 120, y: 80 };
let unregister: (() => void)[] = [];

function anchor(bodyId: string, kind: BodyAnchor['kind'] = 'planet'): void {
  unregister.push(registerAnchor({ bodyId, kind, object: new Object3D(), radius: 1 }));
}

const selected = () => selectionKey(useAppStore.getState().selection);
const camera = () => useCameraStore.getState();

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  useAppStore.setState({ world: pickingWorld(), route: 'panel', selection: HARMONIZER });
  usePickingStore.setState({ hover: undefined, popover: undefined });
  useCameraStore.setState({ focusedId: undefined, request: undefined, flying: false });
  setDeepLinkForTest(undefined);
  for (const id of ['b-sun', 'b-earth', 'b-moon', 'b-mars', 'b-jupiter', 'b-io', 'b-ast-7'])
    anchor(id);
});

afterEach(() => {
  cleanup();
  unregister.forEach((u) => u());
  unregister = [];
});

describe('activateBody (a click on a body)', () => {
  it("selects the Waykeeper of a project's planet and flies there", () => {
    act(() => void activateBody('b-jupiter', AT));
    expect(selected()).toBe('waykeeper:a-wk-old');
    expect(window.location.pathname).toBe('/waykeeper/a-wk-old');
    expect(camera().focusedId).toBe('b-jupiter');
    expect(usePickingStore.getState().popover).toBeUndefined();
  });

  it("selects an asteroid task's Steward; Earth selects the Harmonizer", () => {
    act(() => void activateBody('b-ast-7', AT));
    expect(selected()).toBe('steward:a-st');
    act(() => void activateBody('b-earth', AT));
    expect(selected()).toBe('harmonizer');
    expect(camera().focusedId).toBe('b-earth');
  });

  it('a free body: flies there, shows the info popover, keeps the selection', () => {
    act(() => void activateBody('b-jupiter', AT));
    render(<PickingOverlay />);
    act(() => void activateBody('b-mars', AT));
    expect(selected()).toBe('waykeeper:a-wk-old');
    expect(camera().focusedId).toBe('b-mars');
    const dialog = screen.getByRole('dialog', { name: 'Mars' });
    expect(dialog.textContent).toContain('free');
    fireEvent.click(within(dialog).getByRole('button', { name: 'close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('work with no agent yet says so', () => {
    render(<PickingOverlay />);
    act(() => void activateBody('b-io', AT));
    expect(screen.getByRole('dialog', { name: 'Io' }).textContent).toContain(
      'New project · approved · no agent yet',
    );
    expect(selected()).toBe('harmonizer');
  });
});

describe('the overlay', () => {
  it('shows the hover label with how many others are there', () => {
    render(<PickingOverlay />);
    act(() =>
      usePickingStore
        .getState()
        .setHover({ bodyId: 'b-jupiter', name: 'Jupiter', others: 2, ...AT }),
    );
    expect(screen.getByRole('tooltip').textContent).toBe('Jupiter +2');
    act(() => usePickingStore.getState().setHover(undefined));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('"what\'s here" lists the bodies under the pointer; choosing one activates it', () => {
    render(<PickingOverlay />);
    act(() => usePickingStore.getState().showHere(AT, ['b-jupiter', 'b-io', 'b-ast-7']));
    const list = screen.getByRole('dialog', { name: "what's here" });
    const names = within(list)
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(names).toEqual(['Jupiter', 'Io', '7 Iris']);
    // The list takes the focus for the keyboard.
    expect(document.activeElement?.textContent).toBe('Jupiter');
    // A body with nobody on it: its info replaces the list.
    fireEvent.click(within(list).getByRole('button', { name: 'Io' }));
    expect(screen.getByRole('dialog', { name: 'Io' })).toBeTruthy();
    expect(camera().focusedId).toBe('b-io');
    // A body with an agent: selected, the popover closes.
    act(() => usePickingStore.getState().showHere(AT, ['b-jupiter', 'b-io']));
    fireEvent.click(screen.getByRole('button', { name: 'Jupiter' }));
    expect(selected()).toBe('waykeeper:a-wk-old');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('scene keys', () => {
  function Area() {
    return (
      <section tabIndex={0} aria-label="scene" onKeyDown={onSceneKey}>
        <button type="button">inside</button>
      </section>
    );
  }

  it('Enter on the scene selects the body the camera is on, without flying again', () => {
    render(<Area />);
    act(() => void camera().flyTo('b-ast-7'));
    const seq = camera().request?.seq;
    fireEvent.keyDown(screen.getByRole('region', { name: 'scene' }), { key: 'Enter' });
    expect(selected()).toBe('steward:a-st');
    expect(camera().request?.seq).toBe(seq);
  });

  it('Enter on a button inside, or with nothing focused, does nothing', () => {
    render(<Area />);
    fireEvent.keyDown(screen.getByRole('region', { name: 'scene' }), { key: 'Enter' });
    act(() => void camera().flyTo('b-jupiter'));
    fireEvent.keyDown(screen.getByRole('button', { name: 'inside' }), { key: 'Enter' });
    expect(selected()).toBe('harmonizer');
  });

  it('Enter on a free body shows its info', () => {
    render(
      <>
        <Area />
        <PickingOverlay />
      </>,
    );
    act(() => void camera().flyTo('b-moon'));
    fireEvent.keyDown(screen.getByRole('region', { name: 'scene' }), { key: 'Enter' });
    expect(screen.getByRole('dialog', { name: 'Moon' }).textContent).toContain(
      'reserved — headquarters',
    );
  });

  it('Escape closes the popover before going back to the system', () => {
    render(<Area />);
    act(() => void camera().flyTo('b-jupiter'));
    act(() => usePickingStore.getState().showHere(AT, ['b-jupiter', 'b-io']));
    const area = screen.getByRole('region', { name: 'scene' });
    fireEvent.keyDown(area, { key: 'Escape' });
    expect(usePickingStore.getState().popover).toBeUndefined();
    expect(camera().focusedId).toBe('b-jupiter');
    fireEvent.keyDown(area, { key: 'Escape' });
    expect(camera().focusedId).toBeUndefined();
  });
});

describe('useSelectionSync (panel → scene)', () => {
  function Sync() {
    useSelectionSync();
    return null;
  }

  it("flies on a panel selection, not on the scene's own, not on world updates", () => {
    render(<Sync />);
    expect(camera().request).toBeUndefined();
    act(() => useAppStore.getState().select({ kind: 'steward', id: 'a-st' }));
    expect(camera().focusedId).toBe('b-ast-7');
    const seq = camera().request?.seq;

    act(() => selectFromScene({ kind: 'waykeeper', id: 'a-wk-old' }));
    expect(camera().request?.seq).toBe(seq);

    act(() => useAppStore.setState({ world: { ...pickingWorld(), seq: 9 } }));
    expect(camera().request?.seq).toBe(seq);

    act(() => useAppStore.getState().select(HARMONIZER));
    expect(camera().request?.seq).toBe(seq);
  });

  it("a panel selection closes a body's info popover; the scene's own does not", () => {
    render(<Sync />);
    act(() => void activateBody('b-mars', AT));
    expect(usePickingStore.getState().popover?.kind).toBe('info');
    act(() => selectFromScene({ kind: 'steward', id: 'a-st' }));
    expect(usePickingStore.getState().popover?.kind).toBe('info');
    act(() => useAppStore.getState().select({ kind: 'waykeeper', id: 'a-wk-old' }));
    expect(usePickingStore.getState().popover).toBeUndefined();
  });

  it('a deep link flies once the body is drawn', () => {
    useAppStore.setState({ selection: { kind: 'waykeeper', id: 'a-wk-old' } });
    setDeepLinkForTest({ kind: 'waykeeper', id: 'a-wk-old' });
    unregister.forEach((u) => u());
    unregister = [];
    render(<Sync />);
    expect(camera().request).toBeUndefined();
    act(() => anchor('b-jupiter'));
    expect(camera().focusedId).toBe('b-jupiter');
  });

  it('a plain load with a selection does not fly', () => {
    useAppStore.setState({ selection: { kind: 'waykeeper', id: 'a-wk-old' } });
    render(<Sync />);
    expect(camera().request).toBeUndefined();
  });
});
