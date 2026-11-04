import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Agent, EventEnvelope } from '@galactic/protocol';
import { AgyAdapter } from '../adapters/agy/agy-adapter.js';
import { FAKE_AGY } from '../adapters/agy/fake-agent.js';
import { HookBridge } from '../adapters/agy/hook-bridge.js';
import { openDatabase, type Database } from '../db/database.js';
import { EventLog } from '../domain/event-log.js';
import { registerAgyHookRoutes } from '../http/agy-hook-routes.js';
import { AgentRuntime } from './agent-runtime.js';
import { StatusStore } from './status-store.js';
import { ProcessSupervisor } from './supervisor.js';
import { TranscriptPipeline } from './transcripts.js';

/**
 * The agy adapter under the real `AgentRuntime` (P11-14 review I1): the runtime resumes a paused
 * agent before it interrupts it, so an `ask_user` answer queued while paused must survive the
 * interrupt that follows the resume and reach the Steward before the user's new message.
 */

const USER = { type: 'user' } as const;
const ANSWERED = 'The user answered your question ("Which option do you prefer?"): first option';

interface Rig {
  db: Database;
  log: EventLog;
  runtime: AgentRuntime;
  statuses: StatusStore;
  transcripts: TranscriptPipeline;
  adapter: AgyAdapter;
  supervisor: ProcessSupervisor;
  app: FastifyInstance;
  events: EventEnvelope[];
  cwd: string;
}

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.runtime.dispose();
    await r.adapter.dispose();
    await r.supervisor.dispose();
    await r.app.close();
    r.statuses.dispose();
    r.transcripts.dispose();
    r.db.close();
  }
});

async function make(): Promise<Rig> {
  const db = openDatabase(':memory:');
  const log = new EventLog(db);
  const events: EventEnvelope[] = [];
  log.subscribe((e) => events.push(e));
  const statuses = new StatusStore({
    capsOf: (id) => log.tables.agents.get(id)?.caps,
    defaultCaps: { maxWallClockMs: 60_000, maxToolCalls: 100 },
    stallThresholdMs: () => 30_000,
    flushMs: 10,
  });
  log.subscribe((e) => statuses.fold(e));
  const transcripts = new TranscriptPipeline(db, { flushMs: 10 });
  const home = mkdtempSync(join(tmpdir(), 'galactic-agy-rt-home-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'galactic-agy-rt-state-'));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-agy-rt-cwd-')));
  writeFileSync(join(cwd, 'README.md'), '# unit\n');
  const bridge = new HookBridge();
  const app = Fastify();
  registerAgyHookRoutes(app, { bridge });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/agy-hook`;
  const supervisor = new ProcessSupervisor({ defaults: { graceMs: 2_000, termMs: 1_000 } });
  const adapter = new AgyAdapter({
    supervisor,
    command: process.execPath,
    args: [FAKE_AGY],
    hookUrl: () => url,
    bridge,
    home,
    stateDir,
    graceMs: 2_000,
    startTimeoutMs: 10_000,
    askHoldMs: 200,
  });
  const runtime = new AgentRuntime({
    log,
    adapters: [adapter],
    transcripts,
    statuses,
    caps: {
      maxConcurrentAgents: 4,
      defaults: { maxWallClockMs: 60_000, maxToolCalls: 100 },
    },
  });
  const r = { db, log, runtime, statuses, transcripts, adapter, supervisor, app, events, cwd };
  rigs.push(r);
  return r;
}

const waitFor = (pred: () => boolean, what: string, ms = 8_000) =>
  new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (pred()) resolve();
      else if (Date.now() - t0 > ms) reject(new Error(`timed out waiting for ${what}`));
      else setTimeout(tick, 10);
    };
    tick();
  });

const said = (r: Rig, agentId: string) => {
  r.transcripts.flush();
  return r.transcripts
    .read(agentId)
    .map((c) => c.text)
    .join('\n');
};

/** A Steward whose `ask_user` was deferred (its agy run ended), then paused and answered. */
async function pausedWithAnswer(r: Rig): Promise<Agent> {
  const result = await r.runtime.spawn({
    role: 'steward',
    runtime: 'agy',
    prompt: 'scenario:asks',
    cwd: r.cwd,
  });
  if (!result.ok) throw new Error(result.reason);
  const agent = result.agent;
  await waitFor(() => said(r, agent.id).includes('has not answered yet'), 'deferred note');
  await new Promise((res) => setTimeout(res, 300)); // the agy run has ended: no process
  const asked = r.events.find(
    (e) => e.event.type === 'agent.needs_input' && e.event.agentId === agent.id,
  )!.event as Extract<EventEnvelope['event'], { type: 'agent.needs_input' }>;
  await r.runtime.pause(agent.id, USER);
  await r.runtime.answer(asked.questionId, 'first option', USER);
  await new Promise((res) => setTimeout(res, 50));
  return agent;
}

function expectAnswerThenMessage(text: string): void {
  const answer = text.indexOf(ANSWERED);
  const message = text.indexOf('carry on');
  expect(answer).toBeGreaterThanOrEqual(0);
  expect(message).toBeGreaterThan(answer);
}

describe('agy under the AgentRuntime (P11-14)', () => {
  it('an interrupt message sent while paused: the answer, then the message, reach the Steward', async () => {
    const r = await make();
    const agent = await pausedWithAnswer(r);
    r.runtime.send(agent.id, 'carry on', { sender: USER, interrupt: true });
    await r.runtime.resumeAgent(agent.id, USER);
    await waitFor(() => said(r, agent.id).includes('carry on'), 'the message delivered');
    await waitFor(() => r.statuses.get(agent.id)?.state === 'idle', 'idle');
    expectAnswerThenMessage(said(r, agent.id));
  });

  it('runtime.interrupt on the paused Steward, then a message: the answer is not lost', async () => {
    const r = await make();
    const agent = await pausedWithAnswer(r);
    await r.runtime.interrupt(agent.id);
    await waitFor(() => r.statuses.get(agent.id)?.state === 'idle', 'idle after the interrupt');
    r.runtime.send(agent.id, 'carry on', { sender: USER });
    await waitFor(() => said(r, agent.id).includes('carry on'), 'the message delivered');
    expectAnswerThenMessage(said(r, agent.id));
  });
});
