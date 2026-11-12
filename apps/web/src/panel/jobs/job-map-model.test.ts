import { describe, expect, it } from 'vitest';
import type { Job, JobRun, JobSource, Panel, UsedSource } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import {
  collectNode,
  highlight,
  isRecordedKind,
  jobMapModel,
  panelNode,
  sourceMatches,
  sourceNode,
} from './job-map-model.js';

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
  it('marks a source with a problem the newest run reported', () => {
    const m = jobMapModel(
      job,
      [
        run({
          outcome: 'quiet',
          sources: [
            { kind: 'mcp', target: 'appstore' },
            { kind: 'site', target: 'crm.example' },
          ],
          data: { sourceProblems: [{ sourceId: 'app_store', problem: 'login expired' }] },
        }),
      ],
      [],
    );
    const store = m.sources.find((s) => s.id === 'app_store')!;
    expect(store.state).toBe('problem');
    expect(store.problem).toBe('login expired');
    expect(m.sources.find((s) => s.id === 'crm')!.state).toBe('ok');
  });

  it('a problem comes from the newest run even when it failed', () => {
    const m = jobMapModel(
      job,
      [
        run({
          id: 'jr-new',
          outcome: 'failed',
          data: { sourceProblems: [{ sourceId: 'crm', problem: 'down' }] },
        }),
        run({ id: 'jr-old', outcome: 'quiet', sources: [{ kind: 'mcp', target: 'appstore' }] }),
      ],
      [],
    );
    expect(m.sources.find((s) => s.id === 'crm')).toMatchObject({
      state: 'problem',
      problem: 'down',
    });
  });

  it('marks a declared source the last good run did not use as unused', () => {
    const m = jobMapModel(
      job,
      [run({ outcome: 'findings', sources: [{ kind: 'mcp', target: 'appstore' }] })],
      [],
    );
    expect(m.sources.find((s) => s.id === 'old')!.state).toBe('unused');
    expect(m.sources.find((s) => s.id === 'crm')!.state).toBe('unused');
    expect(m.sources.find((s) => s.id === 'app_store')!.state).toBe('ok');
  });

  it('judges against the newest ended quiet or findings run with sources, skipping the rest', () => {
    const m = jobMapModel(
      job,
      [
        run({ id: 'jr-4', outcome: 'running' }),
        run({ id: 'jr-3', outcome: 'failed', sources: [{ kind: 'mcp', target: 'other' }] }),
        run({ id: 'jr-2', outcome: 'interrupted' }),
        run({
          id: 'jr-1',
          outcome: 'quiet',
          sources: [
            { kind: 'mcp', target: 'AppStore' },
            { kind: 'files', target: '/tmp/feed/2026' },
          ],
        }),
      ],
      [],
    );
    expect(m.sources.find((s) => s.id === 'app_store')!.state).toBe('ok');
    expect(m.sources.find((s) => s.id === 'old')!.state).toBe('ok');
    expect(m.sources.find((s) => s.id === 'crm')!.state).toBe('unused');
    expect(m.sources.some((s) => s.state === 'undeclared')).toBe(false);
    // The header still shows the newest run.
    expect(m.header.lastRun?.outcome).toBe('running');
  });

  it('with no good run to judge by, shows no used or unused state', () => {
    for (const runs of [
      [],
      [run({ outcome: 'running' })],
      [run({ outcome: 'failed', sources: [{ kind: 'mcp', target: 'appstore' }] })],
      [run({ outcome: 'quiet' })],
    ]) {
      const m = jobMapModel(job, runs, []);
      expect(m.sources.map((s) => s.state)).toEqual(['unknown', 'unknown', 'unknown']);
    }
  });

  it('adds an undeclared source for an unknown MCP server', () => {
    const m = jobMapModel(
      job,
      [run({ outcome: 'quiet', sources: [{ kind: 'mcp', target: 'mystery-server' }] })],
      [],
    );
    const extra = m.sources.find((s) => s.state === 'undeclared')!;
    expect(extra.kind).toBe('mcp');
    expect(extra.target).toBe('mystery-server');
  });

  it('a database, command or other source is never judged: no used or unused state', () => {
    const neutral = {
      ...job,
      dataMap: {
        sources: [
          { id: 'db', label: 'DB', kind: 'database', target: 'shop.sqlite' },
          { id: 'cmd', label: 'Script', kind: 'command', target: 'npm run stats' },
          { id: 'x', label: 'Other', kind: 'other', target: 'a person' },
        ],
        collects: [],
        steps: [],
      },
    } as unknown as Job;
    const m = jobMapModel(
      neutral,
      [run({ outcome: 'quiet', sources: [{ kind: 'mcp', target: 'appstore' }] })],
      [],
    );
    expect(m.sources.filter((s) => !s.id.startsWith('undeclared:')).map((s) => s.state)).toEqual([
      'unknown',
      'unknown',
      'unknown',
    ]);
  });

  it('draws the edges: source to collect, collect to step, step to collect, collect to panel', () => {
    const m = jobMapModel(job, [], [panel('pn-1', ['Churn (30 days)'])]);
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
    const m = jobMapModel(job, [], [panel('pn-1', ['Reviews']), other]);
    expect(m.shownIn.map((p) => p.panelId)).toEqual(['pn-1']);
  });

  it('with no data map lists only what the last good run used', () => {
    const m = jobMapModel(
      { ...job, dataMap: undefined } as Job,
      [run({ outcome: 'quiet', sources: [{ kind: 'mcp', target: 'appstore' }] })],
      [],
    );
    expect(m.hasMap).toBe(false);
    expect(m.collects).toEqual([]);
    expect(m.sources).toHaveLength(1);
    expect(m.sources[0]!.state).toBe('ok');
  });
});

describe('sourceMatches', () => {
  const d = (kind: string, target: string) => ({ kind, target }) as JobSource;
  const u = (kind: string, target: string) => ({ kind, target }) as UsedSource;

  it('mcp: the server name, ignoring case', () => {
    expect(sourceMatches(d('mcp', 'PostHog'), u('mcp', 'posthog'))).toBe(true);
    expect(sourceMatches(d('mcp', 'posthog'), u('mcp', 'stripe'))).toBe(false);
    expect(sourceMatches(d('mcp', 'posthog'), u('site', 'posthog'))).toBe(false);
  });

  it('site: a declared URL or host matches the same host or a subdomain of it', () => {
    expect(sourceMatches(d('site', 'https://posthog.com/docs'), u('site', 'posthog.com'))).toBe(
      true,
    );
    expect(sourceMatches(d('site', 'posthog.com'), u('site', 'posthog.com'))).toBe(true);
    expect(sourceMatches(d('site', 'posthog.com'), u('site', 'api.posthog.com'))).toBe(true);
    expect(sourceMatches(d('site', 'https://PostHog.com'), u('site', 'eu.api.posthog.com'))).toBe(
      true,
    );
    expect(sourceMatches(d('site', 'posthog.com'), u('site', 'notposthog.com'))).toBe(false);
    expect(sourceMatches(d('site', 'api.posthog.com'), u('site', 'posthog.com'))).toBe(false);
  });

  it('files: a used folder matches the declared one or a folder inside it', () => {
    expect(sourceMatches(d('files', '/data/feed'), u('files', '/data/feed'))).toBe(true);
    expect(sourceMatches(d('files', '/data/feed/'), u('files', '/data/feed/2026/11'))).toBe(true);
    expect(sourceMatches(d('files', '/data/feed'), u('files', '/data/feeds'))).toBe(false);
    expect(sourceMatches(d('files', '/data/feed'), u('files', '/data'))).toBe(false);
  });

  it('database, command and other never match: they are not recorded', () => {
    for (const kind of ['database', 'command', 'other']) {
      expect(sourceMatches(d(kind, 'x'), u(kind, 'x'))).toBe(false);
      expect(isRecordedKind(kind as JobSource['kind'])).toBe(false);
    }
    for (const kind of ['mcp', 'site', 'files'] as const) expect(isRecordedKind(kind)).toBe(true);
  });
});

describe('highlight', () => {
  it('reaches the panel from a source, both ways', () => {
    const m = jobMapModel(job, [], [panel('pn-1', ['Churn (30 days)'])]);
    const fromSource = highlight(m, sourceNode('crm'));
    expect(fromSource.has(panelNode('pn-1'))).toBe(true);
    const fromPanel = highlight(m, panelNode('pn-1'));
    expect(fromPanel.has(sourceNode('crm'))).toBe(true);
    expect(fromSource.has(sourceNode('app_store'))).toBe(false);
  });
});
