import { describe, expect, it } from 'vitest';
import {
  proposalParking,
  type Actor,
  type CreateProposalInput,
  type Proposal,
  type ProposalDecision,
} from '@galactic/protocol';
import { world } from '../test/world.js';
import type { ProposalOptions } from './approval.js';
import { freeBody } from './bodies.js';
import { DomainError } from './errors.js';
import { archiveProject, closeProject, createProject } from './projects.js';
import { createProposal, decideProposal, proposePlan } from './proposals.js';
import { archiveTask, closeTask, createTask } from './tasks.js';

/**
 * The proposal flow (P2-09; SPEC §3.3, decisions 1, 3, 16, 27, 34): every transition of a work
 * card, what approval creates, parking with the occupied bodies, and the automatic un-parking
 * when a planet frees.
 */

const USER: Actor = { type: 'user' };
const AGENT: Actor = { type: 'agent', id: 'a-hq' };

function newProject(name: string, extra: Partial<CreateProposalInput> = {}): CreateProposalInput {
  return {
    requestText: `Build ${name}`,
    kind: 'planet',
    proposedBody: { kind: 'planet', name },
    workspace: `/w/${name.toLowerCase()}`,
    rationale: 'a new application',
    meta: { request: { type: 'new_project', name } },
    ...extra,
  };
}

function flow(opts: ProposalOptions = {}) {
  const w = world();
  const propose = (input: CreateProposalInput) => w.run((ctx) => createProposal(ctx, input, opts));
  const decide = (p: Proposal | string, decision: ProposalDecision, by: Actor = USER) =>
    w.run((ctx) => decideProposal(ctx, typeof p === 'string' ? p : p.id, decision, by, opts));
  const card = (id: string) => w.tables.proposals.get(id)!;
  /** Fills every free planet with an approved project (the last one first, so Mars is last). */
  const fillPlanets = () => {
    const made = [];
    for (let i = 0; ; i++) {
      try {
        made.push(
          w.run((ctx) =>
            createProject(ctx, { name: `P${i}`, workspace: `/w/p${i}`, kind: 'planet' }, {}),
          ).value,
        );
      } catch (error) {
        if (error instanceof DomainError && error.code === 'conflict') return made;
        throw error;
      }
    }
  };
  return { ...w, propose, decide, card, fillPlanets };
}

describe('proposal flow (P2-09)', () => {
  it('created → approved: the approval creates the project on the body the card names', () => {
    const f = flow();
    const created = f.propose(
      newProject('Parquet', {
        proposedBody: { kind: 'planet', name: 'Parquet', bodyId: 'b-jupiter' },
      }),
    );
    expect(created.value.state).toBe('pending');
    expect(created.types).toEqual(['proposal.created']);
    const approved = f.decide(created.value, { decision: 'approve' });
    // One transaction: the decision, the project and its body.
    expect(approved.types).toEqual(['proposal.approved', 'project.created', 'body.assigned']);
    const [project] = f.tables.projects.all();
    expect(project).toMatchObject({
      name: 'Parquet',
      bodyId: 'b-jupiter',
      workspace: '/w/parquet',
      state: 'approved',
      meta: { proposalId: created.value.id },
    });
    expect(f.tables.bodies.get('b-jupiter')?.host).toEqual({ kind: 'project', id: project!.id });
  });

  it('edited (size, body, workspace, initGit) → approved creates the edited version', () => {
    const f = flow({
      checkWorkspace: (p) => {
        if (p === '/') throw new DomainError('invalid', 'the workspace cannot be /');
        return p.replace(/\/+$/, '');
      },
    });
    const { value: p } = f.propose(newProject('Docs'));
    expect(() => f.decide(p, { decision: 'edit', changes: { workspace: '/' } })).toThrow(
      /cannot be \//,
    );
    // Decision 27: only the user consents to turning a folder into a repository.
    expect(() => f.decide(p, { decision: 'edit', changes: { initGit: true } }, AGENT)).toThrow(
      /only the user/,
    );
    const changes = {
      kind: 'moon' as const,
      proposedBody: {
        kind: 'moon' as const,
        name: 'Docs',
        bodyId: 'b-europa',
        parentId: 'b-jupiter',
      },
      workspace: '/existing/docs/',
      initGit: true,
    };
    const edited = f.decide(p, { decision: 'edit', changes });
    expect(edited.events).toEqual([
      {
        type: 'proposal.edited',
        proposalId: p.id,
        changes: { ...changes, workspace: '/existing/docs' },
      },
    ]);
    expect(f.card(p.id)).toMatchObject({
      state: 'edited',
      kind: 'moon',
      workspace: '/existing/docs',
      meta: { initGit: true },
    });
    expect(f.card(p.id)).not.toHaveProperty('initGit');
    f.decide(p, { decision: 'approve' });
    expect(f.tables.projects.all()[0]).toMatchObject({
      bodyId: 'b-europa',
      workspace: '/existing/docs',
      meta: { proposalId: p.id, initGit: true },
    });
    // Withdrawn consent is dropped from the card.
    const { value: q } = f.propose(newProject('Other'));
    f.decide(q, { decision: 'edit', changes: { initGit: true } });
    f.decide(q, { decision: 'edit', changes: { initGit: false } });
    expect(f.card(q.id).meta).not.toHaveProperty('initGit');
  });

  it('rejected: the draft stays, nothing is created, and it can be revised and approved', () => {
    const f = flow();
    const { value: p } = f.propose(newProject('Parser'));
    expect(f.decide(p, { decision: 'reject', reason: 'later' }).types).toEqual([
      'proposal.rejected',
    ]);
    expect(f.tables.projects.all()).toEqual([]);
    expect(() => f.decide(p, { decision: 'approve' })).toThrow(/rejected; it cannot be approved/);
    f.decide(p, { decision: 'edit', changes: { workspace: '/w/parser2' } });
    f.decide(p, { decision: 'approve' });
    expect(f.tables.projects.all()[0]).toMatchObject({ workspace: '/w/parser2' });
  });

  it('approves a standalone card into a task on a fresh asteroid, and a project card resized to one', () => {
    const f = flow();
    const { value: asteroid } = f.propose({
      requestText: 'rename the logs',
      kind: 'asteroid',
      proposedBody: { kind: 'asteroid', name: 'Rename logs' },
      workspace: '/w/scratch/rename-logs',
      rationale: 'small',
      meta: {
        request: { type: 'standalone_task', name: 'Rename logs', description: 'rename the logs' },
      },
    });
    expect(f.decide(asteroid, { decision: 'approve' }).types).toEqual([
      'proposal.approved',
      'body.created',
      'task.created',
      'body.assigned',
    ]);
    const [task] = f.tables.tasks.all();
    expect(task).toMatchObject({
      description: 'rename the logs',
      meta: { proposalId: asteroid.id, workspace: '/w/scratch/rename-logs' },
    });
    expect(f.tables.bodies.get(task!.bodyId)?.kind).toBe('asteroid');

    const { value: small } = f.propose(newProject('Tiny'));
    f.decide(small, {
      decision: 'edit',
      changes: { kind: 'asteroid', proposedBody: { kind: 'asteroid', name: 'Tiny' } },
    });
    f.decide(small, { decision: 'approve' });
    expect(f.tables.projects.all()).toEqual([]);
    expect(f.tables.tasks.all().find((t) => t.meta?.['proposalId'] === small.id)).toMatchObject({
      description: 'Build Tiny',
      meta: { workspace: '/w/tiny' },
    });
  });

  it('approves a task for a project onto the project’s body, and never parks it', () => {
    const f = flow();
    f.fillPlanets();
    const project = f.tables.projects.all()[0]!;
    const { value: p } = f.propose({
      requestText: 'add pagination',
      kind: 'planet',
      proposedBody: { kind: 'planet', name: 'Pagination', bodyId: project.bodyId },
      workspace: project.workspace,
      rationale: 'belongs to it',
      meta: {
        request: {
          type: 'project_task',
          name: 'Pagination',
          description: 'add pagination',
          projectId: project.id,
        },
      },
    });
    expect(p.state).toBe('pending');
    expect(f.decide(p, { decision: 'approve' }).types).toEqual([
      'proposal.approved',
      'task.created',
    ]);
    expect(f.tables.tasks.all()[0]).toMatchObject({
      projectId: project.id,
      bodyId: project.bodyId,
      meta: { proposalId: p.id },
    });
  });

  it('parks a card when no planet is free, listing the occupied planets and the offers', () => {
    const f = flow();
    const made = f.fillPlanets();
    expect(made).toHaveLength(7);
    f.run((ctx) => closeProject(ctx, made[0]!.id, USER));
    const out = f.propose(newProject('Game'));
    expect(out.types).toEqual(['proposal.created', 'proposal.parked']);
    expect(out.value.state).toBe('parked');
    const parking = proposalParking(out.value)!;
    expect(parking).toMatchObject({
      waitingFor: 'planet',
      offers: ['downsize_moon', 'downsize_asteroid', 'close_early'],
      reason: expect.stringMatching(/^no free planet — occupied: .*P0 \(completed\)/),
    });
    expect(parking.occupied).toHaveLength(7);
    expect(parking.occupied).toContainEqual(
      expect.objectContaining({
        occupant: 'P0',
        state: 'completed',
        host: { kind: 'project', id: made[0]!.id },
      }),
    );
    expect(out.events[1]).toEqual({
      type: 'proposal.parked',
      proposalId: out.value.id,
      ...parking,
    });
    // Approving it now cannot place it: refused, still parked.
    expect(() => f.decide(out.value, { decision: 'approve' })).toThrow(
      /no free planet.*stays parked/,
    );
    expect(f.card(out.value.id).state).toBe('parked');
    expect(f.tables.projects.all()).toHaveLength(7);
  });

  it('resumes a parked card automatically when a planet is freed (acceptance)', () => {
    const f = flow();
    const made = f.fillPlanets();
    const { value: parked } = f.propose(newProject('Game'));
    expect(parked.state).toBe('parked');
    // The user closes a completed project early and archives it: its planet frees.
    f.run((ctx) => closeProject(ctx, made[2]!.id, USER));
    const freedBody = made[2]!.bodyId;
    const archived = f.run((ctx) => archiveProject(ctx, made[2]!.id, USER));
    // The freeing transaction un-parks the card: no model involved.
    expect(archived.types).toEqual(['project.state_changed', 'body.freed', 'proposal.unparked']);
    expect(archived.events[2]).toEqual({
      type: 'proposal.unparked',
      proposalId: parked.id,
      proposedBody: { kind: 'planet', name: 'Game', bodyId: freedBody },
      reason: `${f.tables.bodies.get(freedBody)!.name} is free`,
    });
    const card = f.card(parked.id);
    expect(card.state).toBe('pending');
    expect(card.meta).not.toHaveProperty('parked');
    f.decide(card, { decision: 'approve' });
    expect(f.tables.projects.all().find((p) => p.name === 'Game')).toMatchObject({
      bodyId: freedBody,
    });
  });

  it('gives a freed planet to the oldest parked card only; the next waits for the next one', () => {
    const f = flow();
    const made = f.fillPlanets();
    const first = f.propose(newProject('First')).value;
    const second = f.propose(newProject('Second')).value;
    const free = (i: number) => {
      f.run((ctx) => closeProject(ctx, made[i]!.id, USER));
      return f.run((ctx) => archiveProject(ctx, made[i]!.id, USER));
    };
    expect(free(0).types.filter((t) => t === 'proposal.unparked')).toHaveLength(1);
    expect([f.card(first.id).state, f.card(second.id).state]).toEqual(['pending', 'parked']);
    free(1);
    expect(f.card(second.id)).toMatchObject({
      state: 'pending',
      proposedBody: { bodyId: made[1]!.bodyId },
    });
    expect(f.card(first.id).proposedBody.bodyId).toBe(made[0]!.bodyId);
  });

  it('un-parks on an explicit free, and when a pending card lets go of the planet it proposes', () => {
    const f = flow();
    const made = f.fillPlanets();
    const first = f.propose(newProject('First')).value;
    const second = f.propose(newProject('Second')).value;
    f.run((ctx) => closeProject(ctx, made[3]!.id, USER));
    // `freeBody` (the user freeing a completed project's planet early, decision 16).
    expect(f.run((ctx) => freeBody(ctx, made[3]!.bodyId)).types).toEqual([
      'body.freed',
      'proposal.unparked',
    ]);
    expect([f.card(first.id).state, f.card(second.id).state]).toEqual(['pending', 'parked']);
    // The pending card holds the planet; rejecting it hands the planet to the parked one.
    expect(f.decide(first, { decision: 'reject' }).types).toEqual([
      'proposal.rejected',
      'proposal.unparked',
    ]);
    expect(f.card(second.id)).toMatchObject({
      state: 'pending',
      proposedBody: { bodyId: made[3]!.bodyId },
    });
    // The rejected draft revised: an edit, like creation, does not look at other cards — the
    // user keeps the choice of which card gets the planet; the second approval parks.
    expect(
      f.decide(first, { decision: 'edit', changes: { workspace: '/w/first2' } }).types,
    ).toEqual(['proposal.edited']);
    f.decide(second, { decision: 'approve' });
    f.run((ctx) => closeProject(ctx, made[4]!.id, USER));
    f.run((ctx) => archiveProject(ctx, made[4]!.id, USER));
    expect(f.decide(first, { decision: 'approve' }).types).toEqual([
      'proposal.approved',
      'project.created',
      'body.assigned',
    ]);
  });

  it('parks a pending card at approval when its planet went meanwhile', () => {
    const f = flow();
    const made = f.fillPlanets();
    f.run((ctx) => closeProject(ctx, made[3]!.id, USER));
    f.run((ctx) => archiveProject(ctx, made[3]!.id, USER));
    // Creation does not look at other cards: both propose the one free planet.
    const a = f.propose(newProject('A')).value;
    const b = f.propose(newProject('B')).value;
    expect([a.state, b.state]).toEqual(['pending', 'pending']);
    f.decide(a, { decision: 'approve' });
    expect(f.decide(b, { decision: 'approve' }).types).toEqual(['proposal.parked']);
    expect(f.card(b.id).state).toBe('parked');
  });

  it('un-parks when the user edits the card: a downsized card is decided again', () => {
    const f = flow();
    f.fillPlanets();
    const { value: p } = f.propose(newProject('Game'));
    const edit = f.decide(p, {
      decision: 'edit',
      changes: { kind: 'moon', proposedBody: { kind: 'moon', name: 'Game' } },
    });
    expect(edit.types).toEqual(['proposal.edited']);
    expect(f.card(p.id).state).toBe('edited');
    expect(f.card(p.id).meta).not.toHaveProperty('parked');
    f.decide(p, { decision: 'approve' });
    const project = f.tables.projects.all().find((x) => x.name === 'Game')!;
    expect(f.tables.bodies.get(project.bodyId)?.kind).toBe('moon');
  });

  it('stays parked after an edit that still needs a planet', () => {
    const f = flow();
    f.fillPlanets();
    const { value: p } = f.propose(newProject('Game'));
    const edit = f.decide(p, { decision: 'edit', changes: { workspace: '/w/elsewhere' } });
    expect(edit.types).toEqual(['proposal.edited', 'proposal.parked']);
    expect(f.card(p.id)).toMatchObject({ state: 'parked', workspace: '/w/elsewhere' });
  });

  it('parks at approval when the body went meanwhile, and takes another free one otherwise', () => {
    const f = flow();
    const a = f.propose(
      newProject('A', { proposedBody: { kind: 'planet', name: 'A', bodyId: 'b-mars' } }),
    ).value;
    const b = f.propose(
      newProject('B', { proposedBody: { kind: 'planet', name: 'B', bodyId: 'b-mars' } }),
    ).value;
    f.decide(a, { decision: 'approve' });
    f.decide(b, { decision: 'approve' });
    const bProject = f.tables.projects.all().find((p) => p.name === 'B')!;
    expect(bProject.bodyId).not.toBe('b-mars');
    expect(f.tables.bodies.get(bProject.bodyId)?.kind).toBe('planet');
  });

  it('never un-parks a card the user parked by hand', () => {
    const f = flow();
    const made = f.fillPlanets();
    f.run((ctx) => closeProject(ctx, made[0]!.id, USER));
    f.run((ctx) => archiveProject(ctx, made[0]!.id, USER));
    const { value: p } = f.propose(newProject('Someday'));
    expect(f.decide(p, { decision: 'park', reason: 'not this month' }).events).toEqual([
      { type: 'proposal.parked', proposalId: p.id, reason: 'not this month' },
    ]);
    f.run((ctx) => closeProject(ctx, made[1]!.id, USER));
    expect(f.run((ctx) => archiveProject(ctx, made[1]!.id, USER)).types).not.toContain(
      'proposal.unparked',
    );
    expect(f.card(p.id)).toMatchObject({
      state: 'parked',
      meta: { parked: { reason: 'not this month' } },
    });
    f.decide(p, { decision: 'approve' });
    expect(f.card(p.id).meta).not.toHaveProperty('parked');
  });

  it('parks a sub-project without a free moon of its planet, offering a task on the planet', () => {
    const f = flow();
    const planet = f.run((ctx) =>
      createProject(ctx, { name: 'App', workspace: '/w/app', bodyId: 'b-mars' }, {}),
    ).value;
    for (const moon of ['b-phobos', 'b-deimos']) {
      f.run((ctx) =>
        createProject(
          ctx,
          { name: moon, workspace: `/w/${moon}`, bodyId: moon, parentProjectId: planet.id },
          {},
        ),
      );
    }
    const { value: p } = f.propose(
      newProject('Docs', {
        kind: 'moon',
        proposedBody: { kind: 'moon', name: 'Docs' },
        meta: { request: { type: 'new_project', name: 'Docs', parentProjectId: planet.id } },
      }),
    );
    expect(p.state).toBe('parked');
    expect(proposalParking(p)).toMatchObject({
      waitingFor: 'moon',
      offers: ['task_on_planet', 'close_early'],
    });
    // A free moon elsewhere does not help; Phobos freeing does.
    const sub = f.tables.projects.all().find((x) => x.bodyId === 'b-phobos')!;
    f.run((ctx) => closeProject(ctx, sub.id, USER));
    f.run((ctx) => archiveProject(ctx, sub.id, USER));
    expect(f.card(p.id)).toMatchObject({
      state: 'pending',
      proposedBody: { kind: 'moon', bodyId: 'b-phobos', parentId: 'b-mars' },
    });
    f.decide(p, { decision: 'approve' });
    expect(f.tables.projects.all().find((x) => x.name === 'Docs')).toMatchObject({
      bodyId: 'b-phobos',
      parentProjectId: planet.id,
    });
  });

  it('leaves cards without a request, asteroid frees and plan cards alone', () => {
    const f = flow();
    f.fillPlanets();
    const bare = f.propose({
      requestText: 'x',
      kind: 'planet',
      proposedBody: { kind: 'planet', name: 'X' },
      workspace: '/w/x',
      rationale: 'x',
    }).value;
    expect(bare.state).toBe('pending');
    expect(f.decide(bare, { decision: 'approve' }).types).toEqual(['proposal.approved']);
    // A freed asteroid un-parks nothing that waits for a planet.
    const waiting = f.propose(newProject('Waiting')).value;
    const t = f.run((ctx) => createTask(ctx, { description: 'quick fix' })).value;
    f.run((ctx) => closeTask(ctx, t.id, USER));
    expect(f.run((ctx) => archiveTask(ctx, t.id, USER)).types).toContain('body.freed');
    expect(f.card(waiting.id).state).toBe('parked');
    // A plan card is decided by the user and never parks or carries out anything here.
    const project = f.tables.projects.all()[0]!;
    f.tables.agents.insert({
      id: 'a-wk',
      role: 'waykeeper',
      runtime: 'fake',
      bodyId: project.bodyId,
      projectId: project.id,
      caps: { maxWallClockMs: 1000, maxToolCalls: 10 },
      createdAt: '2026-10-01T09:00:00.000Z',
      updatedAt: '2026-10-01T09:00:00.000Z',
    });
    const plan = f.run((ctx) =>
      proposePlan(ctx, {
        projectId: project.id,
        waykeeperId: 'a-wk',
        summary: 'one task',
        tasks: [{ description: 'do it' }],
      }),
    ).value;
    expect(plan.proposal.state).toBe('pending');
    expect(f.decide(plan.proposal, { decision: 'approve' }).types).toEqual([
      'proposal.approved',
      'task.state_changed',
    ]);
    expect(f.tables.projects.all()).toHaveLength(7);
  });
});
