// @vitest-environment node
//
// P2-09 — replay vs snapshot for the proposal flow: a card parked with its occupied planets, the
// planet freed and the card un-parked in the same commit, an `initGit` consent and a downsize
// edit, approvals that create projects and tasks. The reducer folds `meta.parked` / `meta.initGit`
// with the protocol's `foldProposalMeta`, as the server does; at every commit they must agree.
import { afterEach, describe, expect, it } from 'vitest';
import {
  PERMISSION_POLICY_PRESETS,
  type Actor,
  type CreateProposalInput,
  type EventEnvelope,
  type Id,
  type Snapshot,
} from '@galactic/protocol';
import { FakeAdapter, composeRuntime, openDatabase, type ComposedRuntime } from '@galactic/server';
import { applyEvent, applySnapshot, type WorldState } from './reduce.js';

const USER: Actor = { type: 'user' };

function tickingClock(): () => string {
  let t = Date.parse('2026-10-01T09:00:00.000Z');
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

const card = (name: string, extra: Partial<CreateProposalInput> = {}): CreateProposalInput => ({
  requestText: `Build ${name}`,
  kind: 'planet',
  proposedBody: { kind: 'planet', name },
  workspace: `/w/${name.toLowerCase()}`,
  rationale: 'a new application',
  meta: { request: { type: 'new_project', name } },
  ...extra,
});

describe('replay vs snapshot conformance: the proposal flow (P2-09)', () => {
  it('folding the recorded log gives the server snapshot at every commit', async () => {
    const composed = composeRuntime(openDatabase(':memory:'), {
      adapters: [new FakeAdapter()],
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

    // Every planet taken; the first project completed.
    const made: Id[] = [];
    for (let i = 0; i < 7; i++) {
      made.push((await commands.createProject({ name: `P${i}`, workspace: `/w/p${i}` })).value.id);
    }
    await commands.closeProject(made[0]!, USER);

    // Parked at creation (with the occupied planets), and a second one waiting behind it.
    const game = (await commands.createProposal(card('Game'))).value;
    const later = (await commands.createProposal(card('Later'))).value;
    expect([game.state, later.state]).toEqual(['parked', 'parked']);
    // The user consents to git init on the parked card: an edit, still parked.
    await commands.decideProposal(game.id, { decision: 'edit', changes: { initGit: true } }, USER);
    // …and makes it trusted, then cautious, then trusted again (P2-22, decision 49).
    for (const trust of ['trusted', 'cautious', 'default', 'trusted'] as const) {
      await commands.decideProposal(game.id, { decision: 'edit', changes: { trust } }, USER);
    }
    // A planet frees: the oldest card un-parks in the same commit.
    await commands.archiveProject(made[0]!, USER);
    expect(log.tables.proposals.get(game.id)?.state).toBe('pending');
    await commands.decideProposal(game.id, { decision: 'approve' }, USER, { origin: 'local' });
    // The other one is downsized to a moon by the user (un-parked by the edit) and approved.
    await commands.decideProposal(
      later.id,
      {
        decision: 'edit',
        changes: { kind: 'moon', proposedBody: { kind: 'moon', name: 'Later' } },
      },
      USER,
    );
    await commands.decideProposal(later.id, { decision: 'approve' }, USER);
    // A standalone card approved into a task; one parked by hand and rejected.
    const fix = (
      await commands.createProposal({
        requestText: 'fix the flaky test',
        kind: 'asteroid',
        proposedBody: { kind: 'asteroid', name: 'Flaky' },
        workspace: '/w/scratch/flaky',
        rationale: 'small',
        meta: { request: { type: 'standalone_task', name: 'Flaky', description: 'fix it' } },
      })
    ).value;
    await commands.decideProposal(fix.id, { decision: 'approve' }, USER);
    const someday = (
      await commands.createProposal(
        card('Someday', {
          kind: 'moon',
          proposedBody: { kind: 'moon', name: 'Someday' },
        }),
      )
    ).value;
    await commands.decideProposal(someday.id, { decision: 'park', reason: 'not now' }, USER);
    await commands.decideProposal(someday.id, { decision: 'reject' }, USER);

    const types = new Set(recorded.map((e) => e.event.type));
    for (const t of [
      'proposal.created',
      'proposal.parked',
      'proposal.edited',
      'proposal.unparked',
      'proposal.approved',
      'proposal.rejected',
      'project.created',
      'task.created',
      'body.freed',
    ] as const) {
      expect(types, t).toContain(t);
    }

    let world = applySnapshot(start);
    let next = 0;
    for (const checkpoint of checkpoints) {
      while (next < recorded.length && recorded[next]!.seq <= checkpoint.seq) {
        world = applyEvent(world, recorded[next++]!);
      }
      expect(world.seq).toBe(checkpoint.seq);
      expect(tables(world), `at seq ${checkpoint.seq}`).toEqual(tables(applySnapshot(checkpoint)));
    }
    expect(world.proposals[game.id]?.meta).toEqual({
      request: { type: 'new_project', name: 'Game' },
      initGit: true,
      trust: 'trusted',
    });
    const gameProject = Object.values(world.projects).find(
      (p) => p.meta?.['proposalId'] === game.id,
    );
    expect(gameProject?.permissionPolicy).toEqual(PERMISSION_POLICY_PRESETS.trusted);
    expect(world.proposals[someday.id]?.meta).not.toHaveProperty('parked');
  });
});
