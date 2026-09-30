import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentEvent as AgentEventSchema,
  DEFAULT_PERMISSION_POLICY,
  type AgentEvent,
  type SpawnOptions,
} from '@galactic/protocol';
import { collect } from '../../runtime/event-queue.js';
import { FakeAdapter } from './fake-adapter.js';
import { SCENARIOS, scenarioFromPrompt, type FakeScenario } from './scenario.js';

const spawnOpts = (prompt: string, agentId = 'a-1'): SpawnOptions => ({
  agentId,
  role: 'steward',
  cwd: '/tmp',
  prompt,
  permissionPolicy: DEFAULT_PERMISSION_POLICY,
  caps: { maxWallClockMs: 60_000, maxToolCalls: 100 },
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const types = (events: AgentEvent[]) => events.map((e) => e.type);
const has = (type: AgentEvent['type']) => (events: AgentEvent[]) =>
  events.some((e) => e.type === type);

const adapters: FakeAdapter[] = [];
function makeAdapter(opts: ConstructorParameters<typeof FakeAdapter>[0] = {}) {
  const adapter = new FakeAdapter({ speed: 0, ...opts });
  adapters.push(adapter);
  return { adapter, events: collect<AgentEvent>(adapter.events) };
}
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.dispose();
});

describe('FakeAdapter — scenarios and turns', () => {
  it('runs the happy scenario to a finish with cost, every event valid', async () => {
    const { adapter, events } = makeAdapter();
    const handle = await adapter.spawn(spawnOpts('scenario:happy'));
    expect(handle.sessionRef).toBe(`fake:happy:${handle.sessionId}:0`);
    await events.waitFor(has('agent.finished'));
    await sleep(5);
    expect(types(events.items)).toEqual([
      'agent.output',
      'agent.tool_call',
      'agent.output',
      'agent.progress',
      'agent.tool_call',
      'agent.progress',
      'agent.tool_call',
      'agent.output',
      'agent.finished',
    ]);
    for (const e of events.items) expect(AgentEventSchema.parse(e)).toEqual(e);
    expect(events.items.at(-1)).toMatchObject({
      type: 'agent.finished',
      agentId: 'a-1',
      result: 'Done: fixed the flaky date test.',
      cost: { usd: 0.0042 },
    });
    await expect(adapter.send(handle.sessionId, 'more')).rejects.toThrow(/has finished/);
  });

  it('falls back to the echo scenario for any other prompt and echoes messages', async () => {
    const { adapter, events } = makeAdapter();
    const { sessionId } = await adapter.spawn(spawnOpts('please fix the tests'));
    await events.waitFor(has('agent.idle'));
    expect(events.items).toEqual([
      { type: 'agent.output', agentId: 'a-1', kind: 'text', text: 'hello from the fake agent' },
      { type: 'agent.idle', agentId: 'a-1' },
    ]);
    await adapter.send(sessionId, 'hi there');
    await events.waitFor((e) => e.filter((x) => x.type === 'agent.idle').length === 2);
    expect(events.items.slice(2)).toEqual([
      { type: 'agent.output', agentId: 'a-1', kind: 'text', text: 'received: hi there' },
      { type: 'agent.idle', agentId: 'a-1' },
    ]);
    expect(scenarioFromPrompt('scenario:nope').name).toBe('echo');
    expect(scenarioFromPrompt('  scenario:Happy rest').name).toBe('happy');
  });

  it('queues messages sent while working and delivers them in order after idle', async () => {
    const slow: FakeScenario = { steps: [{ kind: 'output', text: 'working', delayMs: 80 }] };
    const { adapter, events } = makeAdapter({ speed: 1, scenarios: { slow } });
    const { sessionId } = await adapter.spawn(spawnOpts('scenario:slow'));
    await adapter.send(sessionId, 'first');
    await adapter.send(sessionId, 'second');
    await events.waitFor((e) => e.filter((x) => x.type === 'agent.idle').length === 3);
    expect(events.items.map((e) => (e.type === 'agent.output' ? e.text : e.type))).toEqual([
      'working',
      'agent.idle',
      'received: first',
      'agent.idle',
      'received: second',
      'agent.idle',
    ]);
  });

  it('an interrupting message cancels the turn and arrives first', async () => {
    const { adapter, events } = makeAdapter({ speed: 1 });
    const { sessionId } = await adapter.spawn(spawnOpts('scenario:long'));
    await events.waitFor(has('agent.progress'));
    await adapter.send(sessionId, 'later');
    await adapter.send(sessionId, 'urgent', { interrupt: true });
    await events.waitFor((e) => e.filter((x) => x.type === 'agent.idle').length === 3);
    const afterInterrupt = events.items.slice(
      events.items.findIndex((e) => e.type === 'agent.idle'),
    );
    expect(afterInterrupt.map((e) => (e.type === 'agent.output' ? e.text : e.type))).toEqual([
      'agent.idle',
      'received: urgent',
      'agent.idle',
      'received: later',
      'agent.idle',
    ]);
    expect(events.items.some((e) => e.type === 'agent.finished')).toBe(false);
  });

  it('interrupt() alone ends the turn with idle and drops the remaining steps', async () => {
    const { adapter, events } = makeAdapter({ speed: 1 });
    const { sessionId } = await adapter.spawn(spawnOpts('scenario:long'));
    await events.waitFor(has('agent.progress'));
    await adapter.interrupt(sessionId);
    await events.waitFor(has('agent.idle'));
    const count = events.items.length;
    await sleep(150);
    expect(events.items.length).toBe(count);
    expect(events.items.at(-1)?.type).toBe('agent.idle');
  });
});

describe('FakeAdapter — questions', () => {
  it('blocks on a clarification question until answered', async () => {
    const { adapter, events } = makeAdapter();
    await adapter.spawn(spawnOpts('scenario:asks'));
    await events.waitFor(has('agent.needs_input'));
    await sleep(5);
    const q = events.items.at(-1)!;
    expect(q).toMatchObject({
      type: 'agent.needs_input',
      kind: 'clarification',
      question: {
        text: 'Which date format should the export use?',
        options: ['ISO 8601', 'US', 'EU'],
      },
    });
    expect(q.type === 'agent.needs_input' && q.questionId.startsWith('q-')).toBe(true);
    expect(events.items.length).toBe(2); // nothing after the question
    await adapter.answer((q as { questionId: string }).questionId, 'ISO 8601');
    await events.waitFor(has('agent.finished'));
    expect(events.items.slice(2).map((e) => (e.type === 'agent.output' ? e.text : e.type))).toEqual(
      ['answer: ISO 8601', 'Thanks, going with that.', 'agent.finished'],
    );
    await expect(adapter.answer('q-nope', 'x')).rejects.toThrow(/no pending question/);
  });

  it('a permission request carries the tool call and runs it when allowed', async () => {
    const { adapter, events } = makeAdapter();
    await adapter.spawn(spawnOpts('scenario:permission'));
    await events.waitFor(has('agent.needs_input'));
    const q = events.items.at(-1) as Extract<AgentEvent, { type: 'agent.needs_input' }>;
    expect(q).toMatchObject({
      kind: 'permission',
      question: {
        text: 'May I run Bash?',
        toolCall: { toolName: 'Bash', input: { command: 'rm -rf dist' } },
        permissionAction: 'destructive',
      },
    });
    await adapter.answer(q.questionId, 'allow');
    await events.waitFor(has('agent.finished'));
    expect(events.items[2]).toEqual({
      type: 'agent.tool_call',
      agentId: 'a-1',
      toolName: 'Bash',
      input: { command: 'rm -rf dist' },
    });
  });

  it('a denied permission skips the tool call', async () => {
    const { adapter, events } = makeAdapter();
    await adapter.spawn(spawnOpts('scenario:permission'));
    await events.waitFor(has('agent.needs_input'));
    const q = events.items.at(-1) as Extract<AgentEvent, { type: 'agent.needs_input' }>;
    await adapter.answer(q.questionId, 'deny');
    await events.waitFor(has('agent.finished'));
    expect(events.items[2]).toMatchObject({
      type: 'agent.output',
      text: 'permission denied for Bash, skipping',
    });
    expect(events.items.filter((e) => e.type === 'agent.tool_call')).toHaveLength(1);
  });
});

describe('FakeAdapter — pause, resume, stall, fail', () => {
  it('pause holds the turn and resume continues it', async () => {
    const { adapter, events } = makeAdapter({ speed: 1 });
    const { sessionId } = await adapter.spawn(spawnOpts('scenario:long'));
    await events.waitFor(has('agent.progress'));
    await adapter.pause(sessionId);
    await adapter.pause(sessionId); // idempotent
    await sleep(20);
    const paused = events.items.length;
    expect(events.items.at(-1)).toEqual({
      type: 'agent.paused',
      agentId: 'a-1',
      by: { type: 'system' },
    });
    await sleep(200);
    expect(events.items.length).toBe(paused);
    await adapter.resume(sessionId);
    expect(events.items.at(-1)).toEqual({
      type: 'agent.resumed',
      agentId: 'a-1',
      by: { type: 'system' },
    });
    await events.waitFor(has('agent.finished'));
    expect(events.items.filter((e) => e.type === 'agent.progress')).toHaveLength(20);
  });

  it('pause while a question is pending holds the answer until resume', async () => {
    const { adapter, events } = makeAdapter();
    const { sessionId } = await adapter.spawn(spawnOpts('scenario:asks'));
    await events.waitFor(has('agent.needs_input'));
    const q = events.items.at(-1) as Extract<AgentEvent, { type: 'agent.needs_input' }>;
    await adapter.pause(sessionId);
    await adapter.answer(q.questionId, 'EU');
    await sleep(20);
    expect(events.items.some((e) => e.type === 'agent.finished')).toBe(false);
    await adapter.resume(sessionId);
    await events.waitFor(has('agent.finished'));
  });

  it('produces silence, a stall report, then carries on', async () => {
    const { adapter, events } = makeAdapter({ speed: 0.1 });
    const started = Date.now();
    await adapter.spawn(spawnOpts('scenario:stalls'));
    await events.waitFor(has('agent.idle'));
    expect(types(events.items)).toEqual([
      'agent.output',
      'agent.stalled',
      'agent.output',
      'agent.idle',
    ]);
    expect(events.items[1]).toMatchObject({ silentForMs: 400 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
  });

  it('fails with the scripted reason and cost', async () => {
    const { adapter, events } = makeAdapter();
    const { sessionId } = await adapter.spawn(spawnOpts('scenario:fails'));
    await events.waitFor(has('agent.failed'));
    expect(events.items.at(-1)).toMatchObject({
      type: 'agent.failed',
      error: 'runtime exploded',
      reason: 'runtime',
    });
    await sleep(5);
    expect(types(events.items)).toEqual(['agent.output', 'agent.failed']);
    await expect(adapter.send(sessionId, 'x')).rejects.toThrow(/has failed/);
  });
});

describe('FakeAdapter — stop from every state', () => {
  async function expectStopped(
    adapter: FakeAdapter,
    events: ReturnType<typeof collect<AgentEvent>>,
    sessionId: string,
  ) {
    const before = events.items.length;
    await adapter.stop(sessionId);
    await sleep(30);
    const after = events.items.slice(before);
    expect(after).toEqual([{ type: 'agent.stopped', agentId: 'a-1', by: { type: 'system' } }]);
    await sleep(100);
    expect(events.items.length).toBe(before + 1);
    await expect(adapter.send(sessionId, 'x')).rejects.toThrow(/has stopped/);
  }

  it('while working', async () => {
    const { adapter, events } = makeAdapter({ speed: 1 });
    const { sessionId } = await adapter.spawn(spawnOpts('scenario:long'));
    await events.waitFor(has('agent.progress'));
    await expectStopped(adapter, events, sessionId);
  });

  it('while waiting for an answer', async () => {
    const { adapter, events } = makeAdapter();
    const { sessionId } = await adapter.spawn(spawnOpts('scenario:asks'));
    await events.waitFor(has('agent.needs_input'));
    await expectStopped(adapter, events, sessionId);
  });

  it('while paused', async () => {
    const { adapter, events } = makeAdapter({ speed: 1 });
    const { sessionId } = await adapter.spawn(spawnOpts('scenario:long'));
    await events.waitFor(has('agent.progress'));
    await adapter.pause(sessionId);
    await sleep(10);
    await expectStopped(adapter, events, sessionId);
  });

  it('while idle', async () => {
    const { adapter, events } = makeAdapter();
    const { sessionId } = await adapter.spawn(spawnOpts('anything'));
    await events.waitFor(has('agent.idle'));
    await expectStopped(adapter, events, sessionId);
  });

  it('after it finished, or for an unknown session, is a no-op', async () => {
    const { adapter, events } = makeAdapter();
    const { sessionId } = await adapter.spawn(spawnOpts('scenario:happy'));
    await events.waitFor(has('agent.finished'));
    const n = events.items.length;
    await adapter.stop(sessionId);
    await adapter.stop('nope');
    await sleep(10);
    expect(events.items.length).toBe(n);
  });
});

describe('FakeAdapter — resumeSession', () => {
  it('continues from the step after the last completed one, across adapter instances', async () => {
    const sessionStore = new Map<string, number>();
    const first = makeAdapter({ sessionStore });
    const handle = await first.adapter.spawn(spawnOpts('scenario:full'));
    await first.events.waitFor(has('agent.needs_input'));
    expect(handle.sessionRef).toBe(`fake:full:${handle.sessionId}:0`);
    expect(sessionStore.get(handle.sessionRef!)).toBe(3);
    await first.adapter.dispose(); // the "server" goes away mid-question

    const second = makeAdapter({ sessionStore });
    const resumed = await second.adapter.resumeSession(
      handle.sessionRef!,
      spawnOpts('scenario:full'),
    );
    expect(resumed.sessionRef).toBe(`fake:full:${resumed.sessionId}:3`);
    await second.events.waitFor(has('agent.needs_input'));
    await sleep(5);
    expect(types(second.events.items)).toEqual(['agent.needs_input']);
    const q = second.events.items[0] as Extract<AgentEvent, { type: 'agent.needs_input' }>;
    expect(q.kind).toBe('clarification');
    await second.adapter.answer(q.questionId, 'yes');
    await second.events.waitFor(
      (e) => e.filter((x) => x.type === 'agent.needs_input').length === 2,
    );
    const p = second.events.items.at(-1) as Extract<AgentEvent, { type: 'agent.needs_input' }>;
    expect(p.kind).toBe('permission');
    await second.adapter.answer(p.questionId, 'no');
    await second.events.waitFor(has('agent.idle'));
    // The follow-up message finishes the run (scenario `full`).
    await second.adapter.send(resumed.sessionId, 'thanks');
    await second.events.waitFor(has('agent.finished'));
    expect(second.events.items.at(-1)).toMatchObject({ result: 'finished after the follow-up' });
  });

  it('starts from the ref’s own step with a fresh store, and rejects foreign refs', async () => {
    const { adapter, events } = makeAdapter();
    await adapter.resumeSession('fake:happy:0000-01d-5e55:8', spawnOpts('x'));
    await events.waitFor(has('agent.finished'));
    await sleep(5);
    expect(types(events.items)).toEqual(['agent.finished']);
    await expect(adapter.resumeSession('claude:abc', spawnOpts('x'))).rejects.toThrow(
      /not a fake session ref/,
    );
    await expect(adapter.resumeSession('fake:zzz:abc:0', spawnOpts('x'))).rejects.toThrow(
      /unknown fake scenario/,
    );
  });
});

describe('FakeAdapter — session refs are per session', () => {
  it('two agents on the same scenario do not share progress', async () => {
    const sessionStore = new Map<string, number>();
    const { adapter, events } = makeAdapter({ sessionStore });
    const a = await adapter.spawn(spawnOpts('scenario:asks', 'a-1'));
    const b = await adapter.spawn(spawnOpts('scenario:asks', 'a-2'));
    await events.waitFor((e) => e.filter((x) => x.type === 'agent.needs_input').length === 2);
    const qa = events.items.find(
      (e) => e.type === 'agent.needs_input' && e.agentId === 'a-1',
    ) as Extract<AgentEvent, { type: 'agent.needs_input' }>;
    await adapter.answer(qa.questionId, 'US');
    await events.waitFor((e) => e.some((x) => x.type === 'agent.finished' && x.agentId === 'a-1'));
    expect(a.sessionRef).not.toBe(b.sessionRef);
    expect(sessionStore.get(a.sessionRef!)).toBe(4);
    expect(sessionStore.get(b.sessionRef!)).toBe(1);
  });
});

describe('FakeAdapter — coverage of the event vocabulary', () => {
  it('can produce every agent.* event of TECHNOLOGY §3.4 except agent.spawned', async () => {
    const seen = new Set<AgentEvent['type']>();
    const { adapter, events } = makeAdapter({ speed: 0.05 });
    const a = await adapter.spawn(spawnOpts('scenario:full', 'a-1'));
    await events.waitFor(has('agent.needs_input'));
    const q1 = events.items.at(-1) as Extract<AgentEvent, { type: 'agent.needs_input' }>;
    await adapter.pause(a.sessionId);
    await adapter.resume(a.sessionId);
    await adapter.answer(q1.questionId, 'yes');
    await events.waitFor((e) => e.filter((x) => x.type === 'agent.needs_input').length === 2);
    const q2 = events.items.at(-1) as Extract<AgentEvent, { type: 'agent.needs_input' }>;
    await adapter.answer(q2.questionId, 'allow');
    await events.waitFor(has('agent.idle'));
    await adapter.stop(a.sessionId);
    await adapter.spawn(spawnOpts('scenario:stalls', 'a-2'));
    await adapter.spawn(spawnOpts('scenario:fails', 'a-3'));
    await adapter.spawn(spawnOpts('scenario:happy', 'a-4'));
    await events.waitFor(
      (e) => e.some((x) => x.type === 'agent.finished') && e.some((x) => x.type === 'agent.failed'),
    );
    await events.waitFor((e) => e.filter((x) => x.type === 'agent.idle').length >= 2);
    for (const e of events.items) seen.add(e.type);
    const expected = AgentEventSchema.options
      .map((o) => o.shape.type.value)
      .filter((t) => t !== 'agent.spawned');
    expect([...seen].sort()).toEqual([...expected].sort());
    expect(adapter.scenarioNames()).toEqual(Object.keys(SCENARIOS));
  });

  it('dispose stops every session and ends the stream', async () => {
    const { adapter, events } = makeAdapter({ speed: 1 });
    await adapter.spawn(spawnOpts('scenario:long', 'a-1'));
    await adapter.spawn(spawnOpts('scenario:asks', 'a-2'));
    await events.waitFor(
      (e) =>
        e.some((x) => x.type === 'agent.needs_input') && e.some((x) => x.type === 'agent.progress'),
    );
    await adapter.dispose();
    const stopped = events.items
      .filter((e) => e.type === 'agent.stopped')
      .map((e) => e.agentId)
      .sort();
    expect(stopped).toEqual(['a-1', 'a-2']);
    await expect(adapter.spawn(spawnOpts('x', 'a-3'))).rejects.toThrow(/disposed/);
  });
});
