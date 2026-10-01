import { describe, expect, it } from 'vitest';
import type { CreateProposalInput } from '@galactic/protocol';
import { world } from '../test/world.js';
import { createProposal, decideProposal } from './proposals.js';

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
        createProposal(ctx, { ...input, proposedBody: { kind: 'planet', bodyId: 'b-x', name: 'x' } }),
      ),
    ).toThrow(/no body b-x/);
    expect(() => run((ctx) => createProposal(ctx, { ...input, workspace: '' }))).toThrow(/workspace/);
  });

  it('edits (size, body, workspace) and approves an edited proposal', () => {
    const { run, tables } = world();
    const p = run((ctx) => createProposal(ctx, input)).value;
    const changes = {
      kind: 'moon' as const,
      proposedBody: { kind: 'moon' as const, bodyId: 'b-phobos', parentId: 'b-mars', name: 'Phobos' },
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
    expect(run((ctx) => decideProposal(ctx, p.id, { decision: 'reject', reason: 'later' })).events).toEqual([
      { type: 'proposal.rejected', proposalId: p.id, reason: 'later' },
    ]);
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
    expect(run((ctx) => decideProposal(ctx, p.id, { decision: 'park', reason: 'no free planet' })).events).toEqual([
      { type: 'proposal.parked', proposalId: p.id, reason: 'no free planet' },
    ]);
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
