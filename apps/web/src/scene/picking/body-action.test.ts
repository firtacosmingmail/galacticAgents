import { describe, expect, it } from 'vitest';
import { HARMONIZER } from '../../state/selection.js';
import {
  bodyAction,
  bodyName,
  headquartersBody,
  outlineBody,
  selectionBody,
} from './body-action.js';
import { pickingWorld } from './fixtures.js';

describe('bodyAction (a click on a body, SPEC §4.1 and decision 53)', () => {
  const world = pickingWorld();

  it("a planet hosting a project selects the project's Waykeeper: the newest live one", () => {
    expect(bodyAction(world, 'b-jupiter')).toEqual({
      kind: 'select',
      bodyId: 'b-jupiter',
      name: 'Jupiter',
      selection: { kind: 'waykeeper', id: 'a-wk-old' },
    });
  });

  it('with no live Waykeeper, the newest one', () => {
    const w = pickingWorld();
    w.statuses['a-wk-old'] = { ...w.statuses['a-wk-old']!, state: 'finished' };
    expect(bodyAction(w, 'b-jupiter')).toMatchObject({
      selection: { kind: 'waykeeper', id: 'a-wk-new' },
    });
  });

  it("an asteroid hosting a task selects the task's Steward", () => {
    expect(bodyAction(world, 'b-ast-7')).toMatchObject({
      kind: 'select',
      selection: { kind: 'steward', id: 'a-st' },
    });
  });

  it('Earth, the headquarters, selects the Harmonizer (SPEC §4.2)', () => {
    expect(bodyAction(world, 'b-earth')).toMatchObject({ kind: 'select', selection: HARMONIZER });
  });

  it('work no agent has started on yet: its name and state, "no agent yet", no selection', () => {
    expect(bodyAction(world, 'b-io')).toEqual({
      kind: 'info',
      bodyId: 'b-io',
      name: 'Io',
      detail: 'New project · approved · no agent yet',
    });
    expect(bodyAction(world, 'b-ast-9')).toMatchObject({
      kind: 'info',
      detail: 'Bump the deps · approved · no agent yet',
    });
  });

  it('free, reserved, moved and unknown bodies say what they are', () => {
    expect(bodyAction(world, 'b-mars')).toMatchObject({ kind: 'info', detail: 'free' });
    expect(bodyAction(world, 'b-moon')).toMatchObject({
      kind: 'info',
      detail: 'reserved — headquarters',
    });
    expect(bodyAction(world, 'b-sun')).toMatchObject({
      kind: 'info',
      detail: 'reserved — the Sun',
    });
    expect(bodyAction(world, 'b-venus')).toMatchObject({
      kind: 'info',
      detail: 'moved to Jupiter',
    });
    expect(bodyAction(world, 'b-nowhere')).toMatchObject({ kind: 'info', name: 'b-nowhere' });
  });

  it('the Sun has a name before the catalogue arrives', () => {
    expect(bodyName({ bodies: {} }, 'b-sun')).toBe('Sun');
    expect(bodyAction({ ...world, bodies: {} }, 'b-sun')).toMatchObject({
      name: 'Sun',
      detail: 'reserved — the Sun',
    });
  });

  it('the headquarters fall back to the catalogue Earth without a Harmonizer', () => {
    expect(headquartersBody({ agents: {}, statuses: {} })).toBe('b-earth');
  });
});

describe('selectionBody (the outline and the panel → scene flight)', () => {
  const world = pickingWorld();

  it("maps each selection to its agent's work's body", () => {
    expect(selectionBody(world, HARMONIZER)).toBe('b-earth');
    expect(selectionBody(world, { kind: 'waykeeper', id: 'a-wk-new' })).toBe('b-jupiter');
    expect(selectionBody(world, { kind: 'steward', id: 'a-st' })).toBe('b-ast-7');
    // A project task's Steward: its task lives on the project's body.
    expect(selectionBody(world, { kind: 'steward', id: 'a-st-in' })).toBe('b-jupiter');
    expect(selectionBody(world, { kind: 'steward', id: 'a-gone' })).toBeUndefined();
  });

  it("follows the work, not the agent's stale body, after a move", () => {
    const w = pickingWorld();
    w.tasks['t-ast'] = { ...w.tasks['t-ast']!, bodyId: 'b-mars' };
    expect(selectionBody(w, { kind: 'steward', id: 'a-st' })).toBe('b-mars');
  });

  it('round-trips with bodyAction for every body with an agent', () => {
    for (const bodyId of ['b-jupiter', 'b-ast-7', 'b-earth']) {
      const action = bodyAction(world, bodyId);
      expect(action.kind).toBe('select');
      if (action.kind === 'select') expect(selectionBody(world, action.selection)).toBe(bodyId);
    }
  });
});

describe('outlineBody (what the composer outlines)', () => {
  it("outlines the selected agent's body, never Earth for the default Harmonizer selection", () => {
    const world = pickingWorld();
    expect(outlineBody(world, HARMONIZER)).toBeUndefined();
    expect(selectionBody(world, HARMONIZER)).toBe('b-earth'); // the ring still marks Earth
    expect(outlineBody(world, { kind: 'waykeeper', id: 'a-wk-new' })).toBe('b-jupiter');
    expect(outlineBody(world, { kind: 'steward', id: 'a-st' })).toBe('b-ast-7');
    expect(outlineBody(world, { kind: 'steward', id: 'a-gone' })).toBeUndefined();
  });
});

describe('an area moon (P10-07, decision 143)', () => {
  const areaWorld = () => {
    const w = pickingWorld();
    w.bodies['b-callisto'] = {
      id: 'b-callisto',
      kind: 'moon',
      parentId: 'b-jupiter',
      name: 'Callisto',
      host: { kind: 'areas', id: 'p-big' },
    };
    return w;
  };

  it("selects the project's Waykeeper and asks for its Jobs filtered to the moon", () => {
    expect(bodyAction(areaWorld(), 'b-callisto')).toEqual({
      kind: 'select',
      bodyId: 'b-callisto',
      name: 'Callisto',
      selection: { kind: 'waykeeper', id: 'a-wk-old' },
      jobsOf: 'b-callisto',
    });
  });

  it('a project body asks for no jobs view', () => {
    expect(bodyAction(areaWorld(), 'b-jupiter')).not.toHaveProperty('jobsOf');
  });

  it('with no Waykeeper yet, says so', () => {
    const w = areaWorld();
    w.agents = {};
    expect(bodyAction(w, 'b-callisto')).toMatchObject({
      kind: 'info',
      detail: 'Big project · in progress · no agent yet',
    });
  });
});
