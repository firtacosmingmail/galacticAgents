// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { registerAnchor } from '../scene/anchors.js';
import { useCameraStore } from '../scene/camera/store.js';
import { pickingWorld } from '../scene/picking/fixtures.js';
import { PickingOverlay } from '../scene/picking/PickingOverlay.js';
import { activateBody, usePickingStore } from '../scene/picking/store.js';
import { SatelliteLegend } from '../scene/legend/Legend.js';
import { useAppStore } from '../state/store.js';
import { HARMONIZER } from '../state/selection.js';
import { axeFindings, blocking, type AxeFinding } from './a11y-fixtures.js';

/**
 * P5-04: the scene's HTML overlays (the WebGL canvas itself is not checked): the "what's here"
 * list, a body's info card and the satellite legend, open and closed, with no serious or critical
 * axe-core finding.
 */

const AT = { x: 120, y: 80 };
let unregister: (() => void)[] = [];

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  useAppStore.setState({ world: pickingWorld(), route: 'panel', selection: HARMONIZER });
  usePickingStore.setState({ hover: undefined, popover: undefined });
  useCameraStore.setState({ focusedId: undefined, request: undefined, flying: false });
  for (const id of ['b-sun', 'b-earth', 'b-mars', 'b-jupiter', 'b-io', 'b-ast-7'])
    unregister.push(
      registerAnchor({ bodyId: id, kind: 'planet', object: new Object3D(), radius: 1 }),
    );
});
afterEach(() => {
  cleanup();
  unregister.forEach((u) => u());
  unregister = [];
  localStorage.clear();
});

/** The overlays as the scene area holds them: inside its labelled region, under a main. */
function Scene() {
  return (
    <main>
      <section aria-label="solar system" tabIndex={0}>
        <PickingOverlay />
        <SatelliteLegend />
      </section>
    </main>
  );
}

describe('axe-core over the scene’s overlays (P5-04)', () => {
  it('"what\'s here", an info card and the legend', async () => {
    render(<Scene />);
    act(() => usePickingStore.getState().showHere(AT, ['b-jupiter', 'b-io', 'b-ast-7']));
    expect(screen.getByRole('dialog', { name: "what's here" })).toBeTruthy();
    expect(blocking(await axeFindings())).toEqual<AxeFinding[]>([]);
    act(() => void activateBody('b-mars', AT));
    expect(screen.getByRole('dialog', { name: 'Mars' })).toBeTruthy();
    expect(blocking(await axeFindings())).toEqual<AxeFinding[]>([]);
    act(() => screen.getByRole('button', { name: /Legend|Hide legend/ }).click());
    expect(blocking(await axeFindings())).toEqual<AxeFinding[]>([]);
  });
});
