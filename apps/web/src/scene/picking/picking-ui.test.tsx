// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Profiler } from 'react';
import { Object3D } from 'three';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerAnchor, type BodyAnchor } from '../anchors.js';
import { useCameraStore } from '../camera/store.js';
import { onSceneKey } from '../SceneArea.js';
import { useAppStore } from '../../state/store.js';
import { HARMONIZER, selectionKey } from '../../state/selection.js';
import { publishSatellites } from '../satellites/registry.js';
import { pickingWorld, satelliteFrame } from './fixtures.js';
import { PickingOverlay } from './PickingOverlay.js';
import {
  activateBody,
  activateSatellite,
  moveHover,
  selectFromScene,
  usePickingStore,
  type Point,
  type SatelliteHover,
} from './store.js';
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

describe("a satellite's hover card (P4-08)", () => {
  const hoverSatellite = (agentId: string, extra: Partial<SatelliteHover & Point> = {}) =>
    act(() =>
      usePickingStore.getState().setHover({
        kind: 'satellite',
        agentId,
        mode: 'orbiting',
        satelliteBodyId: 'b-ast-7',
        others: 0,
        ...AT,
        ...extra,
      }),
    );
  const setActivity = (agentId: string, currentActivity: string | undefined) =>
    act(() => {
      const world = useAppStore.getState().world;
      useAppStore.setState({
        world: {
          ...world,
          statuses: {
            ...world.statuses,
            [agentId]: { ...world.statuses[agentId]!, currentActivity },
          },
        },
      });
    });
  afterEach(() => publishSatellites(new Map()));

  it('shows the agent, its state and what it is doing, and follows the store live', () => {
    setActivity('a-st', 'Reading src/date.ts');
    render(<PickingOverlay />);
    hoverSatellite('a-st');
    const card = screen.getByRole('tooltip');
    expect(card.querySelector('.pick-sat-name')?.textContent).toBe('Steward · Fix the date test');
    expect(card.querySelector('.pill')?.textContent).toBe('working');
    expect(card.querySelector('.pill')?.className).toContain('state-working');
    expect(card.querySelector('.pick-sat-activity')?.textContent).toBe('Reading src/date.ts');
    expect(card.querySelector('.pick-sat-where')?.textContent).toBe('7 Iris');
    // While hovering, the status changes: the card says so at once.
    setActivity('a-st', 'Running the tests');
    act(() => {
      const world = useAppStore.getState().world;
      useAppStore.setState({
        world: {
          ...world,
          statuses: { ...world.statuses, 'a-st': { ...world.statuses['a-st']!, state: 'stalled' } },
        },
      });
    });
    expect(card.querySelector('.pick-sat-activity')?.textContent).toBe('Running the tests');
    expect(card.querySelector('.pill')?.textContent).toBe('stalled');
    // The mode and the "+n" count reach it too.
    hoverSatellite('a-st', { mode: 'scanning', others: 2 });
    expect(screen.getByRole('tooltip').querySelector('.pick-sat-where')?.textContent).toBe(
      'scanning · 7 Iris +2',
    );
    act(() => usePickingStore.getState().setHover(undefined));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('is placed at the satellite and moves with it without re-rendering its content', () => {
    render(<PickingOverlay />);
    hoverSatellite('a-st', { x: 100, y: 50 });
    const card = screen.getByRole('tooltip');
    expect(card.style.transform).toBe('translate(114px, 57px)');
    hoverSatellite('a-st', { x: 130, y: 60 });
    expect(screen.getByRole('tooltip')).toBe(card);
    expect(card.style.transform).toBe('translate(144px, 67px)');
  });

  it('the overlay does not re-render when only the hover moves (review item 4)', () => {
    let commits = 0;
    render(
      <Profiler id="overlay" onRender={() => commits++}>
        <PickingOverlay />
      </Profiler>,
    );
    hoverSatellite('a-st', { x: 100, y: 50 });
    const card = screen.getByRole('tooltip');
    const before = commits;
    for (let i = 1; i <= 30; i++) act(() => moveHover(100 + i, 50));
    expect(commits).toBe(before);
    expect(card.style.transform).toBe('translate(144px, 57px)');
    // The body label too.
    act(() =>
      usePickingStore.getState().setHover({ bodyId: 'b-jupiter', name: 'Jupiter', others: 0 }),
    );
    const label = screen.getByRole('tooltip');
    const atLabel = commits;
    act(() => moveHover(10, 20));
    expect(commits).toBe(atLabel);
    expect(label.style.transform).toBe('translate(24px, 30px)');
  });

  it('"what\'s here" lists the satellites first; choosing one selects its agent', () => {
    publishSatellites(new Map([['a-st', satelliteFrame('a-st', 'b-ast-7', [0, 0, 0])]]));
    render(<PickingOverlay />);
    act(() => usePickingStore.getState().showHere(AT, ['b-ast-7'], ['a-st', 'a-wk-old']));
    const list = screen.getByRole('dialog', { name: "what's here" });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Steward · Fix the date test', 'Waykeeper · Big project', '7 Iris']);
    fireEvent.click(within(list).getByRole('button', { name: 'Steward · Fix the date test' }));
    expect(selected()).toBe('steward:a-st');
    expect(camera().focusedId).toBe('b-ast-7');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it("activateSatellite without a drawn satellite flies to the agent's work body; unknown: nothing", () => {
    act(() => void activateSatellite('a-wk-old'));
    expect(selected()).toBe('waykeeper:a-wk-old');
    expect(camera().focusedId).toBe('b-jupiter');
    expect(activateSatellite('nobody')).toBe(false);
    expect(selected()).toBe('waykeeper:a-wk-old');
  });
});

describe('the popover and the focus', () => {
  function SceneWithOverlay() {
    return (
      <section className="pnl-scene" tabIndex={0} aria-label="scene">
        <PickingOverlay />
      </section>
    );
  }

  it('choosing from "what\'s here" or closing a card gives the focus back to the scene', () => {
    render(<SceneWithOverlay />);
    const area = screen.getByRole('region', { name: 'scene' });
    act(() => usePickingStore.getState().showHere(AT, ['b-jupiter', 'b-io']));
    expect(document.activeElement?.textContent).toBe('Jupiter');
    // A body with an agent: selected, the list closes, the scene keeps the keyboard.
    fireEvent.click(screen.getByRole('button', { name: 'Jupiter' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(area);
    // A free body: its card replaces the list, the focus is on the scene, not the page.
    act(() => usePickingStore.getState().showHere(AT, ['b-jupiter', 'b-io']));
    fireEvent.click(screen.getByRole('button', { name: 'Io' }));
    expect(screen.getByRole('dialog', { name: 'Io' })).toBeTruthy();
    expect(document.activeElement).toBe(area);
    // The close button too.
    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(area);
  });

  it("a body's card follows it to the centre when the camera lands there", () => {
    render(<SceneWithOverlay />);
    const area = screen.getByRole('region', { name: 'scene' });
    Object.defineProperty(area, 'clientWidth', { value: 600, configurable: true });
    Object.defineProperty(area, 'clientHeight', { value: 400, configurable: true });
    act(() => void activateBody('b-mars', AT));
    expect(usePickingStore.getState().popover).toMatchObject({ x: AT.x, y: AT.y });
    act(() => camera().flightStarted());
    expect(usePickingStore.getState().popover).toMatchObject({ x: AT.x, y: AT.y });
    act(() => camera().arrived());
    expect(usePickingStore.getState().popover).toMatchObject({ kind: 'info', x: 300, y: 200 });
    // Landing elsewhere (the user flew on) leaves a card alone.
    act(() => void activateBody('b-io', AT));
    act(() => camera().flyTo('b-mars'));
    act(() => camera().flightStarted());
    act(() => camera().arrived());
    expect(usePickingStore.getState().popover).toMatchObject({ x: AT.x, y: AT.y });
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

  it('Escape then deselects (back to the Harmonizer, the camera staying); Home never does (P5-01)', () => {
    window.history.replaceState(null, '', '/steward/a-st');
    useAppStore.setState({ selection: { kind: 'steward', id: 'a-st' } });
    render(<Area />);
    act(() => void camera().flyTo('b-ast-7'));
    const area = screen.getByRole('region', { name: 'scene' });
    fireEvent.keyDown(area, { key: 'Home' });
    expect(camera().request).toMatchObject({ kind: 'overview' });
    fireEvent.keyDown(area, { key: 'Home' });
    expect(selected()).toBe('steward:a-st');

    act(() => void camera().flyTo('b-ast-7'));
    fireEvent.keyDown(area, { key: 'Escape' }); // the camera's body first
    expect(camera().focusedId).toBeUndefined();
    expect(selected()).toBe('steward:a-st');
    const seq = camera().request?.seq;
    fireEvent.keyDown(area, { key: 'Escape' }); // then the selection
    expect(selected()).toBe('harmonizer');
    expect(window.location.pathname).toBe('/');
    expect(camera().request?.seq).toBe(seq);
    fireEvent.keyDown(area, { key: 'Escape' }); // nothing left: the system's framing
    expect(camera().request?.seq).toBeGreaterThan(seq!);
    expect(camera().request).toMatchObject({ kind: 'overview' });
  });

  it('a deselecting Escape is taken (the replay does not also exit on it)', () => {
    useAppStore.setState({ selection: { kind: 'waykeeper', id: 'a-wk-old' } });
    render(<Area />);
    const area = screen.getByRole('region', { name: 'scene' });
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => void area.dispatchEvent(event));
    expect(selected()).toBe('harmonizer');
    expect(event.defaultPrevented).toBe(true);
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

  it('a selection that comes back to the panel from the history page flies (P5-01)', () => {
    // On /history the scene is not mounted; a history row's agent link selects and returns.
    useAppStore.setState({ route: 'history' });
    act(() =>
      useAppStore
        .getState()
        .navigate({ route: 'panel', selection: { kind: 'steward', id: 'a-st' } }),
    );
    render(<Sync />);
    expect(camera().focusedId).toBe('b-ast-7');
  });

  it('…as does a notification clicked on the settings page, once the body is drawn', () => {
    unregister.forEach((u) => u());
    unregister = [];
    useAppStore.setState({ route: 'settings' });
    act(() =>
      useAppStore
        .getState()
        .navigate({ route: 'panel', selection: { kind: 'waykeeper', id: 'a-wk-old' } }),
    );
    render(<Sync />);
    expect(camera().request).toBeUndefined();
    act(() => anchor('b-jupiter'));
    expect(camera().focusedId).toBe('b-jupiter');
  });

  it('returning to the panel with the same selection, or to the Harmonizer, does not fly', () => {
    useAppStore.setState({ selection: { kind: 'steward', id: 'a-st' } });
    useAppStore.setState({ route: 'history' });
    act(() =>
      useAppStore
        .getState()
        .navigate({ route: 'panel', selection: { kind: 'steward', id: 'a-st' } }),
    );
    const first = render(<Sync />);
    expect(camera().request).toBeUndefined();
    first.unmount();

    useAppStore.setState({ route: 'settings' });
    act(() => useAppStore.getState().navigate({ route: 'panel', selection: HARMONIZER }));
    render(<Sync />);
    expect(camera().request).toBeUndefined();
  });

  it('a selection changed in list mode does not fly when the scene is shown later', () => {
    act(() => useAppStore.getState().select({ kind: 'steward', id: 'a-st' }));
    render(<Sync />);
    expect(camera().request).toBeUndefined();
  });

  describe('during a replay (P4-07)', () => {
    /** The replayed past: the big project still on Mars, the asteroid's Steward not spawned. */
    function past() {
      const world = pickingWorld();
      const { 'a-st': _gone, ...agents } = world.agents;
      const { host: _moved, ...jupiter } = world.bodies['b-jupiter']!;
      return {
        ...world,
        agents,
        bodies: {
          ...world.bodies,
          'b-jupiter': jupiter,
          'b-mars': { ...world.bodies['b-mars']!, host: { kind: 'project' as const, id: 'p-big' } },
        },
        projects: { ...world.projects, 'p-big': { ...world.projects['p-big']!, bodyId: 'b-mars' } },
      };
    }

    it("a panel selection flies to the agent's body in the replayed world", () => {
      useAppStore.setState({ replayWorld: past() });
      render(<Sync />);
      act(() => useAppStore.getState().select({ kind: 'waykeeper', id: 'a-wk-old' }));
      expect(camera().focusedId).toBe('b-mars');
      useAppStore.setState({ replayWorld: undefined });
    });

    it('an agent not in the replayed world yet: no flight, and none when it appears', () => {
      useAppStore.setState({ replayWorld: past() });
      render(<Sync />);
      act(() => useAppStore.getState().select({ kind: 'steward', id: 'a-st' }));
      expect(camera().request).toBeUndefined();
      act(() => useAppStore.setState({ replayWorld: pickingWorld() })); // playback reaches it
      expect(camera().request).toBeUndefined();
      act(() => useAppStore.setState({ replayWorld: undefined })); // exit replay
      expect(camera().request).toBeUndefined();
    });

    it('picking selects from the replayed world; the panel keeps the live agent', () => {
      useAppStore.setState({ replayWorld: past() });
      act(() => void activateBody('b-mars', AT));
      expect(selected()).toBe('waykeeper:a-wk-old');
      expect(camera().focusedId).toBe('b-mars');
      useAppStore.setState({ replayWorld: undefined });
    });
  });
});
