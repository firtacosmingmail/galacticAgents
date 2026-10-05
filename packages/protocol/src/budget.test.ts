import { describe, expect, it } from 'vitest';
import {
  budgetLevel,
  budgetUsage,
  foldSpend,
  formatUsd,
  projectFamily,
  type AgentSpend,
} from './budget.js';
import type { Agent, Project, Task } from './domain.js';
import type { Event } from './events.js';

const T = '2026-10-05T10:00:00.000Z';
const caps = { maxWallClockMs: 60_000, maxToolCalls: 10 };

function fold(events: Event[], start?: AgentSpend): AgentSpend | undefined {
  let s = start;
  events.forEach((event, i) => {
    s = foldSpend(s, { seq: i + 1, event }) ?? s;
  });
  return s;
}

const spawned = (sessionRef?: string): Event => ({
  type: 'agent.spawned',
  agentId: 'a-1',
  role: 'steward',
  runtime: 'claude-sdk',
  bodyId: 'b-1',
  ...(sessionRef ? { sessionRef } : {}),
});
const idle = (usd?: number): Event => ({
  type: 'agent.idle',
  agentId: 'a-1',
  ...(usd !== undefined ? { cost: { usd } } : {}),
});

describe('foldSpend (P8-01)', () => {
  it('keeps the highest cumulative figure of a session: repeated reports never add up', () => {
    const s = fold([spawned('s1'), idle(0.1), idle(0.25), idle(0.25)]);
    expect(s).toMatchObject({ usd: 0.25, reported: true, session: 's1', sessions: { s1: 0.25 } });
  });

  it('a resume of the same session continues its meter; a fresh session adds a new one', () => {
    // The SDK resumes a session under the same ref and continues from its saved total (P1-08).
    const resumed = fold([spawned('s1'), idle(0.2), spawned('s1'), idle(0.18), idle(0.3)]);
    expect(resumed?.usd).toBeCloseTo(0.3);
    // A brain's session reset opens a new session whose meter starts at zero.
    const renewed = fold([spawned('s1'), idle(0.2), spawned('s2'), idle(0.05)]);
    expect(renewed?.usd).toBeCloseTo(0.25);
    expect(renewed?.sessions).toEqual({ s1: 0.2, s2: 0.05 });
  });

  it('a spawn without a ref is a session of its own (it cannot be a resume)', () => {
    const s = fold([spawned(), idle(0.1), spawned(), idle(0.1)]);
    expect(s?.usd).toBeCloseTo(0.2);
  });

  it('a report without dollars changes nothing: the agent stays "cost not reported"', () => {
    const s = fold([
      spawned('s1'),
      idle(),
      { type: 'agent.finished', agentId: 'a-1', cost: { inputTokens: 10 } },
    ]);
    expect(s).toMatchObject({ usd: 0, reported: false });
  });

  it('folds the end reports and ignores other events', () => {
    expect(
      fold([
        spawned('s1'),
        { type: 'agent.failed', agentId: 'a-1', error: 'x', reason: 'crash', cost: { usd: 0.4 } },
      ])?.usd,
    ).toBeCloseTo(0.4);
    expect(foldSpend(undefined, { seq: 1, event: { type: 'body.freed', bodyId: 'b' } })).toBe(
      undefined,
    );
  });
});

const project = (id: string, extra: Partial<Project> = {}): Project => ({
  id,
  name: id,
  workspace: `/w/${id}`,
  bodyId: `b-${id}`,
  state: 'in_progress',
  createdAt: T,
  updatedAt: T,
  ...extra,
});
const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  bodyId: `b-${id}`,
  description: id,
  priority: 'normal',
  blockedBy: [],
  state: 'in_progress',
  createdAt: T,
  updatedAt: T,
  ...extra,
});
const agent = (id: string, extra: Partial<Agent>): Agent => ({
  id,
  role: 'steward',
  runtime: 'fake',
  bodyId: 'b',
  caps,
  createdAt: T,
  updatedAt: T,
  ...extra,
});
const spend = (agentId: string, usd: number, reported = true): AgentSpend => ({
  agentId,
  usd,
  reported,
  session: 's',
  sessions: reported ? { s: usd } : {},
});

describe('budgetUsage (P8-01)', () => {
  const projects = [
    project('p', { budgetUsd: 1 }),
    project('sub', { parentProjectId: 'p' }),
    project('other'),
  ];
  const tasks = [
    task('t1', { projectId: 'p', budgetUsd: 0.5 }),
    task('t2', { projectId: 'sub' }),
    task('ast'),
  ];
  const agents = [
    agent('wk', { role: 'waykeeper', projectId: 'p' }),
    agent('s1', { taskId: 't1', projectId: 'p' }),
    agent('s2', { taskId: 't2', projectId: 'sub' }),
    agent('s3', { taskId: 'ast' }),
    agent('hq', { role: 'harmonizer' }),
  ];
  const spends: Record<string, AgentSpend> = {
    wk: spend('wk', 0.1),
    s1: spend('s1', 0.45),
    s2: spend('s2', 0.3),
    s3: spend('s3', 2),
    hq: spend('hq', 5),
  };
  const world = { projects, tasks, agents, spend: (id: string) => spends[id] };

  it('a project counts its Waykeeper, its tasks and its sub-projects; never the Harmonizer', () => {
    expect([...projectFamily(projects, 'p')].sort()).toEqual(['p', 'sub']);
    const u = budgetUsage(world, { kind: 'project', id: 'p' });
    expect(u.spentUsd).toBeCloseTo(0.85);
    expect(u).toMatchObject({ budgetUsd: 1, agents: 3, unreported: 0, level: 'warning' });
  });

  it('a task counts its Stewards', () => {
    const u = budgetUsage(world, { kind: 'task', id: 't1' }, 95);
    expect(u).toMatchObject({ spentUsd: 0.45, budgetUsd: 0.5, level: 'ok' });
    expect(budgetUsage(world, { kind: 'task', id: 't1' }).level).toBe('warning');
  });

  it('no budget: level none; unknown work: nothing', () => {
    expect(budgetUsage(world, { kind: 'task', id: 'ast' })).toMatchObject({
      level: 'none',
      spentUsd: 2,
    });
    expect(budgetUsage(world, { kind: 'project', id: 'nope' })).toMatchObject({
      agents: 0,
      spentUsd: 0,
      level: 'none',
      reported: true,
    });
  });

  it('agents that never reported a cost count as nothing and are reported as such', () => {
    const quiet = {
      ...world,
      spend: (id: string) => (id === 's1' ? spend('s1', 0, false) : undefined),
    };
    const u = budgetUsage(quiet, { kind: 'task', id: 't1' });
    expect(u).toMatchObject({ spentUsd: 0, reported: false, unreported: 1, level: 'ok' });
  });

  it('levels and money', () => {
    expect(budgetLevel(1, 1)).toBe('exceeded');
    expect(budgetLevel(0.8, 1)).toBe('warning');
    expect(budgetLevel(0.79, 1)).toBe('ok');
    expect(budgetLevel(5, undefined)).toBe('none');
    expect(formatUsd(0.0042)).toBe('$0.0042');
    expect(formatUsd(0.2)).toBe('$0.20');
    expect(formatUsd(12.5)).toBe('$12.50');
    expect(formatUsd(0)).toBe('$0.00');
  });
});
