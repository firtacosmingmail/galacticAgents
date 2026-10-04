import { afterEach, describe, expect, it } from 'vitest';
import type { Event, Id } from '@galactic/protocol';
import { brainHarness, type BrainHarness } from '../testing/index.js';
import { startHarmonizer } from './index.js';
import { harmonizerRestarter } from './restart.js';

/**
 * "Restart Harmonizer" (P5-06; SPEC decision 82): the running Harmonizer is stopped as the user's
 * stop and a fresh one starts on the same runtime; one live Harmonizer; its questions follow
 * decision 45; the new one's first turn says the user restarted it.
 */

const USER = { type: 'user' } as const;
const LONG = { timeoutMs: 4_000 };
const lives: BrainHarness[] = [];
afterEach(async () => {
  for (const h of lives.splice(0)) await h.dispose().catch(() => {});
});

const OPTS = { cwd: '/w/hq', deps: { projectsRoot: '/w/projects' } };

function setup() {
  const h = brainHarness();
  lives.push(h);
  h.script('harmonizer', { strict: false })
    .once('ask me', (t) => t.call('ask_user', { text: 'Which name for the CLI?' }))
    .once('close check', async (t) => {
      const project = h.log.tables.projects.all()[0]!;
      await t.call('ask_closure', { projectId: project.id, summary: 'Shipped.' });
    });
  const start = () => startHarmonizer(h.composed, { runtime: 'fake', ...OPTS });
  const restart = harmonizerRestarter(h.composed, OPTS);
  const liveHq = () => h.runtime.liveAgents().filter((a) => a.role === 'harmonizer');
  const events = (): Event[] =>
    h.log.eventsSince(0, Number.MAX_SAFE_INTEGER).map(({ event }) => event);
  const idle = (id: Id) => h.composed.runnerOf(id)?.state === 'idle';
  return { h, start, restart, liveHq, events, idle };
}

describe('restarting the Harmonizer (P5-06, decision 82)', () => {
  it('stops the running one as the user and starts one fresh one on the same runtime', async () => {
    const { h, start, restart, liveHq, events, idle } = setup();
    const first = await start();
    // Armed as at boot: a user's stop is not a reason to start another one (decision 44).
    h.composed.keepHarmonizer(start);
    await h.until(() => idle(first.agentId), { ...LONG, what: 'the first Harmonizer idle' });

    const result = await restart();
    expect(result.replaced).toBe(first.agentId);
    expect(result.agentId).not.toBe(first.agentId);
    expect(liveHq().map((a) => a.id)).toEqual([result.agentId]);
    expect(liveHq()[0]!.runtime).toBe('fake');
    expect(
      events().some(
        (e) =>
          e.type === 'control.stop' &&
          e.target.kind === 'agent' &&
          e.target.id === first.agentId &&
          e.by.type === 'user',
      ),
    ).toBe(true);
    expect(h.statuses.get(first.agentId)?.state).toBe('stopped');

    // The new one's first turn says the user restarted it, seeded from the database.
    const prompt = h.transcript(result.agentId)!.prompts()[0]!;
    expect(prompt).toContain('the user restarted the Harmonizer from the panel');
    expect(prompt).toContain(`the previous one (${first.agentId}) was stopped`);
    expect(prompt).toContain('Tell the user in one line that the Harmonizer was restarted');

    await new Promise((r) => setTimeout(r, 50));
    expect(liveHq().map((a) => a.id)).toEqual([result.agentId]);
    expect(h.errors).toEqual([]);
  });

  it('withdraws the old one’s user questions and tells the new one; closure is relayed again', async () => {
    const { h, start, restart, idle } = setup();
    const project = (await h.commands.createProject({ name: 'CSV', workspace: '/w/csv' })).value;
    const first = await start();
    await h.until(() => idle(first.agentId), { ...LONG, what: 'idle' });
    h.tell(first.agentId, 'ask me');
    await h.until(() => h.log.tables.questions.all().length === 1, { ...LONG, what: 'ask_user' });
    await h.until(() => idle(first.agentId), { ...LONG, what: 'idle after ask_user' });
    h.tell(first.agentId, 'close check');
    await h.until(() => h.log.tables.questions.all().length === 2, { ...LONG, what: 'closure' });
    const [asked, closure] = h.log.tables.questions.all();
    expect(asked!.status).toBe('open');
    expect(closure!.status).toBe('open');

    const result = await restart();
    expect(h.log.tables.questions.get(asked!.id)).toMatchObject({ status: 'cancelled' });
    expect(h.log.tables.questions.get(closure!.id)?.status).not.toBe('open');
    const prompt = h.transcript(result.agentId)!.prompts()[0]!;
    expect(prompt).toContain('"Which name for the CLI?"');
    expect(prompt).toContain('ask again');
    expect(prompt).toContain(`project ${project.id} ("CSV") asked for closure`);
    // Told once: the line is not repeated by the stranded-question notes.
    expect(prompt.split('Which name for the CLI?').length - 1).toBe(1);
  });

  it('refuses a second restart while one is under way', async () => {
    const { start, restart, liveHq } = setup();
    await start();
    const [a, b] = await Promise.allSettled([restart(), restart()]);
    expect(a.status).toBe('fulfilled');
    expect(b).toMatchObject({ status: 'rejected', reason: { code: 'conflict' } });
    expect(liveHq()).toHaveLength(1);
  });

  it('starts one when none runs: on the last one’s runtime, else the default, else refuses', async () => {
    const { h, liveHq } = setup();
    await expect(harmonizerRestarter(h.composed, OPTS)()).rejects.toMatchObject({
      code: 'invalid',
    });
    const fresh = await harmonizerRestarter(h.composed, { ...OPTS, defaultRuntime: 'fake' })();
    expect(fresh.replaced).toBeUndefined();
    expect(liveHq().map((a) => a.id)).toEqual([fresh.agentId]);
    // Stopped by the user (the ops console): the restart brings one back on its runtime.
    await h.commands.stopAgent(fresh.agentId, USER);
    expect(liveHq()).toEqual([]);
    const again = await harmonizerRestarter(h.composed, OPTS)();
    expect(liveHq().map((a) => a.id)).toEqual([again.agentId]);
    expect(h.errors).toEqual([]);
  });
});
