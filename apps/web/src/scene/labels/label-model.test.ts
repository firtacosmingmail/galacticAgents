import { describe, expect, it } from 'vitest';
import { WorkState, type Body, type Deliverable } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { pickingWorld } from '../picking/fixtures.js';
import {
  bodyLabel,
  bodyLabels,
  deliverableMarks,
  markDescription,
  markText,
  independentMoons,
  areaMoons,
  labelPriority,
  PRIORITY,
  shortTitle,
  ASTEROID_TITLE_MAX,
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
      title: 'Fix the date te…',
      fullTitle: 'Fix the date test',
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
    // A moon keeps its marker too.
    const world = labelWorld();
    world.bodies['b-europa'] = {
      id: 'b-europa',
      kind: 'moon',
      parentId: 'b-jupiter',
      name: 'Europa',
      movedTo: {
        bodyId: 'b-jupiter',
        host: { kind: 'task', id: 't-in' },
        at: fx.project.createdAt,
      },
    };
    expect(bodyLabel(world, 'b-europa')).toMatchObject({
      kind: 'moved',
      title: fx.task.description,
      stateText: 'moved to Jupiter',
    });
  });

  it('an asteroid whose task moved away has no label: it is part of the belt (decision 63)', () => {
    expect(bodyLabel(labelWorld(), 'b-ast-11')).toBeUndefined();
    expect(ids(labelWorld())).not.toContain('b-ast-11');
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
    expect(label.title).toBe('Rewrite the who…');
    expect(label.title.length).toBeLessThanOrEqual(ASTEROID_TITLE_MAX);
    expect(label.fullTitle).toBe(long);
    expect(shortTitle('  a\n b  ')).toBe('a b');
  });

  it("an asteroid's name is cut shorter than a planet's (P8-16)", () => {
    const world = labelWorld();
    const name = 'Calendar sync for the family planner';
    world.tasks['t-ast'] = { ...world.tasks['t-ast']!, description: name };
    world.projects['p-big'] = { ...world.projects['p-big']!, name };
    expect(bodyLabel(world, 'b-ast-7')!.title).toBe('Calendar sync f…');
    expect(bodyLabel(world, 'b-jupiter')!.title).toBe('Calendar sync for the family pl…');
    world.tasks['t-ast'] = { ...world.tasks['t-ast']!, description: 'Fix the login' };
    expect(bodyLabel(world, 'b-ast-7')!.title).toBe('Fix the login');
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

describe('the deliverables mark (P9-11, decision 133)', () => {
  const NOW = fx.deliverable.createdAt;
  const d = (over: Partial<Deliverable> & Pick<Deliverable, 'id'>): [string, Deliverable] => [
    over.id,
    { ...fx.deliverable, ...over },
  ];
  /** Jupiter's project: two agent files (one on its task), a user URL, a removed file, a
   *  detected folder and a detected command; the asteroid task: one agent image. */
  function markWorld(running = false): LabelWorld {
    return {
      ...labelWorld(),
      deliverables: Object.fromEntries([
        d({ id: 'd-a', projectId: 'p-big', taskId: undefined }),
        d({ id: 'd-b', projectId: 'p-big', taskId: 't-in' }),
        d({
          id: 'd-c',
          projectId: 'p-big',
          taskId: undefined,
          kind: 'url',
          source: 'user',
          addedBy: { type: 'user' },
          url: 'https://example.com',
        }),
        d({ id: 'd-gone', projectId: 'p-big', taskId: undefined, removedAt: NOW }),
        d({
          id: 'd-folder',
          projectId: 'p-big',
          taskId: undefined,
          kind: 'folder',
          source: 'detected',
          detectedKey: 'folder',
        }),
        [
          'd-dev',
          {
            ...fx.commandDeliverable,
            id: 'd-dev',
            projectId: 'p-big',
            lastRun: running
              ? { runId: 'r-1', state: 'running', startedAt: NOW, ports: [5173] }
              : {
                  runId: 'r-1',
                  state: 'ended',
                  startedAt: NOW,
                  endedAt: NOW,
                  outcome: 'stopped',
                  ports: [],
                },
          } satisfies Deliverable,
        ],
        d({ id: 'd-ast', projectId: undefined, taskId: 't-ast' }),
      ]),
    };
  }

  it('counts what agents and the user added, not the folder, detected commands or removed rows', () => {
    const marks = deliverableMarks(markWorld().deliverables);
    expect(marks.get('project:p-big')).toEqual({ count: 3, running: false });
    expect(marks.get('task:t-in')).toEqual({ count: 1, running: false });
    expect(marks.get('task:t-ast')).toEqual({ count: 1, running: false });
    expect(marks.has('project:p-new')).toBe(false);
  });

  it('labels carry the mark of the work they host; none without deliverables', () => {
    const labels = Object.fromEntries(bodyLabels(markWorld()).map((l) => [l.bodyId, l]));
    expect(labels['b-jupiter']!.mark).toEqual({ count: 3, running: false });
    expect(labels['b-ast-7']!.mark).toEqual({ count: 1, running: false });
    expect(labels['b-io']!.mark).toBeUndefined();
    expect(labels['b-venus']!.mark).toBeUndefined(); // a "moved to …" marker
  });

  it('"▶" while one of its commands runs, a detected one included', () => {
    const mark = bodyLabel(markWorld(true), 'b-jupiter')!.mark!;
    expect(mark).toEqual({ count: 3, running: true });
    expect(markText(mark)).toBe('◆ 3 ▶');
    expect(markDescription(mark)).toBe('3 deliverables, a command running');
  });

  it('a running detected command alone shows "▶" only; one deliverable reads singular', () => {
    expect(markText({ count: 0, running: true })).toBe('▶');
    expect(markText({ count: 1, running: false })).toBe('◆ 1');
    expect(markDescription({ count: 1, running: false })).toBe('1 deliverable');
  });

  it('no deliverables in the world (a replay, an older server): no marks', () => {
    expect(bodyLabels(labelWorld()).some((l) => l.mark)).toBe(false);
  });
});

/**
 * P10-07 (decision 143): an area moon of Jupiter's long-term project — Callisto hosts the areas
 * Sales and Feedback (two areas share it), with three jobs between them; Ganymede hosts one area.
 */
function areaWorld(): LabelWorld {
  const w = labelWorld();
  const moon = (id: string, name: string): Body => ({
    id,
    kind: 'moon',
    parentId: 'b-jupiter',
    name,
    host: { kind: 'areas', id: 'p-big' },
  });
  const area = (id: string, name: string, bodyId: string) => ({
    ...fx.area,
    id,
    name,
    projectId: 'p-big',
    bodyId,
  });
  const job = (id: string, areaId: string) => ({ ...fx.job, id, areaId, projectId: 'p-big' });
  return {
    ...w,
    bodies: {
      ...w.bodies,
      'b-callisto': moon('b-callisto', 'Callisto'),
      'b-ganymede': moon('b-ganymede', 'Ganymede'),
    },
    areas: {
      'ar-s': area('ar-s', 'Sales', 'b-callisto'),
      'ar-f': area('ar-f', 'Feedback', 'b-callisto'),
      'ar-o': area('ar-o', 'Ops', 'b-ganymede'),
    },
    jobs: { 'j-1': job('j-1', 'ar-f'), 'j-2': job('j-2', 'ar-f'), 'j-3': job('j-3', 'ar-s') },
  };
}

describe('area moons (P10-07, decision 143)', () => {
  it("names its areas, reads as part of the project, and counts the areas' jobs", () => {
    const label = bodyLabel(areaWorld(), 'b-callisto')!;
    expect(label).toMatchObject({
      kind: 'project',
      title: 'Feedback, Sales',
      fullTitle: 'Feedback, Sales · 3 jobs',
      moon: 'area',
      partOf: 'Big project',
      areas: 2,
      state: 'in_progress',
    });
    expect(label.mark).toBeUndefined(); // the project's deliverables mark stays on its planet
  });

  it('one area: no area count; one job reads singular', () => {
    const world = areaWorld();
    world.jobs = { 'j-9': { ...fx.job, id: 'j-9', areaId: 'ar-o', projectId: 'p-big' } };
    const label = bodyLabel(world, 'b-ganymede')!;
    expect(label).toMatchObject({ title: 'Ops', fullTitle: 'Ops · 1 job', moon: 'area' });
    expect(label.areas).toBeUndefined();
  });

  it('a world without areas (a replay, an older server) falls back to the project name', () => {
    const { areas: _a, jobs: _j, ...world } = areaWorld();
    expect(bodyLabel(world, 'b-callisto')).toMatchObject({
      title: 'Big project',
      fullTitle: 'Big project',
      moon: 'area',
    });
  });

  it('area moons get their own ring; they are never "own project" moons', () => {
    const world = areaWorld();
    expect(areaMoons(world)).toEqual(['b-callisto', 'b-ganymede']);
    expect(independentMoons(world)).toEqual(['b-io']);
    expect(areaMoons(labelWorld())).toEqual([]);
  });
});
