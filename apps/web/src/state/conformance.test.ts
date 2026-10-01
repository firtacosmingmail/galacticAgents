// @vitest-environment node
//
// P2-01 — replay vs snapshot (TECHNOLOGY §6.2). Domain state is derived twice by design: the
// server's commands mutate the tables, this reducer folds the same events. A recorded event log,
// replayed from the snapshot it started from, must give the server's snapshot after every commit
// (statuses excluded: they are a server-owned projection, TECHNOLOGY §4).
import { afterEach, describe, expect, it } from 'vitest';
import type { Actor, EventEnvelope, Snapshot } from '@galactic/protocol';
import { FakeAdapter, composeRuntime, openDatabase, type ComposedRuntime } from '@galactic/server';
import { applyEvent, applySnapshot, type WorldState } from './reduce.js';

const USER: Actor = { type: 'user' };
const DAY = 24 * 60 * 60 * 1000;

/**
 * One second per reading: a row stamped with another reading than its event would show.
 * `advance` jumps ahead (the retention sweep of "moved to …" markers).
 */
function tickingClock(): (() => string) & { advance(ms: number): void } {
  let t = Date.parse('2026-10-01T09:00:00.000Z');
  const clock = () => new Date((t += 1000)).toISOString();
  return Object.assign(clock, { advance: (ms: number) => void (t += ms) });
}

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

/** The domain part of a world, for comparison (`seq` and statuses left out). */
function tables(w: WorldState) {
  const { seq: _seq, statuses: _statuses, ...rest } = w;
  return rest;
}

describe('replay vs snapshot conformance', () => {
  it('folding the recorded log gives the server snapshot at every commit', async () => {
    const clock = tickingClock();
    const composed = composeRuntime(openDatabase(':memory:'), {
      adapters: [new FakeAdapter({ speed: 5 })], // `long` runs ~5 s: alive for the whole walk
      log: { now: clock },
      flushMs: 10,
    });
    lives.push(composed);
    const { log, commands, statuses } = composed;
    // The catalogue is seeded without events (migration 0005, P2-02): the client gets it from
    // the snapshot it starts from, as a real client does.
    const start: Snapshot = { ...log.snapshot(), statuses: [] };

    const recorded: EventEnvelope[] = [];
    const checkpoints: Snapshot[] = [];
    log.subscribe((env) => {
      recorded.push(env);
      // The last event of a commit: the tables now are the state at this seq.
      if (log.currentSeq() === env.seq) checkpoints.push({ ...log.snapshot(), statuses: [] });
    });

    // --- a proposal's life
    const proposal = (
      await commands.createProposal({
        requestText: 'Build a CLI that converts CSV to Parquet',
        kind: 'planet',
        proposedBody: { kind: 'planet', bodyId: 'b-mars', name: 'Mars' },
        workspace: '/w/csv',
        rationale: 'A new application',
      })
    ).value;
    await commands.decideProposal(proposal.id, { decision: 'reject', reason: 'not yet' }, USER);
    await commands.decideProposal(
      proposal.id,
      { decision: 'edit', changes: { workspace: '/w/csv2' } },
      USER,
    );
    await commands.decideProposal(proposal.id, { decision: 'park', reason: 'no planet' }, USER);
    await commands.decideProposal(proposal.id, { decision: 'approve' }, USER);

    // --- projects, sub-project, tasks
    const project = (
      await commands.createProject({
        name: 'CSV to Parquet',
        workspace: '/w/csv',
        bodyId: 'b-mars',
        permissionPolicy: { rules: { network: 'allow' } },
      })
    ).value;
    const sub = (
      await commands.createProject({
        name: 'Writer',
        workspace: '/w/csv/writer',
        bodyId: 'b-phobos',
        parentProjectId: project.id,
      })
    ).value;
    await commands.updateProject(project.id, { repoPath: '/w/csv', pinned: true });
    await commands.setProjectState(project.id, 'in_progress');
    const parse = (
      await commands.createTask({
        description: 'Parse CSV',
        projectId: project.id,
        state: 'proposed',
      })
    ).value;
    const write = (
      await commands.createTask({
        description: 'Write Parquet',
        projectId: project.id,
        blockedBy: [parse.id],
        priority: 'high',
      })
    ).value;
    await commands.setTaskState(parse.id, 'approved');
    await commands.updateTask(parse.id, {
      worktreePath: '/w/csv/.galactic/worktrees/p',
      branch: 'g/p',
    });
    const flaky = (await commands.createTask({ description: 'Fix the flaky test' })).value;

    // --- agents through the runtime: spawn, a question answered, re-parenting
    const waykeeper = (
      await commands.spawnAgent({
        role: 'waykeeper',
        runtime: 'fake',
        projectId: project.id,
        prompt: 'scenario:long',
      })
    ).value;
    const steward = (
      await commands.spawnAgent({
        role: 'steward',
        runtime: 'fake',
        taskId: parse.id,
        supervisorId: waykeeper.id,
        prompt: 'scenario:asks',
      })
    ).value;
    const asteroidSteward = (
      await commands.spawnAgent({
        role: 'steward',
        runtime: 'fake',
        taskId: flaky.id,
        cwd: '/w/scratch',
        prompt: 'scenario:long',
      })
    ).value;
    await until(() => log.tables.questions.all().some((q) => q.originAgentId === steward.id));
    const asked = log.tables.questions.all().find((q) => q.originAgentId === steward.id)!;
    await commands.answerQuestion({
      questionId: asked.id,
      answer: 'ISO 8601',
      by: USER,
      version: 0,
    });
    await commands.updateAgent(asteroidSteward.id, { supervisorId: waykeeper.id });

    // --- questions opened outside a live session: reassigned, escalated, answered, cancelled
    const held = (
      await commands.openQuestion({
        kind: 'clarification',
        originAgentId: asteroidSteward.id,
        context: { text: 'Snappy or zstd?' },
      })
    ).value;
    await commands.reassignQuestion(
      held.id,
      { type: 'agent', id: waykeeper.id },
      'route to supervisor',
    );
    await commands.escalateQuestion(held.id, { type: 'agent', id: waykeeper.id });
    await commands.answerQuestion({ questionId: held.id, answer: 'zstd', by: USER, version: 2 });

    // --- moves: a standalone task joins the project (its Steward flies, its asteroid shows
    // "moved to …"), the sub-project moves (Phobos shows the marker)
    await commands.moveTask(flaky.id, project.id, USER);
    await commands.moveHost({ kind: 'project', id: sub.id }, 'b-deimos');
    // --- the catalogue picks bodies: a planet and an independent moon
    const loose = (await commands.createProject({ name: 'Loose', workspace: '/w/loose' })).value;
    await commands.createProject({ name: 'Small', workspace: '/w/small', kind: 'moon' });
    await commands.freeBody(flaky.bodyId); // a marker freed early
    await commands.closeProject(loose.id, USER);
    await commands.archiveProject(loose.id, USER);

    // --- panel actions with their effects
    await commands.control(
      { kind: 'task', id: write.id },
      { action: 'edit', changes: { priority: 'urgent' } },
      USER,
    );
    await commands.control({ kind: 'task', id: write.id }, { action: 'pause' }, USER);
    await commands.control({ kind: 'task', id: write.id }, { action: 'close' }, USER);
    await commands.control({ kind: 'task', id: write.id }, { action: 'reopen' }, USER);
    await commands.control(
      { kind: 'project', id: project.id },
      { action: 'pin', pinned: false },
      USER,
    );
    await commands.control({ kind: 'agent', id: waykeeper.id }, { action: 'pause' }, USER);
    await commands.control({ kind: 'agent', id: waykeeper.id }, { action: 'resume' }, USER);

    // --- closure, archival and a reopen on another body
    await until(() => statuses.get(steward.id)?.state === 'finished');
    await commands.closeTask(parse.id, { type: 'agent', id: waykeeper.id });
    await commands.closeProject(sub.id, USER);
    await commands.archiveProject(sub.id, USER);
    await commands.createProject({ name: 'Squatter', workspace: '/w/sq', bodyId: 'b-deimos' });
    // Phobos frees once its marker's retention has passed, and the sub-project reopens there.
    clock.advance(8 * DAY);
    await commands.sweepMarkers(7 * DAY);
    await commands.reopenProject(sub.id, USER, { bodyId: 'b-phobos' });

    // --- a standalone task archived by the panel, its asteroid freed and taken, reopened elsewhere
    const chore = (await commands.createTask({ description: 'Rotate logs' })).value;
    await commands.control({ kind: 'task', id: chore.id }, { action: 'cancel' }, USER);
    await commands.closeTask(chore.id, USER);
    await commands.freeBody(chore.bodyId);
    await commands.createTask({ description: 'Squat', bodyId: chore.bodyId });
    await commands.reopenTask(chore.id, USER);
    await commands.closeTask(chore.id, USER);
    await commands.control({ kind: 'task', id: chore.id }, { action: 'archive' }, USER);

    // --- a question left open when its agent stops is cancelled with the stop
    await commands.openQuestion({
      kind: 'clarification',
      originAgentId: asteroidSteward.id,
      context: { text: 'Keep the old flag?' },
    });
    await commands.stopAgent(asteroidSteward.id, USER);
    await commands.stopAgent(waykeeper.id, USER);
    await until(() => statuses.get(waykeeper.id)?.state === 'stopped');

    // Every event type this scenario was meant to cover was really logged.
    const types = new Set(recorded.map((e) => e.event.type));
    for (const t of [
      'proposal.created',
      'proposal.rejected',
      'proposal.edited',
      'proposal.parked',
      'proposal.approved',
      'project.created',
      'project.updated',
      'project.state_changed',
      'task.created',
      'task.updated',
      'task.state_changed',
      'body.created',
      'body.assigned',
      'body.moved',
      'body.freed',
      'agent.created',
      'agent.spawned',
      'agent.updated',
      'question.opened',
      'question.reassigned',
      'question.escalated',
      'question.answered',
      'control.edit',
      'control.close',
      'control.reopen',
      'control.pin',
      'control.pause',
      'control.resume',
      'control.stop',
      'control.cancel',
      'control.archive',
      'question.cancelled',
    ] as const) {
      expect(types, t).toContain(t);
    }

    // Replay: from the starting snapshot, fold the log; at each checkpoint compare.
    expect(checkpoints.length).toBeGreaterThan(40);
    let world = applySnapshot(start);
    let next = 0;
    for (const checkpoint of checkpoints) {
      while (next < recorded.length && recorded[next]!.seq <= checkpoint.seq) {
        world = applyEvent(world, recorded[next++]!);
      }
      expect(world.seq).toBe(checkpoint.seq);
      expect(tables(world), `at seq ${checkpoint.seq}`).toEqual(tables(applySnapshot(checkpoint)));
    }
    expect(tables(world)).toEqual(tables(applySnapshot({ ...log.snapshot(), statuses: [] })));
  });
});
