import {
  ENDED_STATES,
  isHarnessMeta,
  type Agent,
  type AgentState,
  type HarnessActivity,
  type HarnessState,
  type Id,
  type Question,
} from '@galactic/protocol';
import type { WorldState } from '../state/reduce.js';

/**
 * The scene harness tab as data (P4-06): which agents it lists, how it names them, what each
 * action may do for the selected one, and the Phase 4 exit-criteria checklist. No React.
 */

export interface HarnessRow {
  /** A fake agent the harness made (no process): the only agents the harness may drive. */
  agent: Agent;
  state: AgentState | undefined;
  activity: string | undefined;
  /** "Waykeeper · <project>" / "Steward · <task>". */
  label: string;
  /** The body its satellite orbits (its work's body). */
  bodyName: string | undefined;
}

/**
 * The harness's fake Waykeepers and Stewards, live ones first, newest first. Real agents are
 * never listed: the server refuses to drive them (409 `not_harness`).
 */
export function harnessRows(
  world: Pick<WorldState, 'agents' | 'statuses' | 'tasks' | 'projects' | 'bodies'>,
): HarnessRow[] {
  const rows = Object.values(world.agents)
    .filter((a) => a.role !== 'harmonizer' && isHarnessMeta(a.meta))
    .map((agent): HarnessRow => {
      const status = world.statuses[agent.id];
      const task = agent.taskId ? world.tasks[agent.taskId] : undefined;
      const project = agent.projectId ? world.projects[agent.projectId] : undefined;
      const bodyId =
        agent.role === 'steward'
          ? (task?.bodyId ?? agent.bodyId)
          : (project?.bodyId ?? agent.bodyId);
      return {
        agent,
        state: status?.state,
        activity: status?.currentActivity,
        label:
          agent.role === 'waykeeper'
            ? `Waykeeper · ${project?.name ?? agent.projectId ?? '?'}`
            : `Steward · ${task?.description ?? agent.taskId ?? '?'}`,
        bodyName: world.bodies[bodyId]?.name,
      };
    });
  const live = (r: HarnessRow) => r.state !== undefined && !ENDED_STATES.has(r.state);
  return rows.sort(
    (a, b) =>
      Number(live(b)) - Number(live(a)) ||
      b.agent.createdAt.localeCompare(a.agent.createdAt) ||
      a.agent.id.localeCompare(b.agent.id),
  );
}

/** The state buttons, in the legend's order, with the words the panel uses. */
export const STATE_BUTTONS: readonly { state: HarnessState; label: string }[] = [
  { state: 'working', label: 'Working' },
  { state: 'waiting_for_input', label: 'Waiting for you' },
  { state: 'idle', label: 'Idle' },
  { state: 'paused', label: 'Paused' },
  { state: 'stalled', label: 'Stalled' },
  { state: 'starting', label: 'Starting' },
  { state: 'finished', label: 'Finished' },
];

/** The activity presets (one per Steward archetype, decision 73). */
export const ACTIVITY_BUTTONS: readonly { preset: HarnessActivity; label: string; hint: string }[] =
  [
    { preset: 'gathering', label: 'Gathering', hint: 'Grep: TODO — drones rise from the surface' },
    {
      preset: 'transporting',
      label: 'Transporting',
      hint: 'git commit — a shuttle runs to the Waykeeper',
    },
    { preset: 'building', label: 'Building', hint: 'pnpm test — robots or a platform at work' },
    { preset: 'none', label: 'Nothing clear', hint: 'TodoWrite — the satellite only orbits' },
  ];

/** The open questions the agent asked that wait for the user (the beacons it raised). */
export function openQuestionsOf(world: Pick<WorldState, 'questions'>, agentId: Id): Question[] {
  return Object.values(world.questions).filter(
    (q) => q.originAgentId === agentId && q.status === 'open',
  );
}

/** Harness projects a harness standalone task can move into: open ones (not finished), named. */
export function moveTargets(world: Pick<WorldState, 'projects'>): { id: Id; name: string }[] {
  const closed = new Set(['completed', 'archived', 'failed', 'moved']);
  return Object.values(world.projects)
    .filter((p) => isHarnessMeta(p.meta) && !closed.has(p.state))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({ id: p.id, name: p.name }));
}

/** What the selected agent's work allows. */
export function workActions(
  world: Pick<WorldState, 'tasks' | 'projects'>,
  agent: Agent,
): { completeTask?: Id; moveTask?: Id; closeProject?: Id } {
  const finished = new Set(['completed', 'archived', 'failed', 'moved']);
  if (agent.role === 'steward' && agent.taskId) {
    const task = world.tasks[agent.taskId];
    if (!task || finished.has(task.state)) return {};
    return { completeTask: task.id, ...(task.projectId ? {} : { moveTask: task.id }) };
  }
  if (agent.role === 'waykeeper' && agent.projectId) {
    const project = world.projects[agent.projectId];
    if (!project || finished.has(project.state)) return {};
    return { closeProject: project.id };
  }
  return {};
}

/**
 * The time from a harness click to the status reaching this page (the same stream the scene
 * reads): started when the request goes out, settled by the first status record of the agent in
 * the state asked for. The exit criterion is "within a second".
 */
export interface Latency {
  agentId: Id;
  state: AgentState;
  startedAt: number;
  ms?: number;
}

export function settleLatency(
  latency: Latency | undefined,
  statuses: WorldState['statuses'],
  now: number,
): Latency | undefined {
  if (!latency || latency.ms !== undefined) return latency;
  return statuses[latency.agentId]?.state === latency.state
    ? { ...latency, ms: Math.max(0, Math.round(now - latency.startedAt)) }
    : latency;
}

/** Phase 4's exit criteria (IMPLEMENTATION_PLAN Phase 4) and how to check each with the harness. */
export const EXIT_CRITERIA: readonly { id: string; criterion: string; steps: readonly string[] }[] =
  [
    {
      id: 'state',
      criterion:
        'Switching an agent’s state in a test harness changes its satellite within a second.',
      steps: [
        'Open the panel (/) in a second window beside this one, with the scene shown.',
        'Seed demo scenario, then select one of its Stewards below; click its planet in the panel to fly there.',
        'Click each state button: the satellite’s colour and pulse change (amber blinking for waiting, grey idle, violet paused and still, orange hiccup stalled, red flicker failed).',
        'The “reached this page in … ms” line under the buttons times each switch (status stream → page, the scene’s own input): it must stay under 1000 ms.',
        'Activity presets: Gathering / Transporting / Building change the Steward’s animation within about a second (decision 73).',
      ],
    },
    {
      id: 'move',
      criterion: 'Moving a task to a project flies its satellite there.',
      steps: [
        'Select the scenario’s asteroid Steward (“Steward · Harness asteroid task …”).',
        'Choose the harness project under “Move task to” and press Move: the satellite takes off from the asteroid and flies (about 3 s) to the project’s planet; the asteroid folds into the belt.',
        'Complete task on any Steward: its satellite lands on the body and a brief flare marks the finish; Close project lands the Waykeeper and colonises the planet.',
      ],
    },
    {
      id: 'glance',
      criterion: 'A designer or friend can tell which planets are busy without reading text.',
      steps: [
        'Seed two scenarios; leave one busy (working Stewards, building / gathering) and put the other’s agents idle, one waiting (a beacon) and one failed.',
        'Zoom out to the whole-system view and ask someone who has not seen the app which planets are busy, which need you and which have a problem — without reading the labels.',
        'Record their answers in the P4-06 notes.',
      ],
    },
  ];
