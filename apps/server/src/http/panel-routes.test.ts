import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConversationResponse,
  DEFAULT_PERMISSION_POLICY,
  NotificationsResponse,
  PreflightResponse,
  SettingsResponse,
  TranscriptResponse,
  type Actor,
  type AgentRole,
  type ConversationEntry,
  type Event,
  type Question,
  type RuntimePreflight,
} from '@galactic/protocol';
import { ClaudeSdkAdapter } from '../adapters/claude-sdk/claude-sdk-adapter.js';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { loadConfig } from '../config/config.js';
import { SettingsService } from '../config/settings.js';
import { openDatabase } from '../db/database.js';
import { createAgent } from '../domain/agents.js';
import { EventLog } from '../domain/event-log.js';
import {
  globalDefaultPolicy,
  resolvePolicy,
  setGlobalDefaultPolicy,
} from '../domain/permissions.js';
import { composeRuntime, type ComposedRuntime } from '../runtime/compose.js';
import { History } from '../runtime/history.js';
import { ProcessSupervisor } from '../runtime/supervisor.js';
import { TranscriptPipeline } from '../runtime/transcripts.js';
import { startTestApp, testConfig, TEST_TOKEN } from '../test/harness.js';

type TestApp = Awaited<ReturnType<typeof startTestApp>>;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  setGlobalDefaultPolicy(null);
});

const get = async (t: TestApp, path: string, headers: Record<string, string> = {}) => {
  const res = await fetch(`${t.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${TEST_TOKEN}`, ...headers },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const patch = async (t: TestApp, body: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${t.baseUrl}/api/settings`, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${TEST_TOKEN}`,
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

/** A clock that advances one second per reading, from `start`; `hold()` repeats the next reading. */
function clock(start = Date.parse('2026-10-02T10:00:00.000Z')) {
  let t = start;
  let held = false;
  return {
    now: () => {
      const at = new Date(t).toISOString();
      if (!held) t += 1000;
      return at;
    },
    hold: (on: boolean) => {
      held = on;
    },
  };
}

/** A log with an agent and a transcript pipeline on the same database, both clocked. */
async function historyApp(pipeline: { holdMs?: number; flushMs?: number } = {}) {
  const db = openDatabase(':memory:');
  const c = clock();
  const log = new EventLog(db, { now: c.now });
  const transcripts = new TranscriptPipeline(db, {
    now: c.now,
    holdMs: 0,
    flushMs: 1,
    ...pipeline,
  });
  const agent = (id: string, role: AgentRole) =>
    log.runCommand((ctx) =>
      createAgent(ctx, {
        agentId: id,
        role,
        runtime: 'fake',
        caps: { maxWallClockMs: 60_000, maxToolCalls: 10 },
      }),
    );
  agent('h1', 'harmonizer');
  agent('w1', 'waykeeper');
  let n = 0;
  const message = (agentId: string, text: string, sender: Actor = { type: 'user' }) =>
    log.runCommand((ctx) =>
      ctx.emit({
        type: 'message.sent',
        messageId: `msg-${++n}`,
        agentId,
        sender,
        text,
        interrupt: false,
      }),
    );
  const output = (agentId: string, kind: 'text' | 'tool' | 'thinking', text: string) => {
    transcripts.append(agentId, kind, text);
    transcripts.flush();
  };
  const t = await startTestApp({ log, transcripts });
  cleanups.push(
    () => t.stop(),
    () => transcripts.dispose(),
  );
  return { t, log, transcripts, message, output, clock: c };
}

describe('GET /api/agents/:id/conversation (P25-01)', () => {
  it('gives the persisted lastSeq, so a reply still buffered arrives on the stream', async () => {
    const { t, transcripts, output } = await historyApp({ holdMs: 60_000, flushMs: 60_000 });
    output('h1', 'text', 'persisted');
    transcripts.append('h1', 'text', 'still buffered'); // no flush yet
    expect(transcripts.lastSeq('h1')).toBe(2);
    const page = ConversationResponse.parse((await get(t, '/api/agents/h1/conversation')).body);
    expect(page.entries.map((e) => e.text)).toEqual(['persisted']);
    expect(page.lastSeq).toBe(1);
    const tail = TranscriptResponse.parse((await get(t, '/api/agents/h1/transcript')).body);
    expect(tail.lastSeq).toBe(1);
    const live: number[] = [];
    const off = transcripts.subscribe('h1', page.lastSeq, (chunks) =>
      live.push(...chunks.map((c) => c.seq)),
    );
    transcripts.flush();
    off();
    expect(live).toEqual([2]); // the buffered reply, not missed
  });

  it('reads each page through the partial indexes: no sort, no scan of the chunks', async () => {
    const { log, message, output } = await historyApp();
    message('h1', 'hello');
    output('h1', 'text', 'Hi!');
    const history = new History(log.db);
    const first = history.conversation('h1', { limit: 1 });
    const [m, r] = [first.entries[0]!, history.conversation('h1', { limit: 2 }).entries[0]!];
    for (const cursor of [m.cursor, r.cursor, first.entries[0]!.cursor]) {
      history.conversation('h1', { before: cursor, limit: 5 });
      history.conversation('h1', { after: cursor, limit: 5 });
    }
    const sqls = [...(history as unknown as { stmts: Map<string, unknown> }).stmts.keys()];
    expect(sqls.length).toBeGreaterThanOrEqual(8); // newest page plus both cursor kinds × ways
    for (const sql of sqls) {
      const params = (sql.match(/\?/g) ?? []).map(() => 'x');
      const plan = (
        log.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]
      )
        .map((p) => p.detail)
        .join(' | ');
      // `SCAN CONSTANT ROW`: the high-water read's outer SELECT of two subqueries (P8-02).
      expect(plan, sql).not.toMatch(/TEMP B-TREE|SCAN (?!CONSTANT ROW)/);
      expect(plan, sql).toMatch(
        /USING INDEX (events_message_agent_at|transcript_text_at)|USING COVERING INDEX sqlite_autoindex_transcript_chunks/,
      );
    }
  });

  it('merges the messages to an agent and its replies by time, and pages both ways', async () => {
    const { t, message, output, clock: c } = await historyApp();
    message('h1', 'hello'); // 1
    output('h1', 'text', 'Hi! What can I do?'); // 2
    output('h1', 'thinking', 'hmm'); // not in the conversation
    output('h1', 'tool', 'tool result: x'); // not in the conversation
    message('w1', 'for the Waykeeper'); // another agent's
    message('h1', 'Waykeeper report: plan ready', { type: 'agent', id: 'w1' }); // 3
    c.hold(true); // the same instant: the message sorts before the reply
    message('h1', 'build me a parser'); // 4
    output('h1', 'text', 'Proposing a moon for it.'); // 5
    c.hold(false);
    output('h1', 'text', '   '); // blank: skipped
    output('h1', 'text', 'Card is up.'); // 6
    message('h1', 'thanks'); // 7

    const all: ConversationEntry[] = [];
    let page = ConversationResponse.parse(
      (await get(t, '/api/agents/h1/conversation?limit=3')).body,
    );
    expect(page.entries.map((e) => e.text)).toEqual([
      'Proposing a moon for it.',
      'Card is up.',
      'thanks',
    ]);
    expect(page.hasMore).toBe(true);
    all.unshift(...page.entries);
    while (page.hasMore) {
      const before = encodeURIComponent(all[0]!.cursor);
      page = ConversationResponse.parse(
        (await get(t, `/api/agents/h1/conversation?limit=3&before=${before}`)).body,
      );
      all.unshift(...page.entries);
    }
    expect(all.map((e) => [e.kind, e.text])).toEqual([
      ['message', 'hello'],
      ['reply', 'Hi! What can I do?'],
      ['message', 'Waykeeper report: plan ready'],
      ['message', 'build me a parser'],
      ['reply', 'Proposing a moon for it.'],
      ['reply', 'Card is up.'],
      ['message', 'thanks'],
    ]);
    expect(new Set(all.map((e) => e.id)).size).toBe(7);
    expect(all[2]!.sender).toEqual({ type: 'agent', id: 'w1' });
    expect(all[1]).toMatchObject({ sender: { type: 'agent', id: 'h1' }, chunkSeq: 1 });
    expect(all[0]).toMatchObject({ messageId: 'msg-1', sender: { type: 'user' } });

    // Forward from the third entry: the next two, then the rest.
    const after = encodeURIComponent(all[2]!.cursor);
    const fwd = ConversationResponse.parse(
      (await get(t, `/api/agents/h1/conversation?limit=2&after=${after}`)).body,
    );
    expect(fwd.entries.map((e) => e.text)).toEqual([
      'build me a parser',
      'Proposing a moon for it.',
    ]);
    expect(fwd.hasMore).toBe(true);
    const tail = ConversationResponse.parse(
      (
        await get(
          t,
          `/api/agents/h1/conversation?limit=10&after=${encodeURIComponent(fwd.entries[1]!.cursor)}`,
        )
      ).body,
    );
    expect(tail.entries.map((e) => e.text)).toEqual(['Card is up.', 'thanks']);
    expect(tail.hasMore).toBe(false);
  });

  it('refuses bad queries, unknown agents and a missing token', async () => {
    const { t } = await historyApp();
    expect((await get(t, '/api/agents/h1/conversation?before=nope')).status).toBe(400);
    expect((await get(t, '/api/agents/h1/conversation?limit=0')).status).toBe(400);
    expect((await get(t, '/api/agents/h1/conversation?before=a~m1&after=b~m2')).status).toBe(400);
    expect((await get(t, '/api/agents/nobody/conversation')).status).toBe(404);
    expect(
      (await get(t, '/api/agents/h1/conversation', { authorization: 'Bearer x' })).status,
    ).toBe(401);
    const empty = ConversationResponse.parse((await get(t, '/api/agents/w1/conversation')).body);
    expect(empty).toEqual({ entries: [], hasMore: false, lastSeq: 0 });
  });
});

describe('GET /api/agents/:id/transcript (P25-01)', () => {
  it('pages the persisted chunks by seq, newest page first, and filters kinds', async () => {
    const { t, output } = await historyApp();
    output('w1', 'text', 'one');
    output('w1', 'tool', 'two');
    output('w1', 'thinking', 'three');
    output('w1', 'text', 'four');
    output('w1', 'tool', 'five');

    const newest = TranscriptResponse.parse(
      (await get(t, '/api/agents/w1/transcript?limit=2')).body,
    );
    expect(newest.chunks.map((c) => c.seq)).toEqual([4, 5]);
    expect(newest).toMatchObject({ hasMore: true, lastSeq: 5 });
    const older = TranscriptResponse.parse(
      (await get(t, '/api/agents/w1/transcript?limit=2&before=4')).body,
    );
    expect(older.chunks.map((c) => c.text)).toEqual(['two', 'three']);
    const since = TranscriptResponse.parse(
      (await get(t, '/api/agents/w1/transcript?after=3')).body,
    );
    expect(since.chunks.map((c) => c.seq)).toEqual([4, 5]);
    expect(since.hasMore).toBe(false);
    const tools = TranscriptResponse.parse(
      (await get(t, '/api/agents/w1/transcript?kinds=tool')).body,
    );
    expect(tools.chunks.map((c) => c.text)).toEqual(['two', 'five']);
    expect((await get(t, '/api/agents/w1/transcript?kinds=secrets')).status).toBe(400);
    expect((await get(t, '/api/agents/nobody/transcript')).status).toBe(404);
  });
});

describe('GET /api/notifications (P25-01; SPEC §4.5)', () => {
  const question = (id: string, over: Partial<Question> = {}): Question => ({
    id,
    kind: 'clarification',
    originAgentId: 'h1',
    holder: { type: 'user' },
    status: 'open',
    context: { text: `question ${id}` },
    version: 0,
    createdAt: '2026-10-02T10:00:00.000Z',
    updatedAt: '2026-10-02T10:00:00.000Z',
    ...over,
  });

  it('lists what notifies, with stable ids, and resumes after a seq without repeats', async () => {
    const { t, log } = await historyApp();
    const emit = (event: Event) => log.runCommand((ctx) => ctx.emit(event));
    emit({ type: 'question.opened', question: question('q1') });
    emit({ type: 'question.opened', question: question('q2', { kind: 'permission' }) });
    emit({
      type: 'question.opened',
      question: question('q3', { holder: { type: 'agent', id: 'w1' } }),
    });
    emit({ type: 'task.state_changed', taskId: 't1', from: 'approved', to: 'in_progress' });
    emit({ type: 'task.state_changed', taskId: 't1', from: 'in_progress', to: 'completed' });

    const first = NotificationsResponse.parse((await get(t, '/api/notifications')).body);
    expect(first.notifications.map((n) => [n.kind, n.id])).toEqual([
      ['question', 'question:q1'],
      ['permission', 'question:q2'],
      ['task_completed', expect.stringMatching(/^task:t1:completed:\d+$/)],
    ]);
    expect(first.hasMore).toBe(false);

    emit({
      type: 'question.escalated',
      questionId: 'q3',
      from: { type: 'agent', id: 'w1' },
      to: { type: 'user' },
      version: 1,
    });
    emit({ type: 'agent.interrupted', agentId: 'w1', reason: 'server shutdown' });
    emit({ type: 'agent.interrupted', agentId: 'w1', reason: 'session reset' });
    emit({ type: 'recovery.needs_attention', agentId: 'w1', reason: 'resume failed: gone' });
    emit({
      type: 'proposal.parked',
      proposalId: 'p1',
      reason: 'no free planet',
      waitingFor: 'planet',
      occupied: [],
      offers: [],
    });
    emit({ type: 'proposal.parked', proposalId: 'p2', reason: 'the user parked it' });
    emit({ type: 'project.state_changed', projectId: 'pr1', from: 'in_progress', to: 'failed' });

    const page1 = NotificationsResponse.parse(
      (await get(t, `/api/notifications?after=${first.seq}&limit=2`)).body,
    );
    expect(page1.notifications.map((n) => n.kind)).toEqual(['question', 'interrupted']);
    expect(page1.notifications[0]!.id).toBe('question:q3');
    expect(page1.notifications[1]!.role).toBe('waykeeper');
    expect(page1.hasMore).toBe(true);
    const page2 = NotificationsResponse.parse(
      (await get(t, `/api/notifications?after=${page1.seq}&limit=2`)).body,
    );
    expect(page2.notifications.map((n) => n.kind)).toEqual(['no_space', 'project_failed']);
    expect(page2.hasMore).toBe(false);
    const none = NotificationsResponse.parse(
      (await get(t, `/api/notifications?after=${page2.seq}`)).body,
    );
    expect(none.notifications).toEqual([]);
    expect(none.seq).toBe(page2.seq);
    // A cursor beyond the head (a newer log, a stale tab) never moves back.
    const ahead = NotificationsResponse.parse(
      (await get(t, `/api/notifications?after=${page2.seq + 100}`)).body,
    );
    expect(ahead.seq).toBe(page2.seq + 100);
  });

  it('leaves out questions that are no longer open', async () => {
    const { t, log } = await historyApp();
    for (const [id, status] of [
      ['q-open', 'open'],
      ['q-answered', 'answered'],
      ['q-cancelled', 'cancelled'],
    ] as const) {
      log.runCommand((ctx) => {
        const q = question(id, { status });
        ctx.tables.questions.upsert(q);
        ctx.emit({ type: 'question.opened', question: { ...q, status: 'open' } });
      });
    }
    const feed = NotificationsResponse.parse((await get(t, '/api/notifications?after=0')).body);
    expect(feed.notifications.map((n) => n.id)).toEqual(['question:q-open']);
    const newest = NotificationsResponse.parse((await get(t, '/api/notifications')).body);
    expect(newest.notifications.map((n) => n.id)).toEqual(['question:q-open']);
  });
});

describe('settings (P25-01; SPEC §4.6)', () => {
  let composed: ComposedRuntime;

  async function settingsApp(over: Parameters<typeof testConfig>[0] = {}) {
    composed = composeRuntime(openDatabase(':memory:'), {
      adapters: [new FakeAdapter()],
      caps: { maxConcurrentAgents: 4 },
    });
    const config = testConfig(over);
    writeFileSync(
      config.configPath,
      JSON.stringify({ token: TEST_TOKEN, port: 4321, allowedHosts: ['mymac.ts.net'] }),
      { mode: 0o600 },
    );
    const settings = new SettingsService({
      config,
      caps: composed.runtime.caps,
      archival: composed.archival,
    });
    const t = await startTestApp({
      config,
      log: composed.log,
      runtime: composed.runtime,
      settings,
    });
    cleanups.push(
      () => t.stop(),
      () => composed.dispose(),
    );
    const file = () =>
      JSON.parse(readFileSync(config.configPath, 'utf8')) as Record<string, unknown>;
    return { t, config, file };
  }

  it('reads the effective settings', async () => {
    const { t } = await settingsApp();
    const res = SettingsResponse.parse((await get(t, '/api/settings')).body);
    expect(res.settings).toMatchObject({
      defaultPermissionPolicy: DEFAULT_PERMISSION_POLICY,
      retentionDays: 7,
      caps: {
        maxConcurrentAgents: 4,
        maxStewardsPerWaykeeper: 3,
        maxWallClockMs: 7_200_000,
        maxToolCalls: 500,
      },
      qualityTier: 'high',
      stewardsLoadUserSettings: true,
    });
    expect(res.envOverrides).toEqual([]);
    expect(res.restartRequired).toEqual([]);
  });

  it('refuses invalid settings with messages and writes nothing', async () => {
    const { t, file } = await settingsApp();
    const before = file();
    for (const body of [
      { retentionDays: 0 },
      { caps: { maxConcurrentAgents: -1 } },
      { caps: { maxWallClockMs: 10 } },
      { qualityTier: 'ultra' },
      { token: 'x'.repeat(20) },
      { defaultPermissionPolicy: { rules: { push: 'sure' } } },
    ]) {
      const res = await patch(t, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body['error']).toBe('invalid_body');
      expect(Array.isArray(res.body['issues'])).toBe(true);
    }
    const relative = await patch(t, { projectsRoot: 'relative/path' });
    expect(relative).toMatchObject({ status: 400, body: { error: 'invalid' } });
    expect(String(relative.body['message'])).toMatch(/absolute/);
    expect((await patch(t, { projectsRoot: '/' })).status).toBe(400);
    expect(file()).toEqual(before);
  });

  it('applies caps, retention and the tier live and keeps the rest of config.json', async () => {
    const { t, file, config } = await settingsApp();
    const res = await patch(t, {
      caps: { maxConcurrentAgents: 2, maxSpawnsPerHour: 7, maxToolCalls: 40 },
      retentionDays: 1.5,
      qualityTier: 'mobile',
    });
    expect(res.status).toBe(200);
    const body = SettingsResponse.parse(res.body);
    expect(body.settings.caps).toMatchObject({
      maxConcurrentAgents: 2,
      maxSpawnsPerHour: 7,
      maxStewardsPerWaykeeper: 3,
      maxToolCalls: 40,
    });
    expect(body.restartRequired).toEqual([]);
    expect(composed.runtime.caps.maxConcurrent).toBe(2);
    expect(composed.runtime.caps.spawnCaps.maxSpawnsPerHour).toBe(7);
    expect(composed.runtime.caps.defaults.maxToolCalls).toBe(40);
    expect(composed.archival.retentionMs).toBe(1.5 * 24 * 60 * 60 * 1000);
    const onDisk = file();
    expect(onDisk).toMatchObject({
      token: TEST_TOKEN,
      port: 4321,
      allowedHosts: ['mymac.ts.net'],
      retentionDays: 1.5,
      qualityTier: 'mobile',
      caps: { maxConcurrentAgents: 2, maxSpawnsPerHour: 7, maxToolCalls: 40 },
    });
    if (process.platform !== 'win32') {
      expect(statSync(config.configPath).mode & 0o777).toBe(0o600);
    }
    // A later read shows the saved values.
    expect(SettingsResponse.parse((await get(t, '/api/settings')).body).settings.qualityTier).toBe(
      'mobile',
    );
  });

  it('sets the global default table live; a remote client can only tighten it (decision 37)', async () => {
    const { t, file } = await settingsApp();
    const local = SettingsResponse.parse(
      (await patch(t, { defaultPermissionPolicy: { rules: { network: 'allow' } } })).body,
    );
    expect(local.floored).toBe(false);
    expect(local.settings.defaultPermissionPolicy.rules).toMatchObject({
      network: 'allow',
      push: 'ask',
      read_workspace: 'allow',
    });
    expect(globalDefaultPolicy().rules.network).toBe('allow');
    expect(resolvePolicy().rules.network).toBe('allow'); // a project without a table
    expect((file()['defaultPermissionPolicy'] as { rules: object }).rules).toMatchObject({
      network: 'allow',
    });

    const remote = { origin: 'https://mymac.tail1234.ts.net' };
    const loosen = SettingsResponse.parse(
      (
        await patch(
          t,
          { defaultPermissionPolicy: { rules: { push: 'allow', destructive: 'deny' } } },
          remote,
        )
      ).body,
    );
    expect(loosen.floored).toBe(true);
    expect(loosen.settings.defaultPermissionPolicy.rules).toMatchObject({
      push: 'ask', // floored at the current default
      destructive: 'deny', // tightening is fine
      network: 'ask', // left out: the SPEC table's value (a patch replaces the whole table)
    });
    // Back to the SPEC table: allowed locally, the key leaves the file.
    const reset = SettingsResponse.parse((await patch(t, { defaultPermissionPolicy: null })).body);
    expect(reset.settings.defaultPermissionPolicy).toEqual(DEFAULT_PERMISSION_POLICY);
    expect(globalDefaultPolicy()).toEqual(DEFAULT_PERMISSION_POLICY);
    expect(file()['defaultPermissionPolicy']).toBeUndefined();
  });

  it('refuses a remote client every setting but the tier and a tighter policy (decision 51)', async () => {
    const { t, file } = await settingsApp();
    const before = file();
    const remote = { origin: 'https://mymac.tail1234.ts.net' };
    for (const body of [
      { caps: { maxConcurrentAgents: 64, maxSpawnsPerHour: 10_000, maxToolCalls: 100_000 } },
      { retentionDays: 0.0001 },
      { stewardsLoadUserSettings: true },
      { projectsRoot: '/tmp/elsewhere' },
    ]) {
      const res = await patch(t, body, remote);
      expect(res, JSON.stringify(body)).toMatchObject({
        status: 403,
        body: { error: 'remote_settings' },
      });
      expect(String(res.body['message'])).toMatch(/only on this machine/);
    }
    expect(file()).toEqual(before);
    const tier = await patch(t, { qualityTier: 'balanced' }, remote);
    expect(tier.status).toBe(200);
  });

  it('saves restart-only settings and refuses env-decided ones', async () => {
    const { t, file } = await settingsApp({ envOverrides: ['retentionDays'] });
    const root = join(realpathSync(mkdtempSync(join(tmpdir(), 'galactic-root-'))), 'new-root');
    cleanups.push(() => rmSync(dirname(root), { recursive: true, force: true }));
    const res = SettingsResponse.parse(
      (await patch(t, { projectsRoot: root, stewardsLoadUserSettings: false })).body,
    );
    expect(res.restartRequired).toEqual(['projectsRoot', 'stewardsLoadUserSettings']);
    expect(res.envOverrides).toEqual(['retentionDays']);
    expect(file()).toMatchObject({ projectsRoot: root, stewardsLoadUserSettings: false });
    const locked = await patch(t, { retentionDays: 3 });
    expect(locked).toMatchObject({ status: 409, body: { error: 'env_override' } });
    expect(String(locked.body['message'])).toMatch(/retentionDays/);
  });

  it('stamps the first-run marker once, locally only (P25-08)', async () => {
    const { t, file, config } = await settingsApp();
    const before = SettingsResponse.parse((await get(t, '/api/settings')).body);
    expect(before.setupCompletedAt).toBeUndefined();

    const remote = { origin: 'https://mymac.tail1234.ts.net' };
    const refused = await patch(t, { setupCompleted: true }, remote);
    expect(refused).toMatchObject({ status: 403, body: { error: 'remote_settings' } });
    expect(file()['setupCompletedAt']).toBeUndefined();
    expect((await patch(t, { setupCompleted: false })).status).toBe(400);

    const done = SettingsResponse.parse((await patch(t, { setupCompleted: true })).body);
    expect(done.setupCompletedAt).toBeDefined();
    expect(file()).toMatchObject({ token: TEST_TOKEN, setupCompletedAt: done.setupCompletedAt });
    const again = SettingsResponse.parse((await patch(t, { setupCompleted: true })).body);
    expect(again.setupCompletedAt).toBe(done.setupCompletedAt);
    // The next start reads it back.
    const reloaded = loadConfig({ GALACTIC_HOME: config.dataDir, GALACTIC_TOKEN: TEST_TOKEN });
    expect(reloaded.config.setupCompletedAt).toBe(done.setupCompletedAt);
  });

  it('tells each client what it may change, as the patch decides it (P25-08, decision 51)', async () => {
    const remote = { origin: 'https://mymac.tail1234.ts.net' };
    const { t } = await settingsApp();
    const writable = async (headers: Record<string, string> = {}) =>
      SettingsResponse.parse((await get(t, '/api/settings', headers)).body).writable;
    expect(await writable()).toBe('all');
    expect(await writable(remote)).toBe('limited');
    // A patch reply says the same.
    const tier = SettingsResponse.parse((await patch(t, { qualityTier: 'balanced' }, remote)).body);
    expect(tier.writable).toBe('limited');
    const local = SettingsResponse.parse((await patch(t, { qualityTier: 'high' })).body);
    expect(local.writable).toBe('all');

    // With autoApproveRemote a remote client may write everything, the marker included.
    const open = await settingsApp({ autoApproveRemote: true });
    const remoteOpen = SettingsResponse.parse((await get(open.t, '/api/settings', remote)).body);
    expect(remoteOpen.writable).toBe('all');
    expect((await patch(open.t, { setupCompleted: true }, remote)).status).toBe(200);
  });
});

describe('GET /api/preflight (P25-01)', () => {
  it('reports every registered adapter, with fixable messages', async () => {
    const notLoggedIn: RuntimePreflight = {
      runtime: 'claude-sdk',
      ok: false,
      installed: true,
      version: '2.1.0',
      loggedIn: false,
      problems: [
        {
          code: 'not_logged_in',
          severity: 'error',
          message: 'Claude Code is installed but not logged in.',
          fix: 'run `claude`',
        },
      ],
    };
    let calls = 0;
    const claude = new ClaudeSdkAdapter({
      supervisor: new ProcessSupervisor({}),
      preflight: () => {
        calls++;
        return Promise.resolve(notLoggedIn);
      },
    });
    const composed = composeRuntime(openDatabase(':memory:'), {
      adapters: [new FakeAdapter(), claude],
    });
    const t = await startTestApp({ log: composed.log, runtime: composed.runtime });
    cleanups.push(
      () => t.stop(),
      () => composed.dispose(),
    );
    const res = PreflightResponse.parse((await get(t, '/api/preflight')).body);
    expect(res.ok).toBe(false);
    expect(res.runtimes.map((r) => [r.runtime, r.ok])).toEqual([
      ['claude-sdk', false],
      ['fake', true],
    ]);
    expect(res.runtimes[0]!.problems[0]!.fix).toBeTruthy();
    await get(t, '/api/preflight'); // cached
    expect(calls).toBe(1);
    await get(t, '/api/preflight?refresh=1'); // within 5 s of the last run: the cached result
    expect(calls).toBe(1);
    const realNow = Date.now.bind(Date);
    const later = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 6_000);
    try {
      await get(t, '/api/preflight?refresh=1');
      expect(calls).toBe(2);
      await get(t, '/api/preflight?refresh=1'); // rate-limited again
      expect(calls).toBe(2);
    } finally {
      later.mockRestore();
    }
    expect((await get(t, '/api/preflight', { authorization: 'Bearer nope' })).status).toBe(401);
  });
});

describe('GET /api/agents/:id/conversation leaves out turn prompts (P25-03)', () => {
  it('a brain turn prompt (`message.sent.turn`) is not a conversation line', async () => {
    const { t, log, message, output } = await historyApp();
    message('h1', 'build me a thing');
    log.runCommand((ctx) =>
      ctx.emit({
        type: 'message.sent',
        messageId: 'msg-turn',
        agentId: 'h1',
        sender: { type: 'system' },
        text: 'Since your last turn:\n1. the user said: "build me a thing"',
        interrupt: false,
        turn: true,
      }),
    );
    output('h1', 'text', 'On it.');
    message('h1', 'thanks');
    const page = ConversationResponse.parse((await get(t, '/api/agents/h1/conversation')).body);
    expect(page.entries.map((e) => e.text)).toEqual(['build me a thing', 'On it.', 'thanks']);
    const older = ConversationResponse.parse(
      (await get(t, `/api/agents/h1/conversation?limit=1&before=${page.entries[2]!.cursor}`)).body,
    );
    expect(older.entries.map((e) => e.text)).toEqual(['On it.']);
  });
});
