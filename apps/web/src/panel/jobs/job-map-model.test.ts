import { describe, expect, it } from 'vitest';
import type { Job, JobRun, Panel } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { collectNode, highlight, jobMapModel, panelNode, sourceNode } from './job-map-model.js';

const map = {
  sources: [
    { id: 'app_store', label: 'App Store', kind: 'mcp', target: 'appstore' },
    { id: 'crm', label: 'CRM', kind: 'site', target: 'https://crm.example' },
    { id: 'old', label: 'Old feed', kind: 'files', target: '/tmp/feed' },
  ],
  collects: [
    { name: 'Reviews', kind: 'list', sourceIds: ['app_store'], description: 'new reviews' },
    { name: 'Churn (30 days)', kind: 'number', sourceIds: ['crm'], description: 'churn' },
  ],
  steps: [{ text: 'Compare with last month', uses: ['Churn (30 days)'], produces: ['Reviews'] }],
} as unknown as Job['dataMap'];

const job = { ...fx.job, id: 'j-1', dataMap: map } as Job;
const run = (over: Partial<JobRun>): JobRun => ({ ...fx.jobRun, jobId: 'j-1', ...over }) as JobRun;
const panel = (id: string, values: string[]): Panel =>
  ({
    ...fx.panel,
    id,
    title: `Panel ${id}`,
    source: { kind: 'job', jobId: 'j-1', values },
  }) as Panel;

describe('jobMapModel', () => {
  it('marks a source with a reported problem', () => {
    const m = jobMapModel(
      job,
      run({
        sources: [
          { kind: 'mcp', target: 'appstore' },
          { kind: 'site', target: 'https://crm.example' },
        ],
        data: { sourceProblems: [{ sourceId: 'app_store', problem: 'login expired' }] },
      }),
      [],
    );
    const store = m.sources.find((s) => s.id === 'app_store')!;
    expect(store.state).toBe('problem');
    expect(store.problem).toBe('login expired');
    expect(m.sources.find((s) => s.id === 'crm')!.state).toBe('ok');
  });

  it('marks a declared source the run did not use as unused', () => {
    const m = jobMapModel(job, run({ sources: [{ kind: 'mcp', target: 'appstore' }] }), []);
    expect(m.sources.find((s) => s.id === 'old')!.state).toBe('unused');
  });

  it('adds an undeclared source for an unknown MCP server', () => {
    const m = jobMapModel(job, run({ sources: [{ kind: 'mcp', target: 'mystery-server' }] }), []);
    const extra = m.sources.find((s) => s.state === 'undeclared')!;
    expect(extra.kind).toBe('mcp');
    expect(extra.target).toBe('mystery-server');
  });

  it('draws the edges: source to collect, collect to step, step to collect, collect to panel', () => {
    const m = jobMapModel(job, undefined, [panel('pn-1', ['Churn (30 days)'])]);
    const has = (from: string, to: string) => m.edges.some((e) => e.from === from && e.to === to);
    expect(has(sourceNode('crm'), collectNode('Churn (30 days)'))).toBe(true);
    expect(
      m.edges.some((e) => e.from === collectNode('Churn (30 days)') && e.to.startsWith('step:')),
    ).toBe(true);
    expect(m.edges.some((e) => e.to === collectNode('Reviews') && e.from.startsWith('step:'))).toBe(
      true,
    );
    expect(has(collectNode('Churn (30 days)'), panelNode('pn-1'))).toBe(true);
  });

  it('shows only the panels of this job', () => {
    const other = {
      ...panel('pn-2', ['x']),
      source: { kind: 'job', jobId: 'j-9', values: ['x'] },
    } as Panel;
    const m = jobMapModel(job, undefined, [panel('pn-1', ['Reviews']), other]);
    expect(m.shownIn.map((p) => p.panelId)).toEqual(['pn-1']);
  });

  it('with no data map lists only what the last run used', () => {
    const m = jobMapModel(
      { ...job, dataMap: undefined } as Job,
      run({ sources: [{ kind: 'mcp', target: 'appstore' }] }),
      [],
    );
    expect(m.hasMap).toBe(false);
    expect(m.collects).toEqual([]);
    expect(m.sources).toHaveLength(1);
    expect(m.sources[0]!.state).toBe('ok');
  });
});

describe('highlight', () => {
  it('reaches the panel from a source, both ways', () => {
    const m = jobMapModel(job, undefined, [panel('pn-1', ['Churn (30 days)'])]);
    const fromSource = highlight(m, sourceNode('crm'));
    expect(fromSource.has(panelNode('pn-1'))).toBe(true);
    const fromPanel = highlight(m, panelNode('pn-1'));
    expect(fromPanel.has(sourceNode('crm'))).toBe(true);
    expect(fromSource.has(sourceNode('app_store'))).toBe(false);
  });
});
