import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { proposalParking, type Id } from '@galactic/protocol';
import { gitRunner } from '../../workspace/git.js';
import { workspaceMeta } from '../../workspace/workspaces.js';
import { brainHarness, type BrainHarness } from '../testing/index.js';
import { waykeeperDefinition } from '../waykeeper/index.js';
import { harmonizerBrain } from './index.js';

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
