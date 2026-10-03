import { describe, expect, it } from 'vitest';
import { WorkState, type Body } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { pickingWorld } from '../picking/fixtures.js';
import {
  bodyLabel,
  bodyLabels,
  independentMoons,
  labelPriority,
  PRIORITY,
  shortTitle,
  stateText,
  stateTone,
  type LabelWorld,
} from './label-model.js';

/**
 * Picking's world plus a sub-project moon of Jupiter's project (Europa) and a moved asteroid:
 * Io hosts an independent project ("New project", no parent), Venus shows "moved to Jupiter".
 */
function labelWorld(): LabelWorld {
  const w = pickingWorld();
  const europa: Body = {
    id: 'b-europa',
    kind: 'moon',
    parentId: 'b-jupiter',
    name: 'Europa',
    host: { kind: 'project', id: 'p-sub' },
  };
  const movedRock: Body = {
    id: 'b-ast-11',
    kind: 'asteroid',
    name: '11 Parthenope',
    movedTo: { bodyId: 'b-jupiter', host: { kind: 'task', id: 't-in' }, at: fx.project.createdAt },
  };
  return {
    bodies: { ...w.bodies, 'b-europa': europa, 'b-ast-11': movedRock },
    projects: {
      ...w.projects,
      'p-sub': {
        ...fx.project,
        id: 'p-sub',
        name: 'Billing sub-system',
        bodyId: 'b-europa',
        parentProjectId: 'p-big',
        state: 'paused',
      },
    },
    tasks: w.tasks,
  };
}

const ids = (world: LabelWorld) => bodyLabels(world).map((l) => l.bodyId);

describe('world → labels', () => {
  it('labels every assigned body and the moved markers, nothing else', () => {
    expect(ids(labelWorld())).toEqual([
      'b-ast-11', // moved to Jupiter
      'b-ast-7', // a task
      'b-ast-9', // a task, no agent yet
      'b-europa', // a sub-project
      'b-io', // an independent project
      'b-jupiter', // a project
      'b-venus', // moved to Jupiter
    ]);
  });

  it('reserved bodies (Sun, Earth, Moon) and free bodies are unlabelled', () => {
    const world = labelWorld();
    for (const id of ['b-sun', 'b-earth', 'b-moon', 'b-mars', 'b-unknown'])
      expect(bodyLabel(world, id)).toBeUndefined();
    // Reserved stays unlabelled even if something were hosted there.
    const earth = world.bodies['b-earth']!;
    world.bodies['b-earth'] = { ...earth, host: { kind: 'project', id: 'p-big' } };
    expect(bodyLabel(world, 'b-earth')).toBeUndefined();
  });

  it("a project's planet: the project's name and state", () => {
    expect(bodyLabel(labelWorld(), 'b-jupiter')).toMatchObject({
      kind: 'project',
      title: 'Big project',
      state: 'in_progress',
      stateText: 'in progress',
      tone: 'active',
      selected: false,
      priority: PRIORITY.active,
    });
    expect(bodyLabel(labelWorld(), 'b-jupiter')?.moon).toBeUndefined();
  });

  it("a task's asteroid: the task's description and state", () => {
    expect(bodyLabel(labelWorld(), 'b-ast-7')).toMatchObject({
      kind: 'task',
      title: 'Fix the date test',
      state: 'blocked_on_user',
      stateText: 'blocked on you',
      tone: 'beacon',
      priority: PRIORITY.blocked,
    });
    expect(bodyLabel(labelWorld(), 'b-ast-9')).toMatchObject({
      state: 'approved',
      tone: 'waiting',
    });
  });

  it('every work state has a text and a tone; blocked on user is the only beacon', () => {
    for (const state of WorkState.options) {
      expect(stateText(state)).toBeTruthy();
      expect(stateTone(state) === 'beacon').toBe(state === 'blocked_on_user');
    }
    expect(stateText('completed')).toBe('✓ completed');
    expect(stateTone('completed')).toBe('done');
    expect(stateTone('failed')).toBe('fail');
    expect(stateTone('paused')).toBe('warn');
    expect(stateTone('interrupted')).toBe('warn');
  });

  it('completed work: dimmed (done tone), lowest priority', () => {
    const world = labelWorld();
    world.projects['p-big'] = { ...world.projects['p-big']!, state: 'completed' };
    expect(bodyLabel(world, 'b-jupiter')).toMatchObject({
      stateText: '✓ completed',
      tone: 'done',
      priority: PRIORITY.done,
    });
  });

  it('a "moved to …" marker names the work that left and where it went', () => {
    expect(bodyLabel(labelWorld(), 'b-venus')).toMatchObject({
      kind: 'moved',
      title: 'Big project',
      state: 'moved',
      stateText: 'moved to Jupiter',
      tone: 'done',
      movedTo: { bodyId: 'b-jupiter', name: 'Jupiter' },
    });
    expect(bodyLabel(labelWorld(), 'b-ast-11')).toMatchObject({
      title: fx.task.description,
      stateText: 'moved to Jupiter',
    });
  });

  it('hosted work wins over a stale marker', () => {
    const world = labelWorld();
    world.bodies['b-jupiter'] = {
      ...world.bodies['b-jupiter']!,
      movedTo: { bodyId: 'b-io', host: { kind: 'project', id: 'p-new' }, at: fx.project.createdAt },
    };
    expect(bodyLabel(world, 'b-jupiter')?.kind).toBe('project');
  });

  it('work not loaded yet: the body name and a neutral pill', () => {
    const world = labelWorld();
    world.bodies['b-mars'] = { ...world.bodies['b-mars']!, host: { kind: 'task', id: 't-gone' } };
    expect(bodyLabel(world, 'b-mars')).toMatchObject({
      title: 'Mars',
      state: undefined,
      stateText: 'loading',
      tone: 'waiting',
    });
  });

  it('long names are shortened; the tooltip keeps them whole', () => {
    const world = labelWorld();
    const long = 'Rewrite the whole date parsing module so that it handles time zones';
    world.tasks['t-ast'] = { ...world.tasks['t-ast']!, description: long };
    const label = bodyLabel(world, 'b-ast-7')!;
    expect(label.title.length).toBeLessThanOrEqual(32);
    expect(label.title.endsWith('…')).toBe(true);
    expect(label.fullTitle).toBe(long);
    expect(shortTitle('  a\n b  ')).toBe('a b');
  });

  it('the selected body is marked and wins every overlap', () => {
    const label = bodyLabel(labelWorld(), 'b-venus', 'b-venus')!;
    expect(label.selected).toBe(true);
    expect(label.priority).toBe(PRIORITY.selected);
    expect(
      bodyLabels(labelWorld(), 'b-jupiter')
        .filter((l) => l.selected)
        .map((l) => l.bodyId),
    ).toEqual(['b-jupiter']);
  });
});

describe('moons: independent project vs sub-project (SPEC §3.2)', () => {
  it('an independent small project is marked as its own', () => {
    const label = bodyLabel(labelWorld(), 'b-io')!;
    expect(label.moon).toBe('independent');
    expect(label.partOf).toBeUndefined();
  });

  it('a sub-project reads as part of its parent project', () => {
    expect(bodyLabel(labelWorld(), 'b-europa')).toMatchObject({
      moon: 'sub-project',
      partOf: 'Big project',
      title: 'Billing sub-system',
      stateText: 'paused',
      tone: 'warn',
    });
  });

  it('only independent-project moons get the scene ring', () => {
    expect(independentMoons(labelWorld())).toEqual(['b-io']);
  });

  it('a moon project not loaded yet is neither', () => {
    const world = labelWorld();
    delete world.projects['p-new'];
    expect(bodyLabel(world, 'b-io')?.moon).toBeUndefined();
    expect(independentMoons(world)).toEqual([]);
  });
});

describe('priority', () => {
  it('selected > blocked on user > in progress > other open work > finished', () => {
    expect(labelPriority('done', true)).toBe(PRIORITY.selected);
    const order = (['beacon', 'active', 'waiting', 'warn', 'fail', 'done'] as const).map((t) =>
      labelPriority(t, false),
    );
    expect(order).toEqual([
      PRIORITY.blocked,
      PRIORITY.active,
      PRIORITY.open,
      PRIORITY.open,
      PRIORITY.open,
      PRIORITY.done,
    ]);
    expect(PRIORITY.selected).toBeGreaterThan(PRIORITY.blocked);
    expect(PRIORITY.blocked).toBeGreaterThan(PRIORITY.active);
    expect(PRIORITY.active).toBeGreaterThan(PRIORITY.open);
    expect(PRIORITY.open).toBeGreaterThan(PRIORITY.done);
  });
});
