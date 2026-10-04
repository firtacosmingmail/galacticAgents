import { describe, expect, it } from 'vitest';
import { pickingWorld } from './fixtures.js';
import { ACTIVITY_CHARS, oneLine, satelliteCard, satelliteSelection } from './satellite-card.js';

const withActivity = (agentId: string, currentActivity: string | undefined) => {
  const world = pickingWorld();
  world.statuses[agentId] = { ...world.statuses[agentId]!, currentActivity };
  return world;
};

describe('satelliteCard (what hovering a satellite says, P4-08)', () => {
  it('names a Waykeeper by its project and shows its state and activity', () => {
    const world = withActivity('a-wk-old', 'Planning the parser tasks');
    expect(satelliteCard(world, 'a-wk-old', { bodyId: 'b-jupiter', mode: 'orbiting' })).toEqual({
      agentId: 'a-wk-old',
      name: 'Waykeeper · Big project',
      state: 'working',
      activity: 'Planning the parser tasks',
      where: 'Jupiter',
    });
  });

  it("names a Steward by its task (shortened like the panel's names)", () => {
    const world = pickingWorld();
    world.tasks['t-ast'] = {
      ...world.tasks['t-ast']!,
      description: 'Fix the date test that fails around midnight in every timezone east of UTC',
    };
    const card = satelliteCard(world, 'a-st', { bodyId: 'b-ast-7', mode: 'orbiting' });
    expect(card.name.startsWith('Steward · Fix the date test')).toBe(true);
    expect(card.name.endsWith('…')).toBe(true);
    expect(card.name.length).toBeLessThanOrEqual('Steward · '.length + 48);
  });

  it('puts the activity on one line and cuts it at a word', () => {
    const long =
      'Running the whole test suite\nafter rewriting the date parser, then checking the coverage report for regressions in edge cases';
    const card = satelliteCard(withActivity('a-st', long), 'a-st');
    expect(card.activity).not.toContain('\n');
    expect(card.activity.length).toBeLessThanOrEqual(ACTIVITY_CHARS);
    expect(card.activity.endsWith('…')).toBe(true);
    expect(card.activity).toMatch(/^Running the whole test suite after rewriting/);
    // Cut at a word boundary: the last word before the ellipsis is whole.
    expect(long.replace(/\s+/g, ' ')).toContain(card.activity.slice(0, -1));
    expect(long.replace(/\s+/g, ' ')[card.activity.length - 1]).toBe(' ');
  });

  it('oneLine: short text untouched, one long word cut hard', () => {
    expect(oneLine('  reading   src/a.ts ')).toBe('reading src/a.ts');
    expect(oneLine('x'.repeat(200), 20)).toBe(`${'x'.repeat(19)}…`);
  });

  it('without an activity: "no activity yet", or "not running" once ended; no status at all', () => {
    expect(satelliteCard(withActivity('a-st', undefined), 'a-st').activity).toBe('no activity yet');
    expect(satelliteCard(withActivity('a-st', '   '), 'a-st').activity).toBe('no activity yet');
    expect(satelliteCard(withActivity('a-wk-new', undefined), 'a-wk-new').activity).toBe(
      'not running',
    );
    const world = pickingWorld();
    delete world.statuses['a-st'];
    expect(satelliteCard(world, 'a-st')).toMatchObject({
      state: undefined,
      activity: 'no activity yet',
      where: '7 Iris', // the agent's own body when no frame is given
    });
    expect(satelliteCard(world, 'nobody')).toMatchObject({ name: 'an agent', where: '' });
  });

  it('says what the satellite is doing when it is not plain orbiting', () => {
    const world = pickingWorld();
    expect(satelliteCard(world, 'a-st', { bodyId: 'b-ast-7', mode: 'scanning' }).where).toBe(
      'scanning · 7 Iris',
    );
    expect(satelliteCard(world, 'a-st', { bodyId: 'b-mars', mode: 'flying' }).where).toBe(
      'flying to Mars',
    );
    // P4-04: a landed satellite is completed work.
    expect(satelliteCard(world, 'a-st', { bodyId: 'b-mars', mode: 'landed' })).toMatchObject({
      activity: 'work completed',
      where: 'landed · Mars',
    });
  });

  it("a click selects the satellite's agent (decision 53)", () => {
    const world = pickingWorld();
    expect(satelliteSelection(world, 'a-wk-old')).toEqual({ kind: 'waykeeper', id: 'a-wk-old' });
    expect(satelliteSelection(world, 'a-st')).toEqual({ kind: 'steward', id: 'a-st' });
    expect(satelliteSelection(world, 'a-h')).toEqual({ kind: 'harmonizer' });
    expect(satelliteSelection(world, 'nobody')).toBeUndefined();
  });
});
