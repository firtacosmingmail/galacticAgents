import { describe, expect, it } from 'vitest';
import type {
  Agent,
  AgentState,
  Project,
  Proposal,
  Question,
  SettingsCaps,
  StatusRecord,
  Task,
} from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { emptyWorld, type WorldState } from '../../state/reduce.js';
import {
  addCost,
  formatCostTotal,
  narrativeRequest,
  nearCap,
  NO_COST,
  projectStatus,
  systemStatus,
  taskStatus,
} from './status-model.js';

const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const CAPS: SettingsCaps = {
  maxConcurrentAgents: 4,
  maxStewardsPerWaykeeper: 2,
  maxSpawnsPerHour: 30,
  maxSpawnsPerHourPerBrain: 20,
  maxWallClockMs: 7_200_000,
  maxToolCalls: 500,
};

const project = (id: string, extra: Partial<Project> = {}): Project => ({
  ...fx.project,
  id,
  name: `Project ${id}`,
  ...extra,
});
const { projectId: _fixtureProject, ...standalone } = fx.task;
const task = (id: string, extra: Partial<Task> = {}): Task => ({
  ...standalone,
  id,
  description: `Task ${id}`,
  ...extra,
});
const agent = (id: string, extra: Partial<Agent>): Agent => ({
  ...fx.agent,
  id,
  createdAt: at(2 * 3_600_000),
  ...extra,
});
const status = (agentId: string, state: AgentState, extra: Partial<StatusRecord> = {}) =>
  ({
    ...fx.status,
    agentId,
    state,
    startedAt: at(60_000),
    lastEventAt: at(1_000),
    costSoFar: { usd: 0.5 },
    caps: { wallClockMs: { used: 0, limit: 3_600_000 }, toolCalls: { used: 1, limit: 500 } },
    ...extra,
  }) satisfies StatusRecord;
const question = (id: string, extra: Partial<Question>): Question => ({
  ...fx.question,
  id,
  ...extra,
});

function world(parts: {
  projects?: Project[];
  tasks?: Task[];
  agents?: Agent[];
  statuses?: StatusRecord[];
  questions?: Question[];
  proposals?: Proposal[];
}): WorldState {
  const byId = <T extends { id: string }>(xs: T[] = []) =>
    Object.fromEntries(xs.map((x) => [x.id, x]));
  return {
    ...emptyWorld(),
    projects: byId(parts.projects),
    tasks: byId(parts.tasks),
    agents: byId(parts.agents),
    questions: byId(parts.questions),
    proposals: byId(parts.proposals),
    statuses: Object.fromEntries((parts.statuses ?? []).map((s) => [s.agentId, s])),
  };
}

/** A small system: one project with three tasks, an asteroid, a Harmonizer asking the user. */
function system(): WorldState {
  return world({
    projects: [project('p-1', { state: 'in_progress' }), project('p-old', { state: 'archived' })],
    tasks: [
      task('t-run', { projectId: 'p-1', state: 'in_progress', createdAt: at(50_000) }),
      task('t-block', { projectId: 'p-1', state: 'blocked_on_user', createdAt: at(40_000) }),
      task('t-fail', { projectId: 'p-1', state: 'failed', createdAt: at(30_000) }),
      task('t-ast', { state: 'interrupted', bodyId: 'b-ast-1', createdAt: at(20_000) }),
    ],
    agents: [
      { ...fx.harmonizer, createdAt: at(10 * 3_600_000) },
      agent('a-wk', { role: 'waykeeper', projectId: 'p-1', supervisorId: 'a-harmonizer' }),
      agent('a-run', { taskId: 't-run', supervisorId: 'a-wk', createdAt: at(10_000) }),
      agent('a-block', { taskId: 't-block', supervisorId: 'a-wk' }),
      agent('a-fail', { taskId: 't-fail', supervisorId: 'a-wk' }),
      agent('a-ast', { taskId: 't-ast', supervisorId: 'a-harmonizer' }),
    ],
    statuses: [
      status('a-harmonizer', 'idle', { costSoFar: { usd: 1 } }),
      status('a-wk', 'working', { costSoFar: { inputTokens: 1_000, outputTokens: 500 } }),
      status('a-run', 'stalled'),
      status('a-block', 'waiting_for_input', {
        caps: { wallClockMs: { used: 0, limit: 3_600_000 }, toolCalls: { used: 450, limit: 500 } },
      }),
      status('a-fail', 'failed', { lastEventAt: at(30 * 3_600_000) }),
      status('a-ast', 'interrupted'),
    ],
    questions: [
      question('q-perm', {
        kind: 'permission',
        originAgentId: 'a-block',
        holder: { type: 'user' },
        createdAt: at(5_000),
      }),
      question('q-clar', {
        kind: 'clarification',
        originAgentId: 'a-run',
        holder: { type: 'agent', id: 'a-wk' },
      }),
      question('q-hq', {
        kind: 'clarification',
        originAgentId: 'a-harmonizer',
        holder: { type: 'user' },
      }),
      question('q-done', { originAgentId: 'a-run', status: 'answered' }),
    ],
    proposals: [{ ...fx.proposal, state: 'pending' }],
  });
}

describe('systemStatus', () => {
  const s = systemStatus(system(), { now: NOW, caps: CAPS });

  it('counts projects and tasks by work state, blocked on you first', () => {
    expect(s.projects).toEqual([
      { state: 'in_progress', count: 1 },
      { state: 'archived', count: 1 },
    ]);
    expect(s.tasks.map((c) => c.state)).toEqual([
      'blocked_on_user',
      'in_progress',
      'interrupted',
      'failed',
    ]);
  });

  it('counts the agents with a status record by state, waiting for input first', () => {
    expect(s.agents[0]).toEqual({ state: 'waiting_for_input', count: 1 });
    expect(s.agents.reduce((n, c) => n + c.count, 0)).toBe(6);
    expect(s.live).toEqual({ stewards: 2, waykeepers: 1, harmonizer: 'idle' });
  });

  it('lists what needs attention: blocked on you first, then failed, interrupted, stalled, caps', () => {
    expect(s.attention.map((a) => `${a.tone} ${a.key}`)).toEqual([
      // the Harmonizer's own ask_user: no work is marked blocked, its agent stands for it (and
      // within a tone the oldest comes first)
      'blocked agent:a-harmonizer:blocked',
      'blocked task:t-block:blocked',
      'failed task:t-fail:failed',
      'interrupted task:t-ast:interrupted',
      'stalled agent:a-run:stalled',
      'cap agent:a-block:cap',
    ]);
    const blocked = s.attention[1]!;
    expect(blocked.detail).toBe('1 question for you');
    expect(blocked.selection).toEqual({ kind: 'steward', id: 'a-block' });
    expect(s.attention[0]!.selection).toEqual({ kind: 'harmonizer' });
    expect(s.attention.at(-1)!.detail).toBe('tool calls 450 / 500');
  });

  it('leaves archived work out of the attention list', () => {
    const w = system();
    w.tasks['t-fail'] = { ...w.tasks['t-fail']!, state: 'archived' };
    const keys = systemStatus(w, { now: NOW }).attention.map((a) => a.key);
    expect(keys).not.toContain('task:t-fail:failed');
  });

  it('counts open questions by kind and holder, and the waiting number of the top bar', () => {
    expect(s.questions).toEqual({
      open: 3,
      byKind: { permission: 1, clarification: 2 },
      forUser: 2,
      bySupervisors: 1,
    });
    expect(s.cards).toBe(1);
    expect(s.waiting).toBe(3); // two questions for the user + one card
  });

  it('sums the cost: dollars, tokens of agents without dollars, today and by role', () => {
    expect(s.cost.total).toEqual({ usd: 1 + 0.5 * 4, tokens: 1_500, agents: 6 });
    // a-fail's last event was 30 h ago: not today
    expect(s.cost.today.usd).toBeCloseTo(2.5);
    expect(s.cost.brains).toEqual({ usd: 1, tokens: 1_500, agents: 2 });
    expect(s.cost.stewards.usd).toBeCloseTo(2);
  });

  it('measures the caps: live Stewards against the concurrency cap, spawns in the last hour', () => {
    expect(s.caps.liveStewards).toEqual({ used: 2, limit: 4 });
    expect(s.caps.spawnsLastHour).toEqual({ used: 1, limit: 30 });
    expect(systemStatus(system(), { now: NOW }).caps.liveStewards.limit).toBeUndefined();
  });

  it('counts "today" as the lifetime cost of the agents active today (no per-day split)', () => {
    // a-fail's whole cost is out (its last event was 30 h ago); everyone else's whole cost is in
    expect(s.cost.today.agents).toBe(5);
    expect(s.cost.today.usd).toBeCloseTo(s.cost.total.usd - 0.5);
  });

  it('folds a blocked task into its blocked project: one question, one entry', () => {
    const w = system();
    w.projects['p-1'] = { ...w.projects['p-1']!, state: 'blocked_on_user' };
    const keys = systemStatus(w, { now: NOW }).attention.filter((a) => a.tone === 'blocked');
    expect(keys.map((a) => a.key).sort()).toEqual([
      'agent:a-harmonizer:blocked',
      'project:p-1:blocked',
    ]);
    expect(keys.find((a) => a.kind === 'project')!.detail).toBe(
      '1 question for you · 1 blocked task',
    );
    // a blocked task of a project that is not blocked keeps its own entry (the fixture above)
    expect(s.attention.map((a) => a.key)).toContain('task:t-block:blocked');
  });

  it('leaves the scene harness out and reads the current Harmonizer (newest live)', () => {
    const w = system();
    const harness = { harness: true };
    // a newer Harmonizer that ended, and an older live one: the live one is the Harmonizer
    w.agents['a-harmonizer-old'] = { ...fx.harmonizer, id: 'a-harmonizer-old', createdAt: at(1) };
    w.statuses['a-harmonizer-old'] = status('a-harmonizer-old', 'finished');
    w.agents['a-harmonizer'] = { ...w.agents['a-harmonizer']!, createdAt: at(20 * 3_600_000) };
    // a harness Harmonizer and a harness Steward: stalled, near a cap, asking, costing, just spawned
    w.agents['a-fake-h'] = { ...fx.harmonizer, id: 'a-fake-h', createdAt: at(0), meta: harness };
    w.statuses['a-fake-h'] = status('a-fake-h', 'working', { costSoFar: { usd: 100 } });
    w.agents['a-fake'] = agent('a-fake', { taskId: 't-run', createdAt: at(1_000), meta: harness });
    w.statuses['a-fake'] = status('a-fake', 'stalled', { costSoFar: { usd: 100 } });
    w.questions['q-fake'] = question('q-fake', {
      originAgentId: 'a-fake',
      holder: { type: 'user' },
    });
    const h = systemStatus(w, { now: NOW, caps: CAPS });
    expect(h.live.harmonizer).toBe('idle');
    expect(h.attention.map((a) => a.id)).not.toContain('a-fake');
    expect(h.attention.map((a) => a.id)).not.toContain('a-fake-h');
    expect(h.cost.total.usd).toBeCloseTo(s.cost.total.usd + 0.5); // + the old Harmonizer
    expect(h.caps).toEqual(s.caps);
    expect(h.agents.reduce((n, c) => n + c.count, 0)).toBe(7); // the old Harmonizer joins
    // the inbox's numbers still count the harness's question
    expect(h.waiting).toBe(s.waiting + 1);
  });

  it('is empty but well formed for an empty world', () => {
    const e = systemStatus(emptyWorld(), { now: NOW });
    expect(e.attention).toEqual([]);
    expect(e.cost.total).toEqual(NO_COST);
    expect(e.live.harmonizer).toBeUndefined();
  });
});

describe('projectStatus', () => {
  function withRespawn(): WorldState {
    const w = system();
    // t-run had a first Steward that failed; the second (a-run) runs now
    w.agents['a-run0'] = agent('a-run0', { taskId: 't-run', createdAt: at(3 * 3_600_000) });
    w.statuses['a-run0'] = status('a-run0', 'failed', { costSoFar: { usd: 2 } });
    w.projects['p-sub'] = project('p-sub', { parentProjectId: 'p-1', state: 'blocked_on_user' });
    w.tasks['t-gone'] = task('t-gone', { projectId: 'p-1', state: 'archived' });
    // a question for the user on a running task the projection has not marked yet
    w.questions['q-run'] = question('q-run', {
      kind: 'permission',
      originAgentId: 'a-run',
      holder: { type: 'user' },
    });
    return w;
  }

  it('lists its tasks blocked first, then by state, archived ones only counted', () => {
    const p = projectStatus(withRespawn(), 'p-1', { now: NOW, caps: CAPS })!;
    expect(p.rows.map((r) => [r.task.id, r.blocked])).toEqual([
      ['t-block', true],
      ['t-run', true],
      ['t-fail', false],
    ]);
    expect(p.archivedTasks).toBe(1);
    expect(p.tasks[0]).toEqual({ state: 'blocked_on_user', count: 1 });
  });

  it('opens the newest live Steward and sums every Steward a task had', () => {
    const p = projectStatus(withRespawn(), 'p-1', { now: NOW })!;
    const run = p.rows.find((r) => r.task.id === 't-run')!;
    expect(run.steward?.id).toBe('a-run');
    expect(run.stewards).toBe(2);
    expect(run.cost.usd).toBeCloseTo(2.5);
    expect(run.selection).toEqual({ kind: 'steward', id: 'a-run' });
  });

  it('puts the blocked items first in its attention list', () => {
    const p = projectStatus(withRespawn(), 'p-1', { now: NOW })!;
    // within a tone, oldest first: t-run is older than t-block
    expect(p.attention.map((a) => `${a.tone} ${a.key}`)).toEqual([
      'blocked task:t-run:blocked',
      'blocked task:t-block:blocked',
      'failed task:t-fail:failed',
      'stalled agent:a-run:stalled',
      'cap agent:a-block:cap',
    ]);
  });

  it('counts its Stewards against the per-Waykeeper cap, its questions, its cost', () => {
    const p = projectStatus(withRespawn(), 'p-1', { now: NOW, caps: CAPS })!;
    expect(p.stewardCap).toEqual({ used: 2, limit: 2 });
    expect(p.stewards).toEqual({ active: 2, total: 3 });
    expect(p.questions).toEqual({
      open: 3,
      byKind: { permission: 2, clarification: 1 },
      forUser: 2,
      bySupervisors: 1,
    });
    // Waykeeper (tokens) + a-run, a-block, a-fail, a-run0 (dollars); not the asteroid's Steward
    expect(p.cost).toEqual({ usd: 0.5 * 3 + 2, tokens: 1_500, agents: 5 });
    expect(p.waykeeper?.id).toBe('a-wk');
  });

  it('lists its sub-projects', () => {
    const p = projectStatus(withRespawn(), 'p-1', { now: NOW })!;
    expect(p.subProjects.map((s) => [s.project.id, s.blocked])).toEqual([['p-sub', true]]);
    expect(projectStatus(withRespawn(), 'p-sub', { now: NOW })!.parent?.id).toBe('p-1');
  });

  it('is undefined for an unknown project', () => {
    expect(projectStatus(system(), 'p-nope', { now: NOW })).toBeUndefined();
  });
});

describe('taskStatus', () => {
  it('adds what the Steward header lacks: runs, total cost, questions, silence', () => {
    const w = system();
    w.agents['a-run0'] = agent('a-run0', { taskId: 't-run', createdAt: at(3 * 3_600_000) });
    w.statuses['a-run0'] = status('a-run0', 'failed', { costSoFar: { usd: 2 } });
    const t = taskStatus(w, 't-run', { now: NOW, agentId: 'a-run' })!;
    expect(t.stewards).toBe(2);
    expect(t.cost.usd).toBeCloseTo(2.5);
    expect(t.questions.byKind.clarification).toBe(1);
    expect(t.silentForMs).toBe(1_000);
    expect(t.project?.id).toBe('p-1');
    expect(taskStatus(w, 't-nope', { now: NOW })).toBeUndefined();
  });
});

describe('helpers', () => {
  it('formats a cost total', () => {
    expect(formatCostTotal(NO_COST)).toBe('—');
    expect(formatCostTotal({ usd: 0.042, tokens: 0, agents: 1 })).toBe('$0.0420');
    expect(formatCostTotal({ usd: 12.5, tokens: 0, agents: 1 })).toBe('$12.50');
    expect(formatCostTotal({ usd: 0, tokens: 12_000, agents: 1 })).toBe('12,000 tokens');
    expect(formatCostTotal({ usd: 1, tokens: 4_000, agents: 2 })).toBe('$1.00 + 4,000 tokens');
  });

  it('never counts an agent’s tokens next to its dollars', () => {
    const s = status('a', 'working', { costSoFar: { usd: 1, inputTokens: 9, outputTokens: 9 } });
    expect(addCost(NO_COST, s)).toEqual({ usd: 1, tokens: 0, agents: 1 });
    expect(addCost(NO_COST, undefined)).toBe(NO_COST);
  });

  it('flags a live agent near a cap, never an ended one', () => {
    const clock = status('a', 'working', {
      startedAt: at(3_000_000),
      caps: { wallClockMs: { used: 0, limit: 3_600_000 }, toolCalls: { used: 1, limit: 500 } },
    });
    expect(nearCap(clock, NOW)).toBe('wall clock 83% of its cap');
    expect(nearCap({ ...clock, state: 'finished' }, NOW)).toBeUndefined();
    // A brain has no wall-clock cap to be near (P8-10, decision 103).
    const brain = {
      ...clock,
      caps: { ...clock.caps, wallClockMs: { used: 0, limit: 3_600_000, capped: false } },
    };
    expect(nearCap(brain, NOW)).toBeUndefined();
  });

  it('words the narrative request', () => {
    expect(narrativeRequest({ kind: 'system' })).toMatch(/whole system/);
    expect(narrativeRequest({ kind: 'project', project: project('p-9') })).toMatch(
      /"Project p-9" \(p-9\)/,
    );
  });
});
