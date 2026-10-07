import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Event, Id } from '@galactic/protocol';
import type { FakeScenario } from '../../adapters/fake/scenario.js';
import type { BrainHarness, BrainScript, HarnessBrain } from '../../brains/testing/index.js';
import { waykeeperDefinition } from '../../brains/waykeeper/index.js';
import { openDatabase, type Database } from '../../db/database.js';
import { logDrift } from './drill-checks.js';
import { bootDrill, drillDirs, spawnStewards } from './drill-world.js';

/**
 * P8-04 drill 3: the network goes away during a Steward run. The Mac's network cannot be unplugged
 * from a test, so the loss is simulated at the adapter boundary — the fake adapter plays what the
 * Claude adapter shows when the Anthropic API is unreachable (`claude-sdk-adapter.ts`):
 *
 * - **stall**: the CLI retries the API with backoff and prints nothing: the agent falls silent;
 * - **error turn**: the retries run out and the turn ends with an error result: the adapter
 *   prints "turn ended with an error: API Error: Connection error." and the agent goes idle;
 * - **crash**: the CLI exits with the error: `agent.failed(reason: runtime)`;
 * - **a stall past the wall-clock cap**: the cap stops it, `failed(reason: cap)`.
 *
 * Each checks the state the user and the supervisor see, and that the work recovers when the
 * network is back (the supervisor's next step, as a scripted model takes it).
 */

const LONG = { timeoutMs: 10_000 };
/** What the Claude adapter prints when an API error ends the turn. */
const CONNECTION_ERROR = 'turn ended with an error: API Error: Connection error.';

const SCENARIOS: Record<string, FakeScenario> = {
  // Silent for longer than the stall threshold (the API retries), then the network is back.
  'net-stall': {
    steps: [
      { kind: 'output', text: 'Fetching the dependencies.' },
      { kind: 'silence', ms: 700 },
      { kind: 'output', text: 'Connection restored; dependencies fetched.' },
      { kind: 'finish', result: 'Done: dependencies updated.' },
    ],
  },
  // The retries run out: the turn ends with an error and the Steward goes idle; told to go on
  // once the network is back, it finishes.
  'net-error': {
    steps: [
      { kind: 'output', text: 'Calling the API.' },
      { kind: 'output', text: CONNECTION_ERROR },
      { kind: 'idle' },
    ],
    onMessage: () => [
      { kind: 'output', text: 'Picking up where I left off.' },
      { kind: 'finish', result: 'Done: the release notes are written.' },
    ],
  },
  // The CLI exits on the error.
  'net-crash': {
    steps: [
      { kind: 'output', text: 'Calling the API.' },
      {
        kind: 'fail',
        error: 'API Error: Connection error. (the claude CLI exited with code 1)',
        reason: 'runtime',
      },
    ],
  },
  // A replacement Steward once the network is back.
  'net-ok': {
    steps: [
      { kind: 'output', text: 'Network is fine.' },
      { kind: 'finish', result: 'Done: retried the upload.' },
    ],
  },
  // Silent for longer than its wall-clock cap.
  'net-hang': {
    steps: [
      { kind: 'output', text: 'Downloading the model.' },
      { kind: 'silence', ms: 60_000 },
      { kind: 'finish', result: 'never' },
    ],
  },
};

const dirs: string[] = [];
const dbs: Database[] = [];
const lives: BrainHarness[] = [];
afterEach(async () => {
  for (const h of lives.splice(0)) await h.dispose().catch(() => {});
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface World {
  h: BrainHarness;
  wk: HarnessBrain;
  projectId: Id;
}

/** A Harmonizer and a project's Waykeeper whose script also does what `script` adds. */
async function world(script: (s: BrainScript) => void = () => {}): Promise<World> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-net-')));
  dirs.push(root);
  const d = drillDirs(root);
  const db = openDatabase(':memory:');
  dbs.push(db);
  const h = bootDrill(d, db, {
    scenarios: SCENARIOS,
    // The fake runtime's 5 s threshold, scaled down for the test.
    compose: { stallThresholdMs: () => 300, tickMs: 25 },
  });
  lives.push(h);
  const hq = await h.startHarmonizer({ cwd: d.projects });
  const project = (await h.commands.createProject({ name: 'Net', workspace: join(d.home, 'Net') }))
    .value;
  await h.composed.workspaces!.prepareProject(project.id);
  const wk = await h.startBrain(
    waykeeperDefinition(),
    { runtime: 'fake', projectId: project.id, supervisorId: hq.agentId },
    {
      scriptOptions: { strict: false },
      script: (s) => {
        s.on(/was added to your project/, spawnStewards);
        script(s);
      },
    },
  );
  return { h, wk, projectId: project.id };
}

async function stewardFor(w: World, description: string): Promise<{ taskId: Id; stewardId: Id }> {
  const task = (await w.h.commands.createTask({ description, projectId: w.projectId })).value;
  let stewardId: Id | undefined;
  await w.h.until(
    () =>
      (stewardId = w.h.log.tables.agents
        .all()
        .find((a) => a.role === 'steward' && a.taskId === task.id)?.id) !== undefined,
    { ...LONG, what: `the Steward of "${description}"` },
  );
  return { taskId: task.id, stewardId: stewardId! };
}

const eventsOf = (h: BrainHarness, agentId: Id, type: Event['type']) =>
  h.log
    .eventsSince(0, Number.MAX_SAFE_INTEGER)
    .map(({ event }) => event)
    .filter((e) => e.type === type && 'agentId' in e && e.agentId === agentId);

describe('network loss during a Steward run (P8-04 drill 3)', () => {
  it('a silent Steward shows stalled, its supervisor is told, and it carries on when the network is back', async () => {
    const w = await world();
    const { stewardId } = await stewardFor(w, 'net-stall update the dependencies');
    await w.h.until(() => w.h.statuses.get(stewardId)?.state === 'stalled', {
      ...LONG,
      what: 'the Steward to be stalled',
    });
    // A real state and event (corner case 2): the log has it, so the supervisor is told.
    expect(eventsOf(w.h, stewardId, 'agent.stalled')).toHaveLength(1);
    await w.h.until(() => w.wk.prompts().some((p) => p.includes(`${stewardId} has been silent`)), {
      ...LONG,
      what: 'the Waykeeper to hear of the stall',
    });
    // The network is back: output again, then the result.
    await w.h.until(() => w.h.statuses.get(stewardId)?.state === 'finished', {
      ...LONG,
      what: 'the Steward to finish',
    });
    expect(eventsOf(w.h, stewardId, 'agent.failed')).toEqual([]);
    expect(logDrift(w.h.log)).toEqual([]);
  });

  it('an error turn reaches the supervisor as the report, and one message resumes the work', async () => {
    // The Steward's id, known once it is spawned (the script answers its report).
    const ids: { steward?: Id } = {};
    const w = await world((s) =>
      s.once(/Connection error/, (t) =>
        t.call('tell_steward', { agentId: ids.steward, text: 'The network is back: carry on.' }),
      ),
    );
    const { stewardId } = await stewardFor(w, 'net-error write the release notes');
    ids.steward = stewardId;
    await w.h.until(() => w.h.statuses.get(stewardId)?.state === 'finished', {
      ...LONG,
      what: 'the Steward to finish after the message',
    });
    expect(w.wk.calls('tell_steward')).toMatchObject([{ ok: true }]);
    const report = w.wk.prompts().find((p) => p.includes('Connection error'))!;
    expect(report).toContain(stewardId);
    // One Steward did the whole task.
    expect(w.h.log.tables.agents.all().filter((a) => a.role === 'steward')).toHaveLength(1);
    expect(logDrift(w.h.log)).toEqual([]);
  });

  it('a CLI that exits on the error fails the Steward; the supervisor starts one replacement', async () => {
    const ids: { task?: Id } = {};
    const w = await world((s) =>
      s.once(/failed \(runtime\): .*Connection error/, (t) =>
        t.call('spawn_steward', {
          taskId: ids.task,
          instructions: 'scenario:net-ok\nRetry the upload.',
        }),
      ),
    );
    const first = await stewardFor(w, 'net-crash upload the build');
    ids.task = first.taskId;
    const taskId = first.taskId;
    await w.h.until(
      () =>
        w.h.log.tables.agents.all().filter((a) => a.role === 'steward' && a.taskId === taskId)
          .length === 2,
      { ...LONG, what: 'the replacement Steward' },
    );
    const second = w.h.log.tables.agents
      .all()
      .find((a) => a.role === 'steward' && a.taskId === taskId && a.id !== first.stewardId)!;
    await w.h.until(() => w.h.statuses.get(second.id)?.state === 'finished', {
      ...LONG,
      what: 'the replacement to finish',
    });
    expect(w.h.statuses.get(first.stewardId)?.state).toBe('failed');
    expect(eventsOf(w.h, first.stewardId, 'agent.failed')).toMatchObject([{ reason: 'runtime' }]);
    expect(w.wk.calls('spawn_steward')).toHaveLength(2);
    expect(logDrift(w.h.log)).toEqual([]);
  });

  it('a stall past the wall-clock cap is stopped by the cap, and the supervisor is told why', async () => {
    const w = await world();
    // A short wall clock for the agents started from now on. It stops the Steward; the brains
    // would outlive it anyway (P8-10, SPEC decision 103).
    w.h.runtime.caps.update({ defaults: { maxWallClockMs: 1_200, maxToolCalls: 100 } });
    const { stewardId } = await stewardFor(w, 'net-hang download the model');
    await w.h.until(() => w.h.statuses.get(stewardId)?.state === 'failed', {
      ...LONG,
      what: 'the cap to stop the silent Steward',
    });
    expect(eventsOf(w.h, stewardId, 'agent.failed')).toMatchObject([{ reason: 'cap' }]);
    await w.h.until(() => w.wk.prompts().some((p) => p.includes(`${stewardId} failed (cap)`)), {
      ...LONG,
      what: 'the Waykeeper to hear of the cap',
    });
    expect(logDrift(w.h.log)).toEqual([]);
  });
});
