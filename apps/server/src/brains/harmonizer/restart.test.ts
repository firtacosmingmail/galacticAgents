import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Event, Id } from '@galactic/protocol';
import { openDatabase } from '../../db/database.js';
import { brainHarness, type BrainHarness } from '../testing/index.js';
import { waykeeperDefinition } from '../waykeeper/index.js';
import { startHarmonizer } from './index.js';
import { harmonizerRestarter, RestartLimitError } from './restart.js';

/**
 * "Restart Harmonizer" (P5-06; SPEC decision 82): the running Harmonizer is stopped as the user's
 * stop and a fresh one starts on the same runtime; one live Harmonizer; its questions follow
 * decision 45; the new one's first turn says the user restarted it.
 */

const USER = { type: 'user' } as const;
const LONG = { timeoutMs: 4_000 };
const lives: BrainHarness[] = [];
afterEach(async () => {
  // The newest life first: an older one's dispose must not write into a live one's database.
  for (const h of lives.splice(0).reverse()) await h.dispose().catch(() => {});
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

  it('allows 3 restarts in 10 minutes, then says when to try again; none uses the spawn window', async () => {
    const { h, start, liveHq } = setup();
    await start();
    let clock = Date.parse('2026-10-04T10:00:00Z');
    const restart = harmonizerRestarter(h.composed, { ...OPTS, now: () => clock });
    for (let i = 0; i < 3; i++) {
      await restart();
      clock += 60_000;
    }
    const refused = await restart().catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(RestartLimitError);
    expect(refused).toMatchObject({ code: 'conflict', retryAfterMs: 7 * 60_000 });
    expect((refused as Error).message).toMatch(/restarted 3 times .* try again in 7 min/);
    expect(liveHq()).toHaveLength(1);
    // Decision 43: the Harmonizer's spawns (the first and three restarts) are not counted in the
    // per-hour spawn window Stewards and Waykeepers need.
    expect(h.runtime.caps.spawnsInLastHour()).toBe(0);
    clock += 7 * 60_000;
    await expect(restart()).resolves.toMatchObject({ agentId: expect.any(String) });
    expect(liveHq()).toHaveLength(1);
  });

  it('a failed start after the stop falls back once to the boot runtime, logged', async () => {
    const { h, start, liveHq } = setup();
    const first = await start();
    let failures = 1;
    const host = {
      ...h.composed,
      startBrain: (...args: Parameters<typeof h.composed.startBrain>) =>
        failures-- > 0
          ? Promise.reject(new Error('spawn exploded'))
          : h.composed.startBrain(...args),
    };
    const errors: string[] = [];
    const restart = harmonizerRestarter(host, {
      ...OPTS,
      defaultRuntime: 'fake',
      onError: (e, context) => errors.push(`${context}: ${(e as Error).message}`),
    });
    const result = await restart();
    expect(errors).toEqual([expect.stringMatching(/falling back .*spawn exploded/)]);
    expect(result.replaced).toBe(first.agentId);
    expect(liveHq().map((a) => a.id)).toEqual([result.agentId]);
    expect(h.transcript(result.agentId)!.prompts()[0]).toContain('the start on fake failed');

    // Both fail: the error is the caller's (the route's 500), not a refusal.
    failures = 2;
    await expect(restart()).rejects.toThrow('spawn exploded');
    expect(liveHq()).toEqual([]);
  });

  it('a failed stop leaves the running one running and driven; nothing withdrawn, none started', async () => {
    const { h, start, restart, liveHq, idle } = setup();
    const first = await start();
    await h.until(() => idle(first.agentId), { ...LONG, what: 'idle' });
    h.tell(first.agentId, 'ask me');
    await h.until(() => h.log.tables.questions.all().length === 1, { ...LONG, what: 'ask_user' });
    await h.until(() => idle(first.agentId), { ...LONG, what: 'idle after ask_user' });
    const stop = vi.spyOn(h.runtime, 'stop').mockRejectedValueOnce(new Error('stop exploded'));
    await expect(restart()).rejects.toThrow('stop exploded');
    stop.mockRestore();
    expect(liveHq().map((a) => a.id)).toEqual([first.agentId]);
    expect(h.log.tables.questions.all()[0]!.status).toBe('open');
    // Still driven by its runner: a message wakes it for a turn.
    const turns = h.transcript(first.agentId)!.prompts().length;
    h.tell(first.agentId, 'still there?');
    await h.until(() => h.transcript(first.agentId)!.prompts().length > turns, {
      ...LONG,
      what: 'a turn after the failed restart',
    });
  });

  it('refuses while an interrupted Harmonizer is on its way back', async () => {
    const { h, start, restart, liveHq } = setup();
    const first = await start();
    const reserved = vi
      .spyOn(h.runtime, 'isReserved')
      .mockImplementation((id) => id === first.agentId);
    await expect(restart()).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringMatching(/being resumed/),
    });
    reserved.mockRestore();
    expect(liveHq().map((a) => a.id)).toEqual([first.agentId]);
  });

  it('one start at a time: concurrent starts find the one the first started', async () => {
    const { start, liveHq } = setup();
    const [a, b] = await Promise.all([start(), start()]);
    expect(a.status).toBe('started');
    expect(b).toMatchObject({ status: 'running', agentId: a.agentId });
    expect(liveHq()).toHaveLength(1);
  });

  it('after an interruption: the new one starts and the questions the old one held go to the user', async () => {
    const db = openDatabase(':memory:');
    const h1 = brainHarness({ db, failOnErrors: false });
    lives.push(h1);
    const hq = await startHarmonizer(h1.composed, { runtime: 'fake', ...OPTS });
    const project = (await h1.commands.createProject({ name: 'P', workspace: '/w/p' })).value;
    const wk = await h1.startBrain(waykeeperDefinition(), {
      runtime: 'fake',
      projectId: project.id,
      supervisorId: hq.agentId,
    });
    // A Waykeeper's question through a tool: held by its supervisor, the Harmonizer.
    const { value: q } = await h1.commands.openQuestion({
      kind: 'clarification',
      originAgentId: wk.agentId,
      context: { text: 'Postgres or SQLite?' },
    });
    expect(q.holder).toEqual({ type: 'agent', id: hq.agentId });
    await h1.settle(LONG);
    await h1.composed.shutdown(); // the Harmonizer is interrupted and keeps what it holds

    const h2 = brainHarness({ db, failOnErrors: false });
    lives.push(h2);
    h2.script('harmonizer', { strict: false });
    expect(h2.statuses.get(hq.agentId)?.state).toBe('interrupted');
    expect(h2.log.tables.questions.get(q.id)?.holder).toEqual({ type: 'agent', id: hq.agentId });

    const result = await harmonizerRestarter(h2.composed, OPTS)();
    expect(result.replaced).toBeUndefined();
    const live = h2.runtime.liveAgents().filter((a) => a.role === 'harmonizer');
    expect(live.map((a) => a.id)).toEqual([result.agentId]);
    expect(h2.transcript(result.agentId)!.prompts()[0]).toContain(
      `the previous one (${hq.agentId}) had ended`,
    );
    // Decision 45: not stranded on a holder that is not coming back.
    expect(h2.log.tables.questions.get(q.id)).toMatchObject({
      status: 'open',
      holder: { type: 'user' },
    });
    // It is not reopened beside the new one.
    expect((await h2.runtime.recoverAgent(hq.agentId)).ok).toBe(false);
  });
});
