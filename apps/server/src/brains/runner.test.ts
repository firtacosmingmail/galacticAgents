import { afterEach, describe, expect, it } from 'vitest';
import type { Actor, Id } from '@galactic/protocol';
import type { BrainTool } from './definition.js';
import type { SessionResetPolicy } from './runner.js';
import {
  brainDefinition,
  brainHarness,
  firstTurn,
  latch,
  tool,
  type BrainHarness,
  type BrainScript,
  type HarnessBrain,
} from './testing/index.js';

/**
 * The brain runner (P2-06) over the real runtime, the fake adapter and the scripted-brain harness
 * (P2-07): one turn at a time, simultaneous events coalesced into one turn, the brain's own side
 * effects never waking it, turn-ending tools, DB seeding and session reset. The Waykeeper under
 * test sits under a Harmonizer, as every Waykeeper does.
 */

const USER: Actor = { type: 'user' };
const lives: BrainHarness[] = [];
afterEach(async () => {
  for (const h of lives.splice(0)) await h.dispose().catch(() => {});
});

interface Rig {
  h: BrainHarness;
  brain: HarnessBrain;
  projectId: Id;
  taskIds: Id[];
}

interface World {
  projectId: Id;
  taskIds: Id[];
}

async function boot(
  fill: (script: BrainScript, world: World) => void = () => {},
  tools: BrainTool[] = [],
  opts: { coalesceMs?: number; reset?: SessionResetPolicy; strict?: boolean } = {},
): Promise<Rig> {
  const h = brainHarness();
  lives.push(h);
  const hq = await h.startHarmonizer();
  // The body catalogue is seeded by migration 0005.
  const project = (await h.commands.createProject({ name: 'CSV', workspace: '/w/csv' })).value;
  const taskIds: Id[] = [];
  for (const description of ['parse the file', 'write the export']) {
    taskIds.push((await h.commands.createTask({ description, projectId: project.id })).value.id);
  }
  const world = { projectId: project.id, taskIds };
  const brain = await h.startBrain(
    brainDefinition('waykeeper', tools, {
      systemPrompt: 'You are the Waykeeper of a test project.',
    }),
    { runtime: 'fake', projectId: project.id, supervisorId: hq.agentId },
    {
      ...(opts.coalesceMs !== undefined ? { coalesceMs: opts.coalesceMs } : {}),
      ...(opts.reset ? { reset: opts.reset } : {}),
      ...(opts.strict !== undefined ? { scriptOptions: { strict: opts.strict } } : {}),
      script: (s) => fill(s, world),
    },
  );
  await brain.settled();
  return { h, brain, ...world };
}

/** Messages the runner sent to the brain: one per turn after the first. */
const turnMessages = (rig: Rig) =>
  rig.h.log
    .eventsSince(0, Number.MAX_SAFE_INTEGER)
    .map((e) => e.event)
    .filter((e) => e.type === 'message.sent' && e.agentId === rig.brain.agentId)
    .filter((e) => e.type === 'message.sent' && e.sender.type === 'system');

/** The brain's runtime transcript (what the panel shows), flushed. */
const transcriptText = (rig: Rig) => {
  rig.h.composed.transcripts.flush();
  return rig.h.composed.transcripts
    .read(rig.brain.agentId)
    .map((c) => c.text)
    .join('\n');
};

describe('BrainRunner', () => {
  it('spawns the brain through the runtime with its tools, system prompt and a seeded first prompt', async () => {
    const rig = await boot((s) => s.once(firstTurn, () => {}));
    const agent = rig.h.log.tables.agents.get(rig.brain.agentId)!;
    expect(agent).toMatchObject({ role: 'waykeeper', runtime: 'fake', projectId: rig.projectId });
    expect(agent.sessionRef).toMatch(/^fake:scripted-\d+:/);
    expect(rig.h.statuses.get(agent.id)?.state).toBe('idle');
    expect(rig.brain.prompts()).toHaveLength(1);
    const first = rig.brain.prompts()[0]!;
    expect(first).toContain('You are the waykeeper. A new session starts here.');
    expect(first).toContain(`Tasks of project ${rig.projectId} (CSV, in_progress) (2):`); // derived (P2-15): it has approved tasks
    expect(first).toContain('parse the file');
    expect(rig.brain.runner.turns.map((t) => t.kind)).toEqual(['first']);
    await rig.h.done();
  });

  it("a first-turn tool call works for a brain started from inside another brain's tool (P2-16)", async () => {
    const h = brainHarness();
    lives.push(h);
    const project = (await h.commands.createProject({ name: 'CSV', workspace: '/w/csv' })).value;
    const waykeeper = brainDefinition('waykeeper', [tool('ping', () => 'pong')]);
    // The Waykeeper's model calls a tool at once, in its spawn prompt's turn.
    h.script('waykeeper').once(firstTurn, async (t) => {
      await t.call('ping');
    });
    let started: Id | undefined;
    const hq = await h.startHarmonizer({
      definition: brainDefinition('harmonizer', [
        tool('start_waykeeper', async (_input, ctx) => {
          // What the Harmonizer's spawn_waykeeper does: a brain started inside a tool call.
          const wk = await h.startBrain(waykeeper, {
            runtime: 'fake',
            projectId: project.id,
            supervisorId: ctx.brainId,
          });
          started = wk.agentId;
          return { agentId: wk.agentId };
        }),
      ]),
      script: (s) => s.once('start it', (t) => t.call('start_waykeeper')),
    });
    hq.tell('start it');
    await h.until(() => started !== undefined && h.transcript(started)?.calls('ping').length === 1);
    await h.done();
    expect(h.transcript(started!)!.calls('ping')).toMatchObject([{ ok: true, value: 'pong' }]);
  });

  it('coalesces two simultaneous events into one turn', async () => {
    const rig = await boot((s) => s.once('first thing', () => {}));
    const a = rig.brain.tell('first thing');
    const b = rig.brain.tell('second thing');
    await rig.brain.settled();
    expect(rig.brain.prompts()).toHaveLength(2);
    const turn = rig.brain.prompts()[1]!;
    expect(turn).toContain(
      'Since your last turn:\n1. the user said: "first thing"\n2. the user said: "second thing"',
    );
    expect(turn).toContain('Agents you supervise (0):');
    expect(turnMessages(rig)).toHaveLength(1);
    // A turn prompt is marked, so the panel's conversation leaves it out (P25-03); the user's
    // lines are not.
    expect(turnMessages(rig)[0]).toMatchObject({ turn: true });
    const told = rig.h.log
      .eventsSince(0, Number.MAX_SAFE_INTEGER)
      .map((e) => e.event)
      .filter((e) => e.type === 'message.sent' && e.sender.type === 'user');
    expect(told).toHaveLength(2);
    expect(told.every((e) => e.type === 'message.sent' && e.turn === undefined)).toBe(true);
    // The folded messages reached the brain inside the turn: a restart must not redeliver them.
    const delivered = rig.h.log
      .eventsSince(0, Number.MAX_SAFE_INTEGER)
      .map((e) => e.event)
      .flatMap((e) => (e.type === 'message.delivered' ? [e.messageId] : []));
    expect(delivered).toEqual(expect.arrayContaining([a.id, b.id]));
    await rig.h.done();
  });

  it('coalesces Stewards finishing together into one turn, without waking on their output or tool calls', async () => {
    const rig = await boot((s) => s.once('finished', () => {}), [], { coalesceMs: 150 });
    for (const taskId of rig.taskIds) {
      await rig.h.commands.spawnAgent({
        role: 'steward',
        runtime: 'fake',
        taskId,
        supervisorId: rig.brain.agentId,
        prompt: 'scenario:happy',
      });
    }
    await rig.brain.waitForTurns(2);
    expect(rig.brain.prompts()).toHaveLength(2);
    const lines = rig.brain.runner.turns[1]!.items.map((i) => i.line);
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => /finished: "Done: fixed the flaky date test."$/.test(l))).toBe(true);
    expect(rig.brain.runner.turns[1]!.items.map((i) => i.event?.type)).toEqual([
      'agent.finished',
      'agent.finished',
    ]);
    await rig.h.done();
  });

  it('never re-enters a brain mid-turn: events wait for the next turn', async () => {
    const gate = latch();
    let entered = 0;
    const block = tool('think_hard', async () => {
      entered++;
      await gate.promise;
      return 'thought';
    });
    const rig = await boot(
      (s) =>
        s
          .once('start working', async (t) => {
            expect(await t.call('think_hard')).toBe('thought');
          })
          .once('3. the user said: "third"', () => {}),
      [block],
    );
    rig.brain.tell('start working');
    await rig.h.until(() => entered === 1);
    rig.brain.tell('second');
    await rig.h.commands.control({ kind: 'task', id: rig.taskIds[0]! }, { action: 'pause' }, USER);
    rig.brain.tell('third');
    await new Promise((r) => setTimeout(r, 50));
    expect(rig.brain.runner.state).toBe('in_turn');
    expect(rig.brain.prompts()).toHaveLength(2);
    expect(turnMessages(rig)).toHaveLength(1);
    expect(rig.brain.runner.pending().map((i) => i.line)).toEqual([
      'the user said: "second"',
      `user paused task ${rig.taskIds[0]}`,
      'the user said: "third"',
    ]);

    gate.release();
    await rig.brain.waitForTurns(3);
    expect(rig.brain.prompts()).toHaveLength(3);
    expect(entered).toBe(1);
    await rig.h.done();
  });

  it("does not wake on its own tool side effects, mid-turn or afterwards, but still on others' events", async () => {
    const ref: { rig?: Rig } = {};
    const pause = tool('pause_task', async (input, ctx) => {
      const { taskId } = input as { taskId: Id };
      await ctx.commands.control({ kind: 'task', id: taskId }, { action: 'pause' }, ctx.actor);
      // Meanwhile the user acts on the other task: that one must still wake the brain.
      await ref.rig!.h.commands.control(
        { kind: 'task', id: ref.rig!.taskIds[1]! },
        { action: 'pause' },
        USER,
      );
      return 'paused';
    });
    const rig = await boot(
      (s, w) =>
        s
          .once('pause the parser', (t) => t.call('pause_task', { taskId: w.taskIds[0] }))
          .once(`user paused task ${w.taskIds[1]}`, () => {}),
      [pause],
    );
    ref.rig = rig;
    rig.brain.tell('pause the parser');
    await rig.brain.waitForTurns(3);
    await new Promise((r) => setTimeout(r, 30));
    expect(rig.brain.prompts()).toHaveLength(3);
    const third = rig.brain.runner.turns[2]!;
    expect(third.items.map((i) => i.line)).toEqual([`user paused task ${rig.taskIds[1]}`]);
    const own = rig.h.log
      .eventsSince(0, Number.MAX_SAFE_INTEGER)
      .map((e) => e.event)
      .filter((e) => e.type === 'control.pause' && e.by.type === 'agent');
    expect(own).toHaveLength(1);
    expect(rig.brain.calls('pause_task')[0]).toMatchObject({ ok: true, value: 'paused' });
    expect(rig.brain.runner.pending()).toEqual([]);
    await rig.h.done();
  });

  it('ends the turn on a non-blocking user-facing tool and refuses later calls in that turn', async () => {
    const calls: string[] = [];
    const named = (name: string) =>
      tool(name, () => {
        calls.push(name);
        return `${name} done`;
      });
    const rig = await boot(
      (s) =>
        s.once('export it', async (t) => {
          expect(await t.call('ask_user', { text: 'Which format?' })).toBe('ask_user done');
          const late = await t.try('note');
          expect(late).toMatchObject({ ok: false, error: 'turn_ended' });
        }),
      [named('ask_user'), named('note')],
    );
    rig.brain.tell('export it');
    await rig.brain.waitForTurns(2);
    expect(calls).toEqual(['ask_user']);
    expect(rig.brain.runner.turns[1]!.endedBy).toBe('ask_user');
    expect(rig.brain.calls('ask_user')[0]).toMatchObject({ turnEnded: true });
    const text = transcriptText(rig);
    expect(text).toContain('"turnEnded":true');
    expect(text).toContain('turn_ended');
    await rig.h.done();
  });

  it('returns a refused command to the brain as a tool error instead of failing the turn', async () => {
    const close = tool('close_task', (_input, ctx) =>
      ctx.commands.closeTask('t-missing', ctx.actor),
    );
    const rig = await boot((s) => s.once('close it', (t) => t.try('close_task')), [close]);
    rig.brain.tell('close it');
    await rig.brain.waitForTurns(2);
    expect(rig.brain.calls('close_task')).toEqual([
      expect.objectContaining({ ok: false, error: 'not_found' }),
    ]);
    expect(transcriptText(rig)).toContain('"error":"not_found"');
    expect(rig.h.statuses.get(rig.brain.agentId)?.state).toBe('idle');
    await rig.h.done();
  });

  it('resets the session after N turns on the same agent row, carrying the summary', async () => {
    const rig = await boot(
      (s) =>
        s.on('carry_summary', (t) =>
          t.call('carry_summary', { summary: 'promised the user a CSV export by Friday' }),
        ),
      [],
      { reset: { afterTurns: 2 }, strict: false },
    );
    const id = rig.brain.agentId;
    const before = rig.h.log.tables.agents.get(id)!.sessionRef;
    rig.brain.tell('how is it going?');
    await rig.brain.waitForTurns(4);
    expect(rig.brain.runner.turns.map((t) => [t.kind, t.session])).toEqual([
      ['first', 1],
      ['mailbox', 1],
      ['summary', 1],
      ['first', 2],
    ]);
    expect(rig.brain.runner.carriedSummary()).toBe('promised the user a CSV export by Friday');
    const fresh = rig.brain.turns.at(-1)!;
    expect(fresh).toMatchObject({ n: 0, session: 2 });
    expect(fresh.prompt).toContain(
      'Summary carried from your previous session:\npromised the user a CSV export by Friday',
    );
    const after = rig.h.log.tables.agents.get(id)!.sessionRef;
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
    expect(rig.h.statuses.get(id)?.state).toBe('idle');
    expect(rig.h.log.tables.agents.all().filter((a) => a.role === 'waykeeper')).toHaveLength(1);

    // The new session takes turns like the old one (and resets again after its second).
    rig.brain.tell('still there?');
    await rig.brain.waitForTurns(5);
    expect(rig.brain.runner.turns[4]!.prompt).toContain('the user said: "still there?"');
    await rig.h.done();
  });

  it('resets on demand with a computed summary, folding waiting events into the first prompt', async () => {
    const rig = await boot(() => {}, [], { reset: { summarize: () => 'computed summary' } });
    rig.brain.runner.requestReset();
    await rig.brain.waitForTurns(2);
    expect(rig.brain.runner.turns[1]!).toMatchObject({ kind: 'first', session: 2 });
    expect(rig.brain.prompts()[1]!).toContain('computed summary');
    await rig.h.done();
  });

  it('stops driving the brain when the brain agent ends', async () => {
    const rig = await boot();
    await rig.h.commands.stopAgent(rig.brain.agentId, USER);
    await rig.h.until(() => rig.brain.runner.state === 'ended');
    await rig.brain.settled();
    await rig.h.done();
  });
});

describe('BrainRunner — the user’s slash commands (P8-13)', () => {
  /** What Claude Code offers a brain (`settingSources: []`): its built-ins and bundled skills. */
  const OFFERED = [
    { name: 'compact', builtin: true },
    { name: 'clear', aliases: ['reset', 'new'], builtin: true },
    { name: 'init', builtin: true },
    { name: 'review', builtin: true },
    { name: 'security-review', builtin: true },
    { name: 'context', builtin: true },
    { name: 'usage', aliases: ['cost'], builtin: true },
  ];

  it('sends a slash command the session offers as typed, as its own turn; anything else is folded', async () => {
    const h = brainHarness({ adapter: { commands: OFFERED } });
    lives.push(h);
    const hq = await h.startHarmonizer();
    await hq.settled();
    // No client read the commands: the runtime read them itself when the session opened.
    hq.tell('/compact');
    await hq.settled();
    expect(hq.prompts().at(-1)).toBe('/compact');

    const before = hq.prompts().length;
    hq.tell('first thing');
    hq.tell('/compact keep the plan');
    hq.tell('/tmp/x is full');
    hq.tell('/unknown');
    await hq.settled();
    const turns = hq.prompts().slice(before);
    expect(turns).toHaveLength(3);
    expect(turns[0]).toContain('Since your last turn:\n1. the user said: "first thing"');
    expect(turns[0]).not.toContain('/compact');
    // As typed: no "since your last turn", no seed — the runtime runs the command.
    expect(turns[1]).toBe('/compact keep the plan');
    expect(turns[2]).toContain('the user said: "/tmp/x is full"');
    expect(turns[2]).toContain('the user said: "/unknown"');
    // The user's command was delivered like any folded message (a restart does not resend it).
    const delivered = h.log
      .eventsSince(0, Number.MAX_SAFE_INTEGER)
      .map((e) => e.event)
      .filter((e) => e.type === 'message.delivered');
    const sent = h.log
      .eventsSince(0, Number.MAX_SAFE_INTEGER)
      .map((e) => e.event)
      .find(
        (e) =>
          e.type === 'message.sent' &&
          e.sender.type === 'user' &&
          e.text === '/compact keep the plan',
      );
    expect(
      delivered.some(
        (e) => sent?.type === 'message.sent' && 'messageId' in e && e.messageId === sent.messageId,
      ),
    ).toBe(true);
    await h.done();
  });

  it('runs only the allowlist for a brain: /clear, /init, /review stay text (review S1)', async () => {
    const h = brainHarness({ adapter: { commands: OFFERED } });
    lives.push(h);
    const hq = await h.startHarmonizer();
    await hq.settled();
    // The endpoint, the composer's list and the runner read the same cut list.
    expect((await h.composed.runtime.commands(hq.agentId)).map((c) => c.name)).toEqual([
      'compact',
      'context',
      'usage',
    ]);
    for (const name of ['clear', 'reset', 'init', 'review', 'security-review'])
      expect(h.composed.runtime.hasCommand(hq.agentId, name)).toBe(false);
    // An alias runs its command (review N2): `/cost` is Claude Code's `/usage`.
    expect(h.composed.runtime.hasCommand(hq.agentId, 'cost')).toBe(true);

    const before = hq.prompts().length;
    hq.tell('/clear');
    hq.tell('/init');
    hq.tell('/review 12');
    await hq.settled();
    const turns = hq.prompts().slice(before);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toContain('the user said: "/clear"');
    expect(turns[0]).toContain('the user said: "/init"');
    expect(turns[0]).toContain('the user said: "/review 12"');

    hq.tell('/cost');
    await hq.settled();
    expect(hq.prompts().at(-1)).toBe('/cost');
    await h.done();
  });

  it('a Steward keeps its runtime’s whole list', async () => {
    const h = brainHarness({ adapter: { commands: OFFERED } });
    lives.push(h);
    const steward = await h.composed.runtime.spawn({
      runtime: 'fake',
      role: 'steward',
      cwd: '/tmp',
      prompt: 'scenario:echo',
    });
    if (!steward.ok) throw new Error(steward.reason);
    expect((await h.composed.runtime.commands(steward.agent.id)).map((c) => c.name)).toEqual(
      OFFERED.map((c) => c.name),
    );
    expect(h.composed.runtime.hasCommand(steward.agent.id, 'clear')).toBe(true);
    await h.composed.runtime.stop(steward.agent.id, USER);
    await h.done();
  });
});
