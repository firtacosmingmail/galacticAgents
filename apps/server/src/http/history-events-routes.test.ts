import { afterEach, describe, expect, it } from 'vitest';
import { HistoryEventsResponse, type Actor, type EventEnvelope } from '@galactic/protocol';
import { openDatabase } from '../db/database.js';
import { createAgent } from '../domain/agents.js';
import { Commands } from '../domain/commands.js';
import { EventLog } from '../domain/event-log.js';
import { HistoryEvents } from '../runtime/history-events.js';
import { startTestApp, TEST_TOKEN } from '../test/harness.js';

// P4-07 — `GET /api/history/events`: one project's events for the timeline scrubber.

const USER: Actor = { type: 'user' };
const CAPS = { maxWallClockMs: 60_000, maxToolCalls: 10 };

type TestApp = Awaited<ReturnType<typeof startTestApp>>;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const get = async (t: TestApp, path: string, auth = true) => {
  const res = await fetch(`${t.baseUrl}${path}`, {
    headers: auth ? { authorization: `Bearer ${TEST_TOKEN}` } : {},
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

/**
 * Two projects with agents on both; a standalone task that joins the first project (its asteroid
 * keeps the "moved to …" marker); a question asked and answered; a task completed; chat and panel
 * actions that the replay leaves out.
 */
async function scenario() {
  let clock = Date.parse('2026-10-04T09:00:00.000Z');
  const db = openDatabase(':memory:');
  const log = new EventLog(db, { now: () => new Date((clock += 1000)).toISOString() });
  const commands = new Commands({ log });
  const alpha = (
    await commands.createProject({ name: 'Alpha', workspace: '/w/a', bodyId: 'b-mars' })
  ).value;
  const beta = (
    await commands.createProject({ name: 'Beta', workspace: '/w/b', bodyId: 'b-venus' })
  ).value;
  const parse = (await commands.createTask({ description: 'Parse', projectId: alpha.id })).value;
  const other = (await commands.createTask({ description: 'Other', projectId: beta.id })).value;
  const loose = (await commands.createTask({ description: 'Loose end' })).value;
  const agent = (id: string, role: 'waykeeper' | 'steward', extra: object) =>
    log.runCommand((ctx) =>
      createAgent(ctx, { agentId: id, role, runtime: 'fake', caps: CAPS, ...extra }),
    );
  agent('w-alpha', 'waykeeper', { projectId: alpha.id, bodyId: alpha.bodyId });
  agent('s-parse', 'steward', { taskId: parse.id, supervisorId: 'w-alpha', bodyId: alpha.bodyId });
  agent('s-other', 'steward', { taskId: other.id, bodyId: beta.bodyId });
  for (const id of ['s-parse', 's-other']) {
    await commands.recordAgentEvent({
      type: 'agent.spawned',
      agentId: id,
      role: 'steward',
      runtime: 'fake',
      bodyId: id === 's-parse' ? alpha.bodyId : beta.bodyId,
    });
    await commands.recordAgentEvent({
      type: 'agent.tool_call',
      agentId: id,
      toolName: 'Bash',
      // Redacted when it was logged: the route returns it exactly as the stream did.
      input: { command: 'curl -H "token [redacted:github-token]"' },
    });
  }
  log.runCommand((ctx) =>
    ctx.emit({
      type: 'message.sent',
      messageId: 'm1',
      agentId: 's-parse',
      sender: USER,
      text: 'hi',
      interrupt: false,
    }),
  );
  const asked = (
    await commands.openQuestion({
      kind: 'clarification',
      originAgentId: 's-parse',
      context: { text: 'CSV dialect?' },
    })
  ).value;
  await commands.answerQuestion({
    questionId: asked.id,
    answer: 'RFC 4180',
    by: USER,
    version: asked.version,
  });
  await commands.moveTask(loose.id, alpha.id, USER);
  await commands.closeTask(parse.id, USER);
  await commands.closeTask(other.id, USER);
  const t = await startTestApp({ log });
  cleanups.push(() => t.stop());
  return { t, log, alpha, beta, parse, other, loose, asked, now: () => clock };
}

const readAll = async (t: TestApp, projectId: string, limit: number, extra = '') => {
  const events: EventEnvelope[] = [];
  let after: number | undefined;
  for (let i = 0; i < 100; i++) {
    const q = `projectId=${projectId}&limit=${limit}${after !== undefined ? `&after=${after}` : ''}${extra}`;
    const { status, body } = await get(t, `/api/history/events?${q}`);
    expect(status).toBe(200);
    const page = HistoryEventsResponse.parse(body);
    expect(page.events.length).toBeLessThanOrEqual(limit);
    events.push(...page.events);
    after = page.seq;
    if (!page.hasMore) return events;
  }
  throw new Error('never ended');
};

describe('GET /api/history/events (P4-07)', () => {
  it('is bearer-guarded and validates its query', async () => {
    const { t, alpha } = await scenario();
    expect((await get(t, `/api/history/events?projectId=${alpha.id}`, false)).status).toBe(401);
    expect((await get(t, '/api/history/events')).body).toMatchObject({ error: 'invalid_query' });
    expect((await get(t, `/api/history/events?projectId=${alpha.id}&limit=0`)).status).toBe(400);
    expect((await get(t, `/api/history/events?projectId=${alpha.id}&after=-1`)).status).toBe(400);
    expect((await get(t, `/api/history/events?projectId=${alpha.id}&to=yesterday`)).status).toBe(
      400,
    );
    expect(await get(t, '/api/history/events?projectId=p-nope')).toEqual({
      status: 404,
      body: { error: 'not_found' },
    });
  });

  it("returns the project's events — its tasks, bodies, agents and questions — and nothing else", async () => {
    const { t, log, alpha, beta, parse, other, loose, asked } = await scenario();
    const events = await readAll(t, alpha.id, 2_000);
    const types = events.map((e) => e.event.type);
    for (const type of [
      'project.created',
      'task.created',
      'body.assigned',
      'body.moved',
      'agent.created',
      'agent.spawned',
      'agent.tool_call',
      'question.opened',
      'question.answered',
      'task.state_changed',
    ]) {
      expect(types, type).toContain(type);
    }
    // Chat and panel actions are left out; so is everything about the other project.
    expect(types).not.toContain('message.sent');
    expect(types.some((t) => t.startsWith('control.'))).toBe(false);
    const text = JSON.stringify(events);
    for (const id of [beta.id, other.id, 's-other']) expect(text).not.toContain(id);
    // The standalone task's life before it joined: created on its own asteroid.
    expect(events).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          type: 'task.created',
          task: expect.objectContaining({ id: loose.id }),
        }),
      }),
    );
    expect(events.find((e) => e.event.type === 'body.moved')?.event).toMatchObject({
      host: { kind: 'task', id: loose.id },
      intoProjectId: alpha.id,
    });
    expect(
      events.some((e) => e.event.type === 'question.answered' && e.event.questionId === asked.id),
    ).toBe(true);
    expect(
      events.some(
        (e) =>
          e.event.type === 'task.state_changed' &&
          e.event.taskId === parse.id &&
          e.event.to === 'completed',
      ),
    ).toBe(true);
    // Oldest first, in `seq` order.
    expect(events.map((e) => e.seq)).toEqual([...events.map((e) => e.seq)].sort((a, b) => a - b));
    // Redaction parity: each envelope is exactly what the stream carried for that seq.
    const stream = new Map(log.eventsSince(0, 10_000).map((e) => [e.seq, e]));
    for (const e of events) expect(e).toEqual(stream.get(e.seq));
    expect(text).toContain('[redacted:github-token]');
  });

  it('pages forward by seq: small pages and small scan windows read the same events', async () => {
    const { t, log, alpha } = await scenario();
    const whole = await readAll(t, alpha.id, 2_000);
    expect(await readAll(t, alpha.id, 3)).toEqual(whole);
    // A scan window smaller than the log: pages may come back empty but `seq` always advances.
    const narrow = new HistoryEvents(log.db, 4);
    const paged: EventEnvelope[] = [];
    let after = 0;
    let reads = 0;
    for (;;) {
      const page = narrow.read({ projectId: alpha.id, after, limit: 2 });
      reads++;
      expect(page.seq).toBeGreaterThan(after);
      paged.push(...page.events);
      after = page.seq;
      if (!page.hasMore) break;
    }
    expect(paged).toEqual(whole);
    expect(after).toBe(log.currentSeq());
    expect(reads).toBeGreaterThan(log.currentSeq() / 4 - 1);
    // Past the end: nothing, no more.
    expect(narrow.read({ projectId: alpha.id, after, limit: 2 })).toEqual({
      projectId: alpha.id,
      events: [],
      seq: after,
      hasMore: false,
      membership: expect.any(String),
    });
  });

  it('keeps one read’s members across its pages (the membership token)', async () => {
    const { log, alpha, beta } = await scenario();
    const view = new HistoryEvents(log.db);
    const first = view.read({ projectId: alpha.id, limit: 2 });
    expect(first.hasMore).toBe(true);
    const token = first.membership!;
    // Work joins the project while the read goes on.
    const commands = new Commands({ log });
    const late = (await commands.createTask({ description: 'Late', projectId: alpha.id })).value;
    const rest = (membership?: string) => {
      const events: EventEnvelope[] = [];
      let after = first.seq;
      for (let more = true; more;) {
        const page = view.read({
          projectId: alpha.id,
          after,
          limit: 2,
          ...(membership ? { membership } : {}),
        });
        if (membership) expect(page.membership).toBe(membership);
        events.push(...page.events);
        after = page.seq;
        more = page.hasMore;
      }
      return events;
    };
    const isLate = (e: EventEnvelope) =>
      e.event.type === 'task.created' && e.event.task.id === late.id;
    // With the first page's token: the members it started with (the late task is not one).
    expect(rest(token).some(isLate)).toBe(false);
    // Without it (a fresh read): members as they are now.
    expect(rest().some(isLate)).toBe(true);
    // A token is only reused for its project; an unknown one gets fresh members and a new token.
    const other = view.read({ projectId: beta.id, limit: 2, membership: token });
    expect(other.membership).not.toBe(token);
    const unknown = view.read({ projectId: alpha.id, limit: 2, membership: 'nope' });
    expect(unknown.membership).not.toBe('nope');
  });

  it('narrows to a time range by the events’ time', async () => {
    const { t, alpha } = await scenario();
    const whole = await readAll(t, alpha.id, 2_000);
    const from = whole[2]!.at;
    const to = whole.at(-3)!.at;
    const range = await readAll(t, alpha.id, 2_000, `&from=${from}&to=${to}`);
    expect(range).toEqual(whole.filter((e) => e.at >= from && e.at <= to));
    expect(range.length).toBeGreaterThan(0);
    expect(range.length).toBeLessThan(whole.length);
  });

  it('reads the log by rowid range: no sort, no scan past the window', async () => {
    const { log } = await scenario();
    const view = new HistoryEvents(log.db);
    view.read({ projectId: 'p-x', limit: 1 });
    const scans = [...(view as unknown as { stmts: Map<string, unknown> }).stmts.keys()].filter(
      (sql) => sql.includes('FROM events WHERE id >'),
    );
    expect(scans).toHaveLength(1);
    const plan = (
      log.db.prepare(`EXPLAIN QUERY PLAN ${scans[0]}`).all(0, 10, 10) as { detail: string }[]
    )
      .map((p) => p.detail)
      .join(' | ');
    expect(plan).toMatch(/SEARCH events USING INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)/);
    expect(plan).not.toMatch(/TEMP B-TREE/);
    // The placements lookup reads the type index, not the whole log.
    const placements = [...(view as unknown as { stmts: Map<string, unknown> }).stmts.keys()].find(
      (sql) => sql.includes("type IN ('body.assigned', 'body.moved')"),
    )!;
    const placementPlan = (
      log.db.prepare(`EXPLAIN QUERY PLAN ${placements}`).all() as {
        detail: string;
      }[]
    )
      .map((p) => p.detail)
      .join(' | ');
    expect(placementPlan).toMatch(/USING INDEX events_type/);
  });
});
