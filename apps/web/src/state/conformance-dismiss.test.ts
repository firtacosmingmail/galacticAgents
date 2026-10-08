// @vitest-environment node
//
// P9-14 — replay vs snapshot for dismissed questions: a live session's clarification and
// permission request dismissed by the user (through the fake adapter), a brain's own question
// dismissed in the log, and clarifications superseded by the user's message. `question.cancelled`
// with `by` folds `meta.cancelledBy` / `meta.cancelReason` on the row; the client's fold and the
// server's table must agree at every commit.
import { afterEach, describe, expect, it } from 'vitest';
import {
  dismissalOf,
  DISMISSED_BY_USER,
  SUPERSEDED_BY_MESSAGE,
  type Actor,
  type EventEnvelope,
  type Snapshot,
} from '@galactic/protocol';
import { FakeAdapter, composeRuntime, openDatabase, type ComposedRuntime } from '@galactic/server';
import { applyEvent, applySnapshot, type WorldState } from './reduce.js';

const USER: Actor = { type: 'user' };

function tickingClock(): () => string {
  let t = Date.parse('2026-10-08T09:00:00.000Z');
  return () => new Date((t += 1000)).toISOString();
}

const lives: ComposedRuntime[] = [];
afterEach(async () => {
  for (const c of lives.splice(0)) await c.dispose().catch(() => {});
});

function tables(w: WorldState) {
  const { seq: _seq, statuses: _statuses, ...rest } = w;
  return rest;
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('replay vs snapshot conformance: dismissed questions (P9-14)', () => {
  it('folding the recorded log gives the server snapshot at every commit', async () => {
    const composed = composeRuntime(openDatabase(':memory:'), {
      adapters: [new FakeAdapter({ speed: 0 })],
      log: { now: tickingClock() },
      flushMs: 10,
    });
    lives.push(composed);
    const { log, commands } = composed;
    const start: Snapshot = { ...log.snapshot(), statuses: [] };
    const recorded: EventEnvelope[] = [];
    const checkpoints: Snapshot[] = [];
    log.subscribe((env) => {
      recorded.push(env);
      if (log.currentSeq() === env.seq) checkpoints.push({ ...log.snapshot(), statuses: [] });
    });

    const project = (await commands.createProject({ name: 'CSV', workspace: '/w/csv' })).value;
    const hq = (
      await commands.spawnAgent({ role: 'harmonizer', runtime: 'fake', cwd: '/w/hq', prompt: 'x' })
    ).value;
    const wk = (
      await commands.spawnAgent({
        role: 'waykeeper',
        runtime: 'fake',
        projectId: project.id,
        supervisorId: hq.id,
        prompt: 'x',
      })
    ).value;
    const task = (await commands.createTask({ description: 'a', projectId: project.id })).value;
    const steward = (
      await commands.spawnAgent({
        role: 'steward',
        runtime: 'fake',
        taskId: task.id,
        supervisorId: wk.id,
        prompt: 'scenario:full',
      })
    ).value;
    const pending = () => composed.statuses.get(steward.id)?.pendingQuestionId;

    // A live clarification and a live permission request, both dismissed by the user.
    await until(() => pending() !== undefined);
    const q1 = pending()!;
    await commands.dismissQuestion({ questionId: q1, by: USER, origin: 'remote' });
    await until(() => pending() !== undefined && pending() !== q1);
    const q2 = pending()!;
    await commands.dismissQuestion({ questionId: q2, by: USER, origin: 'local' });

    // A brain's own questions: one dismissed in the log, two superseded by the user's message.
    const ask = async (text: string) =>
      (
        await commands.openQuestion({
          kind: 'clarification',
          originAgentId: wk.id,
          context: { text },
        })
      ).value.id;
    const own = await ask('Which licence?');
    await commands.dismissQuestion({ questionId: own, by: USER });
    const a = await ask('Dark mode?');
    const b = await ask('Which font?');
    composed.runtime.send(wk.id, 'MIT, no dark mode, the default font', { sender: USER });
    expect((await commands.supersedeQuestions(wk.id)).sort()).toEqual([a, b].sort());

    let world = applySnapshot(start);
    let next = 0;
    for (const checkpoint of checkpoints) {
      while (next < recorded.length && recorded[next]!.seq <= checkpoint.seq) {
        world = applyEvent(world, recorded[next++]!);
      }
      expect(tables(world), `at seq ${checkpoint.seq}`).toEqual(tables(applySnapshot(checkpoint)));
    }
    expect(dismissalOf(world.questions[q1])).toEqual({ by: USER, reason: DISMISSED_BY_USER });
    expect(dismissalOf(world.questions[q2])).toEqual({ by: USER, reason: DISMISSED_BY_USER });
    expect(dismissalOf(world.questions[own])?.by).toEqual(USER);
    for (const q of [a, b]) {
      expect(dismissalOf(world.questions[q])).toEqual({
        by: { type: 'system' },
        reason: SUPERSEDED_BY_MESSAGE,
      });
    }
    const origins = recorded
      .map((e) => e.event)
      .filter((e) => e.type === 'question.cancelled')
      .map((e) => e.origin);
    expect(origins.slice(0, 2)).toEqual(['remote', 'local']);
  });
});
