import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Actor, Id } from '@galactic/protocol';
import { SCENARIOS, type FakeScenario, type FakeStep } from '../../adapters/fake/scenario.js';
import type { Database } from '../../db/database.js';
import { harmonizerBrain } from '../../brains/harmonizer/index.js';
import {
  brainHarness,
  type BrainHarness,
  type HarnessBrain,
  type TurnContext,
} from '../../brains/testing/index.js';
import { waykeeperDefinition } from '../../brains/waykeeper/index.js';
import type { ComposeOptions } from '../../runtime/compose.js';
import type { GroupSource } from '../../runtime/steward-processes.js';
import { gitRunner } from '../../workspace/git.js';

/**
 * The crash drills' world (P8-04): one running hierarchy on the fake adapter and the scripted
 * fake LLM, in a temporary data directory — never the user's `~/.galactic`, never real Claude.
 * The first life is built here, by the drill server child (`drill-server.ts`) that the drills
 * then kill, and by in-process drills; the second life (recovery) is booted over the same
 * SQLite file by the drills themselves.
 */

export const USER: Actor = { type: 'user' };

/** Git never reads the user's configuration in a drill. */
export const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

export interface DrillDirs {
  root: string;
  db: string;
  home: string;
  data: string;
  projects: string;
}

/** The drill's directories under `root` (created): the database, the projects, the data dir. */
export function drillDirs(root: string): DrillDirs {
  const dirs = {
    root,
    db: join(root, 'data', 'galactic.sqlite'),
    home: join(root, 'home'),
    data: join(root, 'data'),
    projects: join(root, 'projects'),
  };
  for (const d of [dirs.home, dirs.data, dirs.projects]) mkdirSync(d, { recursive: true });
  return dirs;
}

/** A Steward that works for minutes: mid-work whenever the drill kills the server. */
const longRun: FakeStep[] = [
  { kind: 'progress', summary: 'Indexing the notes', progress: { done: 0, total: 3 } },
  ...Array.from({ length: 2_400 }, (_, i): FakeStep => ({
    kind: 'output',
    text: `indexed file ${i}`,
    delayMs: 100,
  })),
  { kind: 'finish', result: 'Done: indexed everything.' },
];

export const DRILL_SCENARIOS: Record<string, FakeScenario> = {
  ...SCENARIOS,
  'long-run': { steps: longRun },
};

export interface BootOptions {
  /** The supervisor, for Steward process attribution and sweeps (decision 76). */
  groups?: GroupSource;
  /** Extra composition options (stall threshold, caps …). */
  compose?: Omit<ComposeOptions, 'adapters' | 'onError' | 'workspaces' | 'processes'>;
  /** The fake adapter's speed (default 1: the long-run Steward takes real time). */
  speed?: number;
  /** Scenarios on top of `DRILL_SCENARIOS`. */
  scenarios?: Record<string, FakeScenario>;
}

/** A composed runtime over the drill's database: real worktrees, the fake adapter, scripted brains. */
export function bootDrill(dirs: DrillDirs, db: Database, opts: BootOptions = {}): BrainHarness {
  const h = brainHarness({
    db,
    adapter: { scenarios: { ...DRILL_SCENARIOS, ...opts.scenarios }, speed: opts.speed ?? 1 },
    compose: {
      ...(opts.compose ?? {}),
      workspaces: {
        projectsRoot: dirs.projects,
        dataDir: dirs.data,
        home: dirs.home,
        git: gitRunner({ env: GIT_ENV }),
      },
      ...(opts.groups ? { processes: { groups: opts.groups } } : {}),
    },
    // Recovery reports what it could not resume through `onError`; the drills assert on states.
    failOnErrors: false,
  });
  // What `index.ts` registers before `recover()`: brains come back as brains (P2-16).
  h.composed.defineBrains({
    harmonizer: () => harmonizerBrain({ projectsRoot: dirs.projects }),
    waykeeper: () => waykeeperDefinition(),
  });
  return h;
}

/** What the first life left running, by id: what the drills check after the restart. */
export interface FirstLife {
  hq: Id;
  /** The Notes project: its Waykeeper runs two Stewards. */
  notes: Id;
  w1: Id;
  /** Mid-work (the long-run scenario) at the kill. */
  s1: Id;
  s1Task: Id;
  s1Worktree: string;
  /** Waiting for its clarification, held by `w1`, at the kill. */
  s2: Id;
  s2Task: Id;
  s2Worktree: string;
  s2Question: Id;
  /** The Harmonizer's open question to the user. */
  hqQuestion: Id;
  /** A card waiting for the user. */
  card: Id;
  /** The Docs project: its Waykeeper is mid-turn, planning, at the kill. */
  docs: Id;
  w2: Id;
  agents: number;
}

const hqDefinition = (dirs: DrillDirs) => harmonizerBrain({ projectsRoot: dirs.projects });

/**
 * Life 1: the Harmonizer (one `ask_user` question open), the Notes project with its Waykeeper and
 * two Stewards (one working, one asking), a card waiting for the user, and the Docs project whose
 * Waykeeper is in the middle of its planning turn. Never settles (the planning turn hangs): the
 * drill kills it.
 */
export async function firstLife(h: BrainHarness, dirs: DrillDirs): Promise<FirstLife> {
  const LONG = { timeoutMs: 15_000 };
  const hq = await h.startHarmonizer({
    definition: hqDefinition(dirs),
    cwd: dirs.projects,
    scriptOptions: { strict: false },
    script: (s) => s.once('ask me', (t) => t.call('ask_user', { text: 'Which licence?' })),
  });
  const notes = (
    await h.commands.createProject({ name: 'Notes', workspace: join(dirs.home, 'Notes') })
  ).value;
  await h.composed.workspaces!.prepareProject(notes.id);
  const w1 = await h.startBrain(
    waykeeperDefinition(),
    { runtime: 'fake', projectId: notes.id, supervisorId: hq.agentId },
    {
      scriptOptions: { strict: false },
      script: (s) => s.on(/was added to your project/, spawnStewards),
    },
  );
  const s1Task = (
    await h.commands.createTask({ description: 'long-run the indexer', projectId: notes.id })
  ).value;
  const s2Task = (
    await h.commands.createTask({ description: 'asks about the format', projectId: notes.id })
  ).value;
  const stewardOf = (taskId: Id) =>
    h.log.tables.agents.all().find((a) => a.role === 'steward' && a.taskId === taskId);
  await h.until(
    () =>
      h.statuses.get(stewardOf(s1Task.id)?.id ?? '')?.state === 'working' &&
      h.statuses.get(stewardOf(s2Task.id)?.id ?? '')?.state === 'waiting_for_input',
    { ...LONG, what: 'one Steward working, one asking' },
  );
  hq.tell('ask me');
  await h.until(() => openQuestionsOf(h, hq.agentId).length === 1, {
    ...LONG,
    what: "the Harmonizer's question",
  });
  const card = (
    await h.commands.createProposal({
      requestText: 'rename the logs',
      kind: 'asteroid',
      proposedBody: { kind: 'asteroid', name: 'Rename logs' },
      workspace: join(dirs.projects, 'scratch', 'rename-logs'),
      rationale: 'small',
      meta: { request: { type: 'standalone_task', name: 'Rename logs', description: 'rename' } },
    })
  ).value;
  const docs = (
    await h.commands.createProject({ name: 'Docs', workspace: join(dirs.home, 'Docs') })
  ).value;
  await h.composed.workspaces!.prepareProject(docs.id);
  const w2 = await h.startBrain(
    waykeeperDefinition(),
    { runtime: 'fake', projectId: docs.id, supervisorId: hq.agentId },
    {
      scriptOptions: { strict: false },
      // The model is "thinking" about the plan when the server dies: the turn never ends here.
      script: (s) => s.once('plan the docs', () => new Promise<void>(() => {})),
    },
  );
  await w2.waitForTurns(1, { ...LONG, what: "the Docs Waykeeper's first turn" });
  w2.tell('plan the docs');
  await h.until(
    () => w2.prompts().some((p) => p.includes('plan the docs')) && w2.runner.state !== 'idle',
    { ...LONG, what: 'the Docs Waykeeper planning' },
  );
  const s1 = stewardOf(s1Task.id)!;
  const s2 = stewardOf(s2Task.id)!;
  return {
    hq: hq.agentId,
    notes: notes.id,
    w1: w1.agentId,
    s1: s1.id,
    s1Task: s1Task.id,
    s1Worktree: h.log.tables.tasks.get(s1Task.id)!.worktreePath!,
    s2: s2.id,
    s2Task: s2Task.id,
    s2Worktree: h.log.tables.tasks.get(s2Task.id)!.worktreePath!,
    s2Question: h.statuses.get(s2.id)!.pendingQuestionId!,
    hqQuestion: openQuestionsOf(h, hq.agentId)[0]!,
    card: card.id,
    docs: docs.id,
    w2: w2.agentId,
    agents: h.log.tables.agents.all().length,
  };
}

/** The Waykeeper's script: a Steward for every task added to its project (`scenario:<first word>`). */
export async function spawnStewards(t: TurnContext): Promise<void> {
  for (const m of t.prompt.matchAll(/task (\S+) was added to your project[^:]*: "([^"]+)"/g)) {
    await t.call('spawn_steward', {
      taskId: m[1],
      instructions: `scenario:${m[2]!.split(' ')[0]}\nDo it.`,
    });
  }
}

/** Open questions an agent asked. */
export function openQuestionsOf(h: BrainHarness, agentId: Id): Id[] {
  return h.log.tables.questions
    .all()
    .filter((q) => q.status === 'open' && q.originAgentId === agentId)
    .map((q) => q.id);
}

/** A resumed brain of the second life, by agent id. */
export function brainOf(h: BrainHarness, agentId: Id): HarnessBrain | undefined {
  return h.brains.find((b) => b.agentId === agentId);
}
