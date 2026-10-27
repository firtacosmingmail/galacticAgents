import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { proposalLongTermOf, proposalParking, type Id } from '@galactic/protocol';
import { gitRunner } from '../../workspace/git.js';
import { workspaceMeta } from '../../workspace/workspaces.js';
import { brainHarness, type BrainHarness } from '../testing/index.js';
import { waykeeperDefinition } from '../waykeeper/index.js';
import { HARMONIZER_SYSTEM_PROMPT, harmonizerBrain } from './index.js';

/**
 * P2-09 through the P2-07 harness: the Harmonizer's side of the proposal flow. A card parked for
 * lack of a planet comes back by itself when the user frees one, and the Harmonizer is woken to
 * say so; an approved card's workspace is prepared before its Waykeeper starts, git-initialised
 * only with the consent the user gave on the card (decision 27).
 */

const USER = { type: 'user' } as const;
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' }).trim();

const lives: { h: BrainHarness; tmp: string }[] = [];
afterEach(async () => {
  for (const { h, tmp } of lives.splice(0)) {
    await h.dispose().catch(() => {});
    rmSync(tmp, { recursive: true, force: true });
  }
});

function setup() {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-flow-')));
  for (const d of ['home', 'data', 'projects']) mkdirSync(join(tmp, d));
  const root = join(tmp, 'projects');
  const h = brainHarness({
    compose: {
      workspaces: {
        projectsRoot: root,
        dataDir: join(tmp, 'data'),
        home: join(tmp, 'home'),
        git: gitRunner({ env: GIT_ENV }),
      },
    },
  });
  lives.push({ h, tmp });
  const definition = harmonizerBrain({
    projectsRoot: root,
    startWaykeeper: async ({ projectId, supervisorId }) => {
      const wk = await h.startBrain(waykeeperDefinition(), {
        runtime: 'fake',
        projectId,
        supervisorId,
      });
      return { agentId: wk.agentId };
    },
  });
  return { h, tmp, root, definition };
}

const approvedLine = /proposal (\S+) was approved/;

describe('Harmonizer and the proposal flow (P2-09)', () => {
  it('a parked card resumes by itself when a planet frees, and the Harmonizer tells the user', async () => {
    const { h, root, definition } = setup();
    const made: Id[] = [];
    for (let i = 0; i < 7; i++) {
      const { value } = await h.commands.createProject({
        name: `P${i}`,
        workspace: join(root, `p${i}`),
      });
      made.push(value.id);
    }
    const said: string[] = [];
    const hq = await h.startHarmonizer({
      definition,
      script: (s) =>
        s
          .once('a new game', async (t) => {
            const out = await t.call<{ state: string; parked?: { occupied: unknown[] } }>(
              'propose',
              {
                type: 'new_project',
                requestText: 'Start a new game project',
                name: 'Game',
                kind: 'planet',
                rationale: 'a new application',
              },
            );
            // The server parked it: no planet is free (decision 16).
            expect(out.state).toBe('parked');
            expect(out.parked?.occupied).toHaveLength(7);
            said.push('No planet is free; the card is parked.');
          })
          .once(/is pending again/, (t) => {
            said.push(t.prompt);
          })
          .once(approvedLine, async (t) => {
            const proposalId = approvedLine.exec(t.prompt)![1]!;
            const project = await t.call<{ projectId: Id }>('create_project', { proposalId });
            await t.call('spawn_waykeeper', { projectId: project.projectId });
          }),
    });

    hq.tell('Start a new game project, a new game');
    await h.settle();
    const [card] = h.log.tables.proposals.all();
    expect(card).toMatchObject({ state: 'parked' });
    expect(proposalParking(card)?.waitingFor).toBe('planet');

    // The user closes a completed project early and archives it.
    const freed = h.log.tables.projects.get(made[1]!)!.bodyId;
    await h.commands.closeProject(made[1]!, USER);
    const { events } = await h.commands.archiveProject(made[1]!, USER);
    expect(events.map((e) => e.type)).toEqual([
      'project.state_changed',
      'body.freed',
      'proposal.unparked',
    ]);
    await h.settle();
    expect(h.log.tables.proposals.get(card!.id)).toMatchObject({
      state: 'pending',
      proposedBody: { bodyId: freed },
    });
    expect(said[1]).toContain(`proposal ${card!.id} is pending again`);
    expect(said[1]).toContain(freed);

    await h.commands.decideProposal(card!.id, { decision: 'approve' }, USER);
    await h.done();
    const game = h.log.tables.projects.all().find((p) => p.name === 'Game')!;
    expect(game).toMatchObject({ bodyId: freed, meta: { proposalId: card!.id } });
    expect(
      h.log.tables.agents.all().filter((a) => a.role === 'waykeeper' && a.projectId === game.id),
    ).toHaveLength(1);
    hq.assertCalls(['propose', 'create_project', 'spawn_waykeeper']);
  });

  it('prepares the workspace before the Waykeeper starts, and git-inits a folder only with consent', async () => {
    const { h, tmp, definition } = setup();
    const folders = { agreed: join(tmp, 'agreed'), declined: join(tmp, 'declined') };
    for (const dir of Object.values(folders)) {
      mkdirSync(dir);
      writeFileSync(join(dir, 'notes.txt'), 'the user’s own files\n');
    }
    const hq = await h.startHarmonizer({
      definition,
      script: (s) =>
        s.on(approvedLine, async (t) => {
          // Both approvals may arrive in one turn (the mailbox coalesces them).
          for (const [, proposalId] of t.prompt.matchAll(/proposal (\S+) was approved/g)) {
            const project = await t.call<{ projectId: Id }>('create_project', { proposalId });
            await t.call('spawn_waykeeper', { projectId: project.projectId });
          }
        }),
    });
    const card = async (name: string, workspace: string) =>
      (
        await h.commands.createProposal({
          requestText: `build ${name}`,
          kind: 'moon',
          proposedBody: { kind: 'moon', name },
          workspace,
          rationale: 'small',
          meta: { request: { type: 'new_project', name } },
        })
      ).value.id;
    const agreed = await card('Agreed', folders.agreed);
    const declined = await card('Declined', folders.declined);
    await h.commands.decideProposal(agreed, { decision: 'edit', changes: { initGit: true } }, USER);
    await h.commands.decideProposal(agreed, { decision: 'approve' }, USER);
    await h.commands.decideProposal(declined, { decision: 'approve' }, USER);
    await h.done();

    const project = (name: string) => h.log.tables.projects.all().find((p) => p.name === name)!;
    expect(workspaceMeta(project('Agreed'))).toMatchObject({
      git: true,
      initialised: true,
      serialStewards: false,
    });
    expect(git(folders.agreed, 'log', '--format=%s')).not.toBe('');
    expect(workspaceMeta(project('Declined'))).toMatchObject({ git: false, serialStewards: true });
    expect(existsSync(join(folders.declined, '.git'))).toBe(false);
    expect(hq.calls('spawn_waykeeper')).toHaveLength(2);
    expect(hq.calls('spawn_waykeeper').every((c) => c.ok)).toBe(true);
  });
});

describe('long-term proposals (P10-06)', () => {
  const LONG_TERM = { purpose: 'Grow the app for years', goals: ['1000 users', 'break even'] };

  it('propose with longTerm → approved → a long-term project on a big planet', async () => {
    const { h, root, definition } = setup();
    let proposed: Record<string, unknown> | undefined;
    const hq = await h.startHarmonizer({
      definition,
      script: (s) =>
        s
          .once('a product', async (t) => {
            proposed = await t.call('propose', {
              type: 'new_project',
              requestText: 'Start my SaaS, a product I will run for years',
              name: 'SaaS',
              kind: 'planet',
              rationale: 'a product looked after over months',
              workspace: join(root, 'saas'),
              longTerm: LONG_TERM,
            });
          })
          .once(approvedLine, async (t) => {
            const proposalId = approvedLine.exec(t.prompt)![1]!;
            const project = await t.call<{ projectId: Id }>('create_project', { proposalId });
            await t.call('spawn_waykeeper', { projectId: project.projectId });
          }),
    });
    hq.tell('Start my SaaS, a product I will run for years');
    await h.settle();
    expect(proposed).toMatchObject({ state: 'pending', longTerm: true });
    const [card] = h.log.tables.proposals.all();
    expect(card!.proposedBody.bodyId).toBe('b-jupiter');
    expect(proposalLongTermOf(card)).toEqual(LONG_TERM);
    await h.commands.decideProposal(card!.id, { decision: 'approve' }, USER);
    await h.done();
    const saas = h.log.tables.projects.all().find((p) => p.name === 'SaaS')!;
    expect(saas).toMatchObject({ bodyId: 'b-jupiter', longTerm: true, ...LONG_TERM });
    hq.assertCalls(['propose', 'create_project', 'spawn_waykeeper']);
  });

  it('propose_long_term → approved → the project is converted and moved; the Harmonizer creates nothing', async () => {
    const { h, root, definition } = setup();
    const app = (await h.commands.createProject({ name: 'App', workspace: join(root, 'app') }))
      .value;
    expect(app.bodyId).not.toBe('b-jupiter');
    let proposed: Record<string, unknown> | undefined;
    const said: string[] = [];
    const hq = await h.startHarmonizer({
      definition,
      script: (s) =>
        s
          .once('long-term', async (t) => {
            proposed = await t.call('propose_long_term', { projectId: app.id, ...LONG_TERM });
          })
          .once(approvedLine, (t) => {
            said.push(t.prompt);
          }),
    });
    hq.tell('Make App long-term');
    await h.settle();
    expect(proposed).toMatchObject({
      state: 'pending',
      movesTo: { bodyId: 'b-jupiter', name: 'Jupiter' },
    });
    const [card] = h.log.tables.proposals.all();
    expect(card).toMatchObject({
      requestText: 'Make App long-term',
      kind: 'planet',
      proposedBody: { kind: 'planet', bodyId: 'b-jupiter' },
    });
    // A conversion card is approved or rejected as it is.
    await expect(
      h.commands.decideProposal(
        card!.id,
        { decision: 'edit', changes: { workspace: join(root, 'other') } },
        USER,
      ),
    ).rejects.toThrow(/approve or reject it as it is/);
    await h.commands.decideProposal(card!.id, { decision: 'approve' }, USER);
    await h.done();
    expect(h.log.tables.projects.get(app.id)).toMatchObject({
      bodyId: 'b-jupiter',
      longTerm: true,
      ...LONG_TERM,
    });
    expect(h.log.tables.projects.all()).toHaveLength(1);
    expect(said[0]).toContain(
      `proposal ${card!.id} was approved: project ${app.id} is now long-term`,
    );
    expect(said[0]).toContain('nothing to create or spawn');
    hq.assertCalls(['propose_long_term']);
  });

  it('refuses a conversion before any card: a sub-project, or no planet with moons to move to', async () => {
    const { h, root, definition } = setup();
    const parent = (
      await h.commands.createProject({ name: 'Parent', workspace: join(root, 'parent') })
    ).value;
    const part = (
      await h.commands.createProject({
        name: 'Part',
        workspace: join(root, 'part'),
        kind: 'moon',
        parentProjectId: parent.id,
      })
    ).value;
    for (const [name, bodyId] of [
      ['J', 'b-jupiter'],
      ['S', 'b-saturn'],
      ['U', 'b-uranus'],
      ['N', 'b-neptune'],
    ] as const) {
      await h.commands.createProject({ name, workspace: join(root, name), bodyId });
    }
    const venus = (
      await h.commands.createProject({ name: 'V', workspace: join(root, 'v'), bodyId: 'b-venus' })
    ).value;
    const outcomes: unknown[] = [];
    const hq = await h.startHarmonizer({
      definition,
      script: (s) =>
        s.once('go', async (t) => {
          outcomes.push(await t.try('propose_long_term', { projectId: part.id, ...LONG_TERM }));
          outcomes.push(await t.try('propose_long_term', { projectId: venus.id, ...LONG_TERM }));
          outcomes.push(
            await t.try('propose_long_term', { projectId: parent.id, purpose: '', goals: [] }),
          );
        }),
    });
    hq.tell('go');
    await h.done();
    expect(outcomes[0]).toMatchObject({
      ok: false,
      error: 'invalid',
      message: 'a part of Parent cannot become long-term on its own',
    });
    // Parent sits on Mars (moons): Venus has none, and Mars is taken.
    expect(outcomes[1]).toMatchObject({
      ok: false,
      error: 'conflict',
      message: 'No planet with moons is free; V stays as it is until one is.',
    });
    expect(outcomes[2]).toMatchObject({ ok: false, error: 'invalid' });
    expect(h.log.tables.proposals.all()).toHaveLength(0);
  });

  it('a long-term card is never downsized; with no planet with moons it is parked, and size_request says why', async () => {
    const { h, root, definition } = setup();
    for (const [name, bodyId] of [
      ['J', 'b-jupiter'],
      ['S', 'b-saturn'],
      ['U', 'b-uranus'],
      ['N', 'b-neptune'],
      ['M', 'b-mars'],
    ] as const) {
      await h.commands.createProject({ name, workspace: join(root, name), bodyId });
    }
    let sized: { rationale?: string; body?: { reason?: string } } | undefined;
    let proposed: { state?: string } | undefined;
    const hq = await h.startHarmonizer({
      definition,
      script: (s) =>
        s.once('go', async (t) => {
          sized = await t.call('size_request', {
            request: 'a product I will run for years',
            kind: 'planet',
            longTerm: true,
          });
          proposed = await t.call('propose', {
            type: 'new_project',
            requestText: 'a product I will run for years',
            name: 'Product',
            kind: 'planet',
            rationale: 'long-term',
            workspace: join(root, 'product'),
            longTerm: LONG_TERM,
          });
        }),
    });
    hq.tell('go');
    await h.done();
    expect(sized?.body?.reason).toBe('no_planet_with_moons');
    expect(sized?.rationale).toContain('no planet with moons is free for a long-term project');
    expect(proposed?.state).toBe('parked');
    const [card] = h.log.tables.proposals.all();
    await expect(
      h.commands.decideProposal(
        card!.id,
        { decision: 'edit', changes: { kind: 'moon', proposedBody: { kind: 'moon', name: 'P' } } },
        USER,
      ),
    ).rejects.toThrow(/lives on a planet with moons, not on a moon/);
    await expect(
      h.commands.decideProposal(
        card!.id,
        {
          decision: 'edit',
          changes: { proposedBody: { kind: 'planet', name: 'P', bodyId: 'b-mercury' } },
        },
        USER,
      ),
    ).rejects.toThrow(/Mercury has none/);
    expect(h.log.tables.proposals.get(card!.id)?.state).toBe('parked');
  });

  it('relay_to_waykeeper passes a recurring-job request to the project’s Waykeeper', async () => {
    const { h, root, definition } = setup();
    const app = (
      await h.commands.createProject({
        name: 'App',
        workspace: join(root, 'app'),
        longTerm: LONG_TERM,
      })
    ).value;
    const heard: string[] = [];
    const hq = await h.startHarmonizer({
      definition,
      script: (s) =>
        s.once('recurring', async (t) => {
          await t.call('relay_to_waykeeper', {
            projectId: app.id,
            text: 'Cosmin wants a daily job reading the app reviews.',
          });
        }),
    });
    await h.startBrain(
      waykeeperDefinition(),
      { runtime: 'fake', projectId: app.id, supervisorId: hq.agentId },
      { script: (s) => s.once(/daily job reading/, (t) => void heard.push(t.prompt)) },
    );
    hq.tell('I need a recurring job on App');
    await h.done();
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatch(
      /your supervisor agent \S+ passed on: "Cosmin wants a daily job reading the app reviews\."/i,
    );
  });
});

describe('the Harmonizer prompt (P10-06)', () => {
  it('covers long-term proposals, job relays and money', () => {
    for (const line of [
      'propose it as a planet with longTerm {purpose, goals}',
      '"Make <project> long-term"',
      'propose_long_term',
      '"I need a recurring job on <project>"',
      'relay_to_waykeeper',
      'A conversion card ("is now long-term") changes the existing project only: nothing to create or spawn',
      'You never spend real money yourself',
      'request_spend',
    ]) {
      expect(HARMONIZER_SYSTEM_PROMPT).toContain(line);
    }
  });
});
