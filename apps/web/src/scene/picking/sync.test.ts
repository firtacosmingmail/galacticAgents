import { describe, expect, it } from 'vitest';
import { HARMONIZER, type Selection } from '../../state/selection.js';
import { SelectionSync, type SyncDeps } from './sync.js';

const WK: Selection = { kind: 'waykeeper', id: 'a-wk' };
const ST: Selection = { kind: 'steward', id: 'a-st' };
const BODIES: Record<string, string> = { 'a-wk': 'b-jupiter', 'a-st': 'b-ast-7' };

function harness(opts: { anchors?: string[]; known?: boolean; focused?: string } = {}) {
  const flights: string[] = [];
  const state = {
    anchors: new Set(opts.anchors ?? ['b-jupiter', 'b-ast-7', 'b-earth']),
    known: opts.known ?? true,
    focused: opts.focused as string | undefined,
  };
  const deps: SyncDeps = {
    bodyFor: (s) => (s.kind === 'harmonizer' ? 'b-earth' : state.known ? BODIES[s.id] : undefined),
    hasAnchor: (id) => state.anchors.has(id),
    focusedId: () => state.focused,
    flyTo: (id) => {
      flights.push(id);
      state.focused = id;
    },
  };
  return { sync: new SelectionSync(deps), flights, state };
}

describe('SelectionSync (panel → scene: fly only on user changes)', () => {
  it('a selection made in the panel flies to its body', () => {
    const { sync, flights } = harness();
    sync.start(HARMONIZER, undefined);
    sync.selectionChanged(WK, false);
    sync.selectionChanged(ST, false);
    expect(flights).toEqual(['b-jupiter', 'b-ast-7']);
  });

  it('a selection the scene made does not fly again', () => {
    const { sync, flights } = harness();
    sync.start(HARMONIZER, undefined);
    sync.selectionChanged(WK, true);
    expect(flights).toEqual([]);
  });

  it('going back to the Harmonizer leaves the camera alone', () => {
    const { sync, flights } = harness();
    sync.start(WK, undefined);
    sync.selectionChanged(HARMONIZER, false);
    expect(flights).toEqual([]);
  });

  it('no flight when the camera is already on the body', () => {
    const { sync, flights } = harness({ focused: 'b-jupiter' });
    sync.start(HARMONIZER, undefined);
    sync.selectionChanged(WK, false);
    expect(flights).toEqual([]);
  });

  it('a plain load does not fly; neither does showing the scene again', () => {
    const { sync, flights } = harness();
    sync.start(WK, undefined);
    sync.retry(); // a snapshot, an event
    expect(flights).toEqual([]);
  });

  it('a deep link flies once its body is drawn, then never again on snapshots', () => {
    const { sync, flights, state } = harness({ anchors: [], known: false });
    sync.start(WK, WK);
    expect(sync.waiting).toBe(true);
    sync.retry(); // the snapshot is not there yet
    state.known = true;
    sync.retry(); // the snapshot came, the bodies are not drawn yet
    expect(flights).toEqual([]);
    state.anchors.add('b-jupiter');
    sync.retry(); // the anchor registered
    expect(flights).toEqual(['b-jupiter']);
    state.focused = undefined; // the user flew away
    sync.retry();
    sync.retry();
    expect(flights).toEqual(['b-jupiter']);
  });

  it('a deep link to the Harmonizer, or a selection no longer the linked one, does not fly', () => {
    const a = harness();
    a.sync.start(HARMONIZER, HARMONIZER);
    expect(a.flights).toEqual([]);
    const b = harness();
    b.sync.start(ST, WK);
    expect(b.flights).toEqual([]);
  });

  it('a waiting flight is dropped when the user moves the camera or selects something else', () => {
    const moved = harness({ anchors: [] });
    moved.sync.start(WK, WK);
    moved.sync.userMoved();
    moved.state.anchors.add('b-jupiter');
    moved.sync.retry();
    expect(moved.flights).toEqual([]);

    const other = harness({ anchors: ['b-ast-7'] });
    other.sync.start(WK, WK);
    other.sync.selectionChanged(ST, false);
    other.state.anchors.add('b-jupiter');
    other.sync.retry();
    expect(other.flights).toEqual(['b-ast-7']);
  });
});
