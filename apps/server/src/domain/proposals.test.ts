import { describe, expect, it } from 'vitest';
import type { CreateProposalInput } from '@galactic/protocol';
import { world } from '../test/world.js';
import { createProject } from './projects.js';
import { setTaskState } from './states.js';
import { createProposal, decideProposal, proposePlan } from './proposals.js';

const input: CreateProposalInput = {
  requestText: 'Build a CLI that converts CSV to Parquet',
  kind: 'planet',
  proposedBody: { kind: 'planet', bodyId: 'b-mars', name: 'Mars' },
  workspace: '/w/csv',
  rationale: 'A new application',
};

describe('proposals', () => {
  it('creates a pending proposal with proposal.created', () => {
    const { run, tables } = world();
    const { value, events } = run((ctx) => createProposal(ctx, input));
    expect(value).toMatchObject({ state: 'pending', kind: 'planet', workspace: '/w/csv' });
    expect(tables.proposals.get(value.id)).toEqual(value);
    expect(events).toEqual([{ type: 'proposal.created', proposal: value }]);
  });

  it('refuses a body of another size, an unknown body and an empty workspace', () => {
    const { run } = world();
    expect(() =>
      run((ctx) => createProposal(ctx, { ...input, proposedBody: { kind: 'moon', name: 'x' } })),
    ).toThrow(/proposed body is a moon/);
    expect(() =>
      run((ctx) =>
        createProposal(ctx, {
          ...input,
          proposedBody: { kind: 'planet', bodyId: 'b-x', name: 'x' },
        }),
      ),
    ).toThrow(/no body b-x/);
    expect(() => run((ctx) => createProposal(ctx, { ...input, workspace: '' }))).toThrow(
      /workspace/,
    );
  });

  it('edits (size, body, workspace) and approves an edited proposal', () => {
    const { run, tables } = world();
    const p = run((ctx) => createProposal(ctx, input)).value;
    const changes = {
      kind: 'moon' as const,
      proposedBody: {
        kind: 'moon' as const,
        bodyId: 'b-phobos',
        parentId: 'b-mars',
        name: 'Phobos',
      },
    };
    const edited = run((ctx) => decideProposal(ctx, p.id, { decision: 'edit', changes }));
    expect(edited.events).toEqual([{ type: 'proposal.edited', proposalId: p.id, changes }]);
    expect(tables.proposals.get(p.id)).toMatchObject({ ...changes, state: 'edited' });
    expect(() =>
      run((ctx) => decideProposal(ctx, p.id, { decision: 'edit', changes: { kind: 'asteroid' } })),
    ).toThrow(/proposed body is a moon/);
    const approved = run((ctx) => decideProposal(ctx, p.id, { decision: 'approve' }));
    expect(approved.events).toEqual([{ type: 'proposal.approved', proposalId: p.id }]);
    expect(approved.value.state).toBe('approved');
  });

  it('keeps a rejected proposal as a draft that can be edited, never decided as it is', () => {
    const { run } = world();
    const p = run((ctx) => createProposal(ctx, input)).value;
    expect(
      run((ctx) => decideProposal(ctx, p.id, { decision: 'reject', reason: 'later' })).events,
    ).toEqual([{ type: 'proposal.rejected', proposalId: p.id, reason: 'later' }]);
    expect(() => run((ctx) => decideProposal(ctx, p.id, { decision: 'approve' }))).toThrow(
      /rejected; it cannot be approved/,
    );
    const edited = run((ctx) =>
      decideProposal(ctx, p.id, { decision: 'edit', changes: { workspace: '/w/new' } }),
    );
    expect(edited.value.state).toBe('edited');
  });

  it('parks, un-parks by approval, and never decides an approved proposal again', () => {
    const { run } = world();
    const p = run((ctx) => createProposal(ctx, input)).value;
    expect(
      run((ctx) => decideProposal(ctx, p.id, { decision: 'park', reason: 'no free planet' }))
        .events,
    ).toEqual([{ type: 'proposal.parked', proposalId: p.id, reason: 'no free planet' }]);
    expect(() =>
      run((ctx) => decideProposal(ctx, p.id, { decision: 'park', reason: 'again' })),
    ).toThrow(/parked; it cannot be parked/);
    run((ctx) => decideProposal(ctx, p.id, { decision: 'approve' }));
    for (const decision of [
      { decision: 'approve' as const },
      { decision: 'reject' as const },
      { decision: 'edit' as const, changes: { workspace: '/x' } },
    ]) {
      expect(() => run((ctx) => decideProposal(ctx, p.id, decision))).toThrow(/approved/);
    }
    expect(() => run((ctx) => decideProposal(ctx, 'pr-x', { decision: 'approve' }))).toThrow(
      /no proposal/,
    );
  });
});

describe('plan cards (P2-10)', () => {
  function planWorld() {
    const w = world();
    const project = w.run((ctx) =>
      createProject(ctx, { name: 'CSV', workspace: '/w/csv', kind: 'planet' }, {}),
    ).value;
    const waykeeper = {
      id: 'a-wk',
      role: 'waykeeper' as const,
      runtime: 'fake' as const,
      bodyId: project.bodyId,
      projectId: project.id,
      caps: { maxWallClockMs: 1000, maxToolCalls: 10 },
      createdAt: '2026-10-01T09:00:00.000Z',
      updatedAt: '2026-10-01T09:00:00.000Z',
    };
    w.tables.agents.insert(waykeeper);
    const plan = (extra: Partial<Parameters<typeof proposePlan>[1]> = {}) =>
      w.run((ctx) =>
        proposePlan(ctx, {
          projectId: project.id,
          waykeeperId: waykeeper.id,
          summary: 'Two tasks: the reader, then the writer',
          tasks: [
            { description: 'read CSV' },
            { description: 'write Parquet', priority: 'high', blockedBy: [0] },
          ],
          ...extra,
        }),
      );
    return { ...w, project, waykeeper, plan };
  }

  it('creates the tasks proposed and one card carrying them, in one command', () => {
    const { plan, project, tables } = planWorld();
    const { value, types } = plan();
    expect(types).toEqual(['task.created', 'task.created', 'proposal.created']);
    const [read, write] = value.tasks;
    expect(read).toMatchObject({ state: 'proposed', projectId: project.id });
    expect(write).toMatchObject({ state: 'proposed', priority: 'high', blockedBy: [read!.id] });
    expect(value.proposal).toMatchObject({
      state: 'pending',
      kind: 'planet',
      proposedBody: { kind: 'planet', bodyId: project.bodyId },
      workspace: '/w/csv',
      requestText: 'Two tasks: the reader, then the writer',
      meta: {
        plan: { projectId: project.id, waykeeperId: 'a-wk', taskIds: [read!.id, write!.id] },
      },
    });
    expect(tables.proposals.get(value.proposal.id)).toEqual(value.proposal);
  });

  it('plans once: refused while a card waits and after approval; approval approves the tasks', () => {
    const { plan, tables, run } = planWorld();
    const first = plan().value;
    expect(() => plan()).toThrow(/waiting for the user/);
    const [read, write] = first.tasks;
    // The user drops a task from the draft before approving: it stays archived.
    run((ctx) => setTaskState(ctx, write!.id, 'archived', { type: 'user' }));
    const approved = run((ctx) =>
      decideProposal(ctx, first.proposal.id, { decision: 'approve' }, { type: 'user' }),
    );
    expect(approved.types).toEqual(['proposal.approved', 'task.state_changed']);
    expect(tables.tasks.get(read!.id)!.state).toBe('approved');
    expect(tables.tasks.get(write!.id)!.state).toBe('archived');
    expect(() => plan()).toThrow(/was approved/);
  });

  it('only the user decides a plan, by approving or rejecting it as a whole', () => {
    const { plan, run, tables } = planWorld();
    const { proposal, tasks } = plan().value;
    const decide = (
      decision: Parameters<typeof decideProposal>[2],
      by = { type: 'user' as const },
    ) => run((ctx) => decideProposal(ctx, proposal.id, decision, by));
    expect(() =>
      run((ctx) =>
        decideProposal(ctx, proposal.id, { decision: 'approve' }, { type: 'agent', id: 'a-wk' }),
      ),
    ).toThrow(/user's to decide/);
    expect(() => decide({ decision: 'edit', changes: { workspace: '/x' } })).toThrow(
      /edit its tasks/,
    );
    expect(() => decide({ decision: 'park', reason: 'x' })).toThrow(/not parked/);
    decide({ decision: 'reject', reason: 'split the writer' });
    // The draft stays; a new plan replaces it and archives the old tasks that never started.
    expect(tables.tasks.get(tasks[0]!.id)!.state).toBe('proposed');
    const next = plan({ tasks: [{ description: 'read and write in one go' }] });
    expect(next.types).toEqual([
      'task.state_changed',
      'task.state_changed',
      'task.created',
      'proposal.created',
    ]);
    expect(tasks.map((t) => tables.tasks.get(t.id)!.state)).toEqual(['archived', 'archived']);
  });

  it('refuses an empty plan, a forward dependency, a plain proposal posing as a plan and a stranger', () => {
    const { plan, run } = planWorld();
    expect(() => plan({ tasks: [] })).toThrow(/at least one task/);
    expect(() => plan({ tasks: [{ description: 'a', blockedBy: [0] }] })).toThrow(/earlier tasks/);
    expect(() => plan({ waykeeperId: 'a-nobody' })).toThrow(/no agent/);
    expect(() =>
      run((ctx) =>
        createProposal(ctx, {
          ...input,
          meta: { plan: { projectId: 'p', waykeeperId: 'a', taskIds: ['t'] } },
        }),
      ),
    ).toThrow(/proposePlan/);
  });
});
