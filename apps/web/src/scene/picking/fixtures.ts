import type { Agent, Body, StatusRecord } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { emptyWorld, type WorldState } from '../../state/reduce.js';

/**
 * A small world for picking's tests (P3-05): the reserved Sun, Earth (the Harmonizer's) and Moon,
 * a free planet, a planet with a moved-away marker, a project with two Waykeepers (an older live
 * one, a newer stopped one), an asteroid task with a Steward, and a project and a task that no
 * agent works on yet.
 */
const body = (b: Body): [string, Body] => [b.id, b];
const agent = (a: Partial<Agent> & Pick<Agent, 'id' | 'role' | 'bodyId'>): [string, Agent] => [
  a.id,
  { ...fx.agent, supervisorId: undefined, taskId: undefined, projectId: undefined, ...a } as Agent,
];
const status = (agentId: string, state: StatusRecord['state']): [string, StatusRecord] => [
  agentId,
  { ...fx.status, agentId, state },
];
const T = (n: number) => `2026-10-0${n}T10:00:00.000Z`;

export function pickingWorld(): WorldState {
  return {
    ...emptyWorld(),
    bodies: Object.fromEntries([
      body({ id: 'b-sun', kind: 'star', name: 'Sun', meta: { reserved: true } }),
      body({ id: 'b-earth', kind: 'planet', name: 'Earth', meta: { orbit: 3, reserved: true } }),
      body({
        id: 'b-moon',
        kind: 'moon',
        parentId: 'b-earth',
        name: 'Moon',
        meta: { reserved: true },
      }),
      body({ id: 'b-mars', kind: 'planet', name: 'Mars' }),
      body({
        id: 'b-venus',
        kind: 'planet',
        name: 'Venus',
        movedTo: { bodyId: 'b-jupiter', host: { kind: 'project', id: 'p-big' }, at: T(1) },
      }),
      body({
        id: 'b-jupiter',
        kind: 'planet',
        name: 'Jupiter',
        host: { kind: 'project', id: 'p-big' },
      }),
      body({
        id: 'b-io',
        kind: 'moon',
        parentId: 'b-jupiter',
        name: 'Io',
        host: { kind: 'project', id: 'p-new' },
      }),
      body({
        id: 'b-ast-7',
        kind: 'asteroid',
        name: '7 Iris',
        host: { kind: 'task', id: 't-ast' },
      }),
      body({
        id: 'b-ast-9',
        kind: 'asteroid',
        name: '9 Metis',
        host: { kind: 'task', id: 't-idle' },
      }),
    ]),
    projects: {
      'p-big': { ...fx.project, id: 'p-big', name: 'Big project', bodyId: 'b-jupiter' },
      'p-new': {
        ...fx.project,
        id: 'p-new',
        name: 'New project',
        bodyId: 'b-io',
        state: 'approved',
      },
    },
    tasks: {
      't-ast': {
        ...fx.asteroidTask,
        id: 't-ast',
        bodyId: 'b-ast-7',
        description: 'Fix the date test',
      },
      't-idle': {
        ...fx.asteroidTask,
        id: 't-idle',
        bodyId: 'b-ast-9',
        description: 'Bump the deps',
        state: 'approved',
      },
      't-in': { ...fx.task, id: 't-in', projectId: 'p-big', bodyId: 'b-jupiter' },
    },
    agents: Object.fromEntries([
      agent({ id: 'a-h', role: 'harmonizer', bodyId: 'b-earth', createdAt: T(1) }),
      agent({
        id: 'a-wk-old',
        role: 'waykeeper',
        bodyId: 'b-jupiter',
        projectId: 'p-big',
        createdAt: T(1),
      }),
      agent({
        id: 'a-wk-new',
        role: 'waykeeper',
        bodyId: 'b-jupiter',
        projectId: 'p-big',
        createdAt: T(2),
      }),
      agent({ id: 'a-st', role: 'steward', bodyId: 'b-ast-7', taskId: 't-ast', createdAt: T(2) }),
      agent({
        id: 'a-st-in',
        role: 'steward',
        bodyId: 'b-jupiter',
        taskId: 't-in',
        createdAt: T(3),
      }),
    ]),
    statuses: Object.fromEntries([
      status('a-h', 'idle'),
      status('a-wk-old', 'working'),
      status('a-wk-new', 'stopped'),
      status('a-st', 'working'),
      status('a-st-in', 'working'),
    ]),
  };
}
