import { afterEach, describe, expect, it } from 'vitest';
import type { Actor, Id } from '@galactic/protocol';
import { openDatabase } from '../db/database.js';
import { createAgent } from '../domain/agents.js';
import { EARTH_ID } from '../domain/catalogue.js';
import { DEFAULT_CAPS } from '../runtime/caps.js';
import { composeRuntime, type ComposedRuntime } from '../runtime/compose.js';
import type { BrainDefinition, BrainTool } from './definition.js';
import type { BrainRunner, SessionResetPolicy } from './runner.js';
import { callTool, scriptedBrains, type BrainScript } from './testing/scripted-brain.js';

/**
 * The brain runner (P2-06) over the real runtime, the fake adapter and a scripted brain: one turn
 * at a time, simultaneous events coalesced into one turn, the brain's own side effects never
 * waking it, turn-ending tools, DB seeding and session reset.
 */

const USER: Actor = { type: 'user' };
const lives: ComposedRuntime[] = [];
afterEach(async () => {
  for (const c of lives.splice(0)) await c.dispose().catch(() => {});
});

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A promise a test resolves by hand: a tool handler that blocks the turn until released. */
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}

interface Rig extends ComposedRuntime {
  prompts: ReturnType<typeof scriptedBrains>['prompts'];
  errors: string[];
  projectId: Id;
  taskIds: Id[];
  brain: BrainRunner;
}

async function boot(
  script: BrainScript,
  tools: BrainTool[] = [],
  opts: { coalesceMs?: number; reset?: SessionResetPolicy } = {},
): Promise<Rig> {
  const { adapter, prompts } = scriptedBrains(script);
  const errors: string[] = [];
  const composed = composeRuntime(openDatabase(':memory:'), {
    adapters: [adapter],
    flushMs: 10,
    onError: (e, ctx) => errors.push(`${ctx}: ${(e as Error).message}`),
  });
  lives.push(composed);
  // The body catalogue is seeded by migration 0005.
  const project = (await composed.commands.createProject({ name: 'CSV', workspace: '/w/csv' }))
    .value;
  const taskIds: Id[] = [];
  for (const description of ['parse the file', 'write the export']) {
    taskIds.push(
      (await composed.commands.createTask({ description, projectId: project.id })).value.id,
    );
  }
  const definition: BrainDefinition = {
    role: 'waykeeper',
    systemPrompt: 'You are the Waykeeper of a test project.',
    tools,
  };
  // The Waykeeper's supervisor (P2-20): a Harmonizer row, without a session of its own.
  const harmonizer = composed.log.runCommand((ctx) =>
    createAgent(ctx, { role: 'harmonizer', runtime: 'fake', caps: DEFAULT_CAPS, bodyId: EARTH_ID }),
  ).value;
  const brain = await composed.startBrain(
    definition,
    { runtime: 'fake', projectId: project.id, supervisorId: harmonizer.id },
    opts,
  );
  await brain.settled();
  return { ...composed, prompts, errors, projectId: project.id, taskIds, brain };
}

/** Messages the runner sent to the brain: one per turn after the first. */
const turnMessages = (rig: Rig) =>
  rig.log
    .eventsSince(0, Number.MAX_SAFE_INTEGER)
    .map((e) => e.event)
    .filter((e) => e.type === 'message.sent' && e.agentId === rig.brain.agentId)
    .filter((e) => e.type === 'message.sent' && e.sender.type === 'system');

describe('BrainRunner', () => {
  it('spawns the brain through the runtime with its tools, system prompt and a seeded first prompt', async () => {
    const rig = await boot(() => []);
    const agent = rig.log.tables.agents.get(rig.brain.agentId)!;
    expect(agent).toMatchObject({ role: 'waykeeper', runtime: 'fake', projectId: rig.projectId });
    expect(agent.sessionRef).toMatch(/^fake:scripted-brain:/);
    expect(rig.statuses.get(agent.id)?.state).toBe('idle');
    expect(rig.prompts).toHaveLength(1);
    const first = rig.prompts[0]!.prompt;
    expect(first).toContain('You are the waykeeper. A new session starts here.');
    expect(first).toContain(`Tasks of project ${rig.projectId} (CSV, in_progress) (2):`); // derived (P2-15): it has approved tasks
    expect(first).toContain('parse the file');
    expect(rig.brain.turns.map((t) => t.kind)).toEqual(['first']);
    expect(rig.errors).toEqual([]);
  });

  it('coalesces two simultaneous events into one turn', async () => {
    const rig = await boot(() => []);
    const id = rig.brain.agentId;
    const a = rig.runtime.send(id, 'first thing', { sender: USER });
    const b = rig.runtime.send(id, 'second thing', { sender: USER });
    await rig.brain.settled();
    expect(rig.prompts).toHaveLength(2);
    const turn = rig.prompts[1]!.prompt;
    expect(turn).toContain(
      'Since your last turn:\n1. the user said: "first thing"\n2. the user said: "second thing"',
    );
    expect(turn).toContain('Agents you supervise (0):');
    expect(turnMessages(rig)).toHaveLength(1);
    // The folded messages reached the brain inside the turn: a restart must not redeliver them.
    const delivered = rig.log
      .eventsSince(0, Number.MAX_SAFE_INTEGER)
      .map((e) => e.event)
      .flatMap((e) => (e.type === 'message.delivered' ? [e.messageId] : []));
    expect(delivered).toEqual(expect.arrayContaining([a.id, b.id]));
  });

  it('coalesces Stewards finishing together into one turn, without waking on their output or tool calls', async () => {
    const rig = await boot(() => [], [], { coalesceMs: 150 });
    for (const taskId of rig.taskIds) {
      await rig.commands.spawnAgent({
        role: 'steward',
        runtime: 'fake',
        taskId,
        supervisorId: rig.brain.agentId,
        prompt: 'scenario:happy',
      });
    }
    await until(() => rig.prompts.length >= 2);
    await rig.brain.settled();
    expect(rig.prompts).toHaveLength(2);
    const lines = rig.brain.turns[1]!.items.map((i) => i.line);
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => /finished: "Done: fixed the flaky date test."$/.test(l))).toBe(true);
    expect(rig.brain.turns[1]!.items.map((i) => i.event.type)).toEqual([
      'agent.finished',
      'agent.finished',
    ]);
  });

  it('never re-enters a brain mid-turn: events wait for the next turn', async () => {
    const gate = latch();
    let entered = 0;
    const block: BrainTool = {
      name: 'think_hard',
      description: 'blocks until the test releases it',
      inputSchema: { type: 'object' },
      handler: async () => {
        entered++;
        await gate.promise;
        return 'thought';
      },
    };
    const rig = await boot(({ n }) => (n === 1 ? [callTool('think_hard')] : []), [block]);
    const id = rig.brain.agentId;
    rig.runtime.send(id, 'start working', { sender: USER });
    await until(() => entered === 1);
    rig.runtime.send(id, 'second', { sender: USER });
    await rig.commands.control({ kind: 'task', id: rig.taskIds[0]! }, { action: 'pause' }, USER);
    rig.runtime.send(id, 'third', { sender: USER });
    await new Promise((r) => setTimeout(r, 50));
    expect(rig.brain.state).toBe('in_turn');
    expect(rig.prompts).toHaveLength(2);
    expect(turnMessages(rig)).toHaveLength(1);
    expect(rig.brain.pending().map((i) => i.line)).toEqual([
      'the user said: "second"',
      `user paused task ${rig.taskIds[0]}`,
      'the user said: "third"',
    ]);

    gate.release();
    await until(() => rig.prompts.length === 3);
    await rig.brain.settled();
    expect(rig.prompts).toHaveLength(3);
    expect(rig.prompts[2]!.prompt).toContain('3. the user said: "third"');
    expect(entered).toBe(1);
    expect(rig.errors).toEqual([]);
  });

  it("does not wake on its own tool side effects, mid-turn or afterwards, but still on others' events", async () => {
    const ref: { rig?: Rig } = {};
    const pause: BrainTool = {
      name: 'pause_task',
      description: 'pauses a task',
      inputSchema: { type: 'object' },
      handler: async (input, ctx) => {
        const { taskId } = input as { taskId: Id };
        await ctx.commands.control({ kind: 'task', id: taskId }, { action: 'pause' }, ctx.actor);
        // Meanwhile the user acts on the other task: that one must still wake the brain.
        await ref.rig!.commands.control(
          { kind: 'task', id: ref.rig!.taskIds[1]! },
          { action: 'pause' },
          USER,
        );
        return 'paused';
      },
    };
    const script: BrainScript = ({ n }) =>
      n === 1 ? [callTool('pause_task', { taskId: ref.rig!.taskIds[0] })] : [];
    const rig = await boot(script, [pause]);
    ref.rig = rig;
    rig.runtime.send(rig.brain.agentId, 'pause the parser', { sender: USER });
    await until(() => rig.prompts.length >= 3);
    await rig.brain.settled();
    await new Promise((r) => setTimeout(r, 30));
    expect(rig.prompts).toHaveLength(3);
    const third = rig.brain.turns[2]!;
    expect(third.items.map((i) => i.line)).toEqual([`user paused task ${rig.taskIds[1]}`]);
    const own = rig.log
      .eventsSince(0, Number.MAX_SAFE_INTEGER)
      .map((e) => e.event)
      .filter((e) => e.type === 'control.pause' && e.by.type === 'agent');
    expect(own).toHaveLength(1);
    expect(rig.brain.pending()).toEqual([]);
  });

  it('ends the turn on a non-blocking user-facing tool and refuses later calls in that turn', async () => {
    const calls: string[] = [];
    const tool = (name: string): BrainTool => ({
      name,
      description: name,
      inputSchema: { type: 'object' },
      handler: async () => {
        calls.push(name);
        return `${name} done`;
      },
    });
    const rig = await boot(
      ({ n }) =>
        n === 1 ? [callTool('ask_user', { text: 'Which format?' }), callTool('note')] : [],
      [tool('ask_user'), tool('note')],
    );
    rig.runtime.send(rig.brain.agentId, 'export it', { sender: USER });
    await until(() => rig.brain.turns.length === 2 && rig.brain.state === 'idle');
    expect(calls).toEqual(['ask_user']);
    expect(rig.brain.turns[1]!.endedBy).toBe('ask_user');
    rig.transcripts.flush();
    const text = rig.transcripts
      .read(rig.brain.agentId)
      .map((c) => c.text)
      .join('\n');
    expect(text).toContain('"turnEnded":true');
    expect(text).toContain('turn_ended');
  });

  it('returns a refused command to the brain as a tool error instead of failing the turn', async () => {
    const close: BrainTool = {
      name: 'close_task',
      description: 'closes a task',
      inputSchema: { type: 'object' },
      handler: (_input, ctx) => ctx.commands.closeTask('t-missing', ctx.actor),
    };
    const rig = await boot(({ n }) => (n === 1 ? [callTool('close_task')] : []), [close]);
    rig.runtime.send(rig.brain.agentId, 'close it', { sender: USER });
    await until(() => rig.brain.turns.length === 2 && rig.brain.state === 'idle');
    rig.transcripts.flush();
    const text = rig.transcripts
      .read(rig.brain.agentId)
      .map((c) => c.text)
      .join('\n');
    expect(text).toContain('"error":"not_found"');
    expect(rig.statuses.get(rig.brain.agentId)?.state).toBe('idle');
  });

  it('resets the session after N turns on the same agent row, carrying the summary', async () => {
    const script: BrainScript = ({ prompt }) =>
      prompt.includes('carry_summary')
        ? [callTool('carry_summary', { summary: 'promised the user a CSV export by Friday' })]
        : [];
    const rig = await boot(script, [], { reset: { afterTurns: 2 } });
    const id = rig.brain.agentId;
    const before = rig.log.tables.agents.get(id)!.sessionRef;
    rig.runtime.send(id, 'how is it going?', { sender: USER });
    await until(() => rig.brain.turns.length === 4);
    await rig.brain.settled();
    expect(rig.brain.turns.map((t) => [t.kind, t.session])).toEqual([
      ['first', 1],
      ['mailbox', 1],
      ['summary', 1],
      ['first', 2],
    ]);
    expect(rig.brain.carriedSummary()).toBe('promised the user a CSV export by Friday');
    const fresh = rig.prompts[rig.prompts.length - 1]!;
    expect(fresh.n).toBe(0);
    expect(fresh.prompt).toContain(
      'Summary carried from your previous session:\npromised the user a CSV export by Friday',
    );
    const after = rig.log.tables.agents.get(id)!.sessionRef;
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
    expect(rig.statuses.get(id)?.state).toBe('idle');
    expect(rig.log.tables.agents.all().filter((a) => a.role === 'waykeeper')).toHaveLength(1);

    // The new session takes turns like the old one (and resets again after its second).
    rig.runtime.send(id, 'still there?', { sender: USER });
    await until(() => rig.brain.turns.length >= 5);
    await rig.brain.settled();
    expect(rig.brain.turns[4]!.prompt).toContain('the user said: "still there?"');
    expect(rig.errors).toEqual([]);
  });

  it('resets on demand with a computed summary, folding waiting events into the first prompt', async () => {
    const rig = await boot(() => [], [], { reset: { summarize: () => 'computed summary' } });
    rig.brain.requestReset();
    await until(() => rig.brain.turns.length === 2);
    await rig.brain.settled();
    expect(rig.brain.turns[1]!).toMatchObject({ kind: 'first', session: 2 });
    expect(rig.prompts[1]!.prompt).toContain('computed summary');
  });

  it('stops driving the brain when the brain agent ends', async () => {
    const rig = await boot(() => []);
    await rig.commands.stopAgent(rig.brain.agentId, USER);
    await until(() => rig.brain.state === 'ended');
    await rig.brain.settled();
  });
});
