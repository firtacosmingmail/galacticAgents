import {
  ENDED_STATES,
  type Agent,
  type AgentState,
  type Id,
  type Project,
  type Question,
  type QuestionKind,
  type SettingsCaps,
  type StatusRecord,
  type Task,
  type WorkState,
} from '@galactic/protocol';
import type { WorldState } from '../../state/reduce.js';
import { HARMONIZER, type Selection } from '../../state/selection.js';
import { agentLabel, agentsFor } from '../../console/hierarchy/shared.js';
import { waitingForUserCount } from '../inbox-model.js';
import { primaryAgent, stewardCount, type StewardCount } from '../nav-model.js';

/**
 * The status views (P5-02; SPEC §4.3 "ask for the status of anything", TECHNOLOGY §4 "status
 * views without LLM calls"): the whole system, a project, a task — as pure functions over the
 * client world (the folded log and the server's status records). Nothing here asks an agent or a
 * model; the Harmonizer's narrative status is a separate, optional chat message.
 *
 * "Blocked on user" is the loudest state everywhere (§4.4): it leads every list and every count.
 */

/** Work states in the order the views list them: what blocks on the user first, archived last. */
export const WORK_STATE_ORDER: readonly WorkState[] = [
  'blocked_on_user',
  'in_progress',
  'awaiting_closure',
  'approved',
  'paused',
  'interrupted',
  'failed',
  'proposed',
  'completed',
  'moved',
  'archived',
];

/** Agent states in the order the views list them: waiting for the user first, ended last. */
export const AGENT_STATE_ORDER: readonly AgentState[] = [
  'waiting_for_input',
  'working',
  'starting',
  'stalled',
  'idle',
  'paused',
  'interrupted',
  'failed',
  'stopped',
  'finished',
];

/** A count per state, only the states that occur, in the views' order. */
export interface StateCount<S extends string> {
  state: S;
  count: number;
}

function countBy<S extends string>(states: Iterable<S>, order: readonly S[]): StateCount<S>[] {
  const counts = new Map<S, number>();
  for (const s of states) counts.set(s, (counts.get(s) ?? 0) + 1);
  return order.filter((s) => counts.has(s)).map((state) => ({ state, count: counts.get(state)! }));
}

// --- cost ---------------------------------------------------------------------------------------

/**
 * A sum of agents' `costSoFar`: dollars where the runtime reports them, tokens of the agents that
 * report only tokens (so nothing is counted twice), and how many agents it covers.
 */
export interface CostTotal {
  usd: number;
  /** Tokens of the agents without a dollar figure. */
  tokens: number;
  /** Agents summed (with a status record). */
  agents: number;
}

export const NO_COST: CostTotal = { usd: 0, tokens: 0, agents: 0 };

export function addCost(total: CostTotal, status: StatusRecord | undefined): CostTotal {
  if (!status) return total;
  const cost = status.costSoFar;
  const usd = cost?.usd;
  const tokens = usd === undefined ? (cost?.inputTokens ?? 0) + (cost?.outputTokens ?? 0) : 0;
  return { usd: total.usd + (usd ?? 0), tokens: total.tokens + tokens, agents: total.agents + 1 };
}

export function costOf(world: Pick<WorldState, 'statuses'>, agents: Iterable<Agent>): CostTotal {
  let total = NO_COST;
  for (const a of agents) total = addCost(total, world.statuses[a.id]);
  return total;
}

/** "$1.23", "$0.0420", "12,000 tokens", "$1.23 + 4,000 tokens", or "—". */
export function formatCostTotal(total: CostTotal): string {
  const usd = total.usd > 0 ? `$${total.usd.toFixed(total.usd < 1 ? 4 : 2)}` : undefined;
  const tokens = total.tokens > 0 ? `${total.tokens.toLocaleString('en-US')} tokens` : undefined;
  if (usd && tokens) return `${usd} + ${tokens}`;
  return usd ?? tokens ?? '—';
}

// --- questions ----------------------------------------------------------------------------------

export interface QuestionCounts {
  open: number;
  byKind: Record<QuestionKind, number>;
  /** Held by the user: these block on them. */
  forUser: number;
  /** Held by a supervisor, which may answer a clarification from context. */
  bySupervisors: number;
}

export function questionCounts(questions: Iterable<Question>): QuestionCounts {
  const out: QuestionCounts = {
    open: 0,
    byKind: { permission: 0, clarification: 0 },
    forUser: 0,
    bySupervisors: 0,
  };
  for (const q of questions) {
    if (q.status !== 'open') continue;
    out.open += 1;
    out.byKind[q.kind] += 1;
    if (q.holder.type === 'user') out.forUser += 1;
    else out.bySupervisors += 1;
  }
  return out;
}

// --- attention ----------------------------------------------------------------------------------

/**
 * Why an item needs a look, loudest first: blocked on the user (amber), failed, interrupted by a
 * restart, stalled (silent past the runtime's threshold), close to a cap.
 */
export type AttentionTone = 'blocked' | 'failed' | 'interrupted' | 'stalled' | 'cap';

const TONE_RANK: Record<AttentionTone, number> = {
  blocked: 0,
  failed: 1,
  interrupted: 2,
  stalled: 3,
  cap: 4,
};

export interface AttentionItem {
  /** `project:<id>`, `task:<id>` or `agent:<id>`, plus the tone. */
  key: string;
  kind: 'project' | 'task' | 'agent';
  id: Id;
  label: string;
  tone: AttentionTone;
  /** "2 questions for you", "failed", "tool calls 410 / 500"… */
  detail: string;
  /** What clicking it selects (its agent), when it has one. */
  selection?: Selection | undefined;
  createdAt: string;
}

const byAge = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

export function sortAttention(items: AttentionItem[]): AttentionItem[] {
  return [...items].sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone] || byAge(a, b));
}

/** Share of a cap at which an agent counts as "close to its cap". */
export const NEAR_CAP = 0.8;

const isLive = (status: StatusRecord | undefined) =>
  status !== undefined && !ENDED_STATES.has(status.state);

export const selectionOf = (agent: Agent | undefined): Selection | undefined =>
  !agent
    ? undefined
    : agent.role === 'harmonizer'
      ? HARMONIZER
      : { kind: agent.role, id: agent.id };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The running wall clock (TECHNOLOGY §4): extrapolated from `startedAt` while the agent works. */
export function wallClockAt(status: StatusRecord, now: number): number {
  const ticking = !ENDED_STATES.has(status.state) && status.state !== 'paused';
  if (!ticking) return status.caps.wallClockMs.used;
  const since = now - Date.parse(status.startedAt);
  return Math.max(status.caps.wallClockMs.used, Number.isFinite(since) ? since : 0);
}

/** "tool calls 410 / 500" or "wall clock 85%" when a live agent is close to a cap. */
export function nearCap(status: StatusRecord | undefined, now: number): string | undefined {
  if (!isLive(status)) return undefined;
  const { toolCalls, wallClockMs } = status!.caps;
  if (toolCalls.used >= NEAR_CAP * toolCalls.limit)
    return `tool calls ${toolCalls.used} / ${toolCalls.limit}`;
  const clock = wallClockAt(status!, now);
  if (clock >= NEAR_CAP * wallClockMs.limit)
    return `wall clock ${Math.min(100, Math.round((clock / wallClockMs.limit) * 100))}% of its cap`;
  return undefined;
}

/** The agents whose open questions count for a work item: its own and (a project) its tasks'. */
function questionsOfAgents(world: WorldState, agentIds: ReadonlySet<Id>): Question[] {
  return Object.values(world.questions).filter(
    (q) => q.status === 'open' && agentIds.has(q.originAgentId),
  );
}

function workAttention(
  world: WorldState,
  kind: 'project' | 'task',
  item: Project | Task,
  label: string,
  agents: Agent[],
  questionAgents: ReadonlySet<Id>,
): AttentionItem | undefined {
  const selection = selectionOf(primaryAgent(world, agents));
  const base = { kind, id: item.id, label, selection, createdAt: item.createdAt };
  if (item.state === 'blocked_on_user') {
    const forUser = questionsOfAgents(world, questionAgents).filter(
      (q) => q.holder.type === 'user',
    ).length;
    return {
      ...base,
      key: `${kind}:${item.id}:blocked`,
      tone: 'blocked',
      detail: forUser > 0 ? `${plural(forUser, 'question')} for you` : 'waits for you',
    };
  }
  if (item.state === 'failed')
    return { ...base, key: `${kind}:${item.id}:failed`, tone: 'failed', detail: 'failed' };
  if (item.state === 'interrupted')
    return {
      ...base,
      key: `${kind}:${item.id}:interrupted`,
      tone: 'interrupted',
      detail: 'interrupted by a restart',
    };
  return undefined;
}

function agentAttention(world: WorldState, agent: Agent, now: number): AttentionItem | undefined {
  const status = world.statuses[agent.id];
  const base = {
    kind: 'agent' as const,
    id: agent.id,
    label: agentLabel(agent, world),
    selection: selectionOf(agent),
    createdAt: agent.createdAt,
  };
  if (status?.state === 'stalled')
    return { ...base, key: `agent:${agent.id}:stalled`, tone: 'stalled', detail: 'stalled' };
  const cap = nearCap(status, now);
  if (cap) return { ...base, key: `agent:${agent.id}:cap`, tone: 'cap', detail: cap };
  return undefined;
}

// --- system -------------------------------------------------------------------------------------

export interface CapUse {
  used: number;
  /** Absent when the settings are not readable (no settings endpoint). */
  limit?: number | undefined;
}

export interface SystemStatus {
  projects: StateCount<WorkState>[];
  tasks: StateCount<WorkState>[];
  /** Agents with a status record (live, or ended within the server's retention), by state. */
  agents: StateCount<AgentState>[];
  live: { stewards: number; waykeepers: number; harmonizer: AgentState | undefined };
  /** Everything that needs a look, blocked on the user first. */
  attention: AttentionItem[];
  questions: QuestionCounts;
  /** "Waiting for you" (decision 58): user-held questions + cards waiting for a decision. */
  waiting: number;
  /** Cards waiting for the user's decision (pending or edited). */
  cards: number;
  cost: { total: CostTotal; today: CostTotal; brains: CostTotal; stewards: CostTotal };
  caps: { liveStewards: CapUse; spawnsLastHour: CapUse };
}

const startOfLocalDay = (now: number) => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Work that is still in the system: archived work is in the history view (decision 61). */
const current = (state: WorkState) => state !== 'archived';

export function systemStatus(
  world: WorldState,
  opts: { now: number; caps?: SettingsCaps | undefined },
): SystemStatus {
  const { now } = opts;
  const agents = Object.values(world.agents);
  const projects = Object.values(world.projects);
  const tasks = Object.values(world.tasks);

  const attention: AttentionItem[] = [];
  const covered = new Set<Id>(); // agents whose user-held questions an item already counts
  for (const project of projects) {
    if (!current(project.state)) continue;
    const own = agentsFor(world, { projectId: project.id });
    const ids = new Set(own.map((a) => a.id));
    for (const t of tasks)
      if (t.projectId === project.id)
        for (const a of agentsFor(world, { taskId: t.id })) ids.add(a.id);
    const item = workAttention(world, 'project', project, project.name, own, ids);
    if (item) {
      attention.push(item);
      if (item.tone === 'blocked') for (const id of ids) covered.add(id);
    }
  }
  for (const task of tasks) {
    if (!current(task.state)) continue;
    const own = agentsFor(world, { taskId: task.id });
    const ids = new Set(own.map((a) => a.id));
    const item = workAttention(world, 'task', task, task.description, own, ids);
    if (item) {
      attention.push(item);
      if (item.tone === 'blocked') for (const id of ids) covered.add(id);
    }
  }
  // A user-held question whose work is not marked blocked (the Harmonizer's own ask_user, a
  // Waykeeper's merge conflict before the projection catches up): its agent is listed instead.
  const open = Object.values(world.questions).filter((q) => q.status === 'open');
  const orphanAsks = new Map<Id, number>();
  for (const q of open)
    if (q.holder.type === 'user' && !covered.has(q.originAgentId))
      orphanAsks.set(q.originAgentId, (orphanAsks.get(q.originAgentId) ?? 0) + 1);
  for (const [agentId, n] of orphanAsks) {
    const agent = world.agents[agentId];
    attention.push({
      key: `agent:${agentId}:blocked`,
      kind: 'agent',
      id: agentId,
      label: agent ? agentLabel(agent, world) : agentId,
      tone: 'blocked',
      detail: `${plural(n, 'question')} for you`,
      selection: selectionOf(agent),
      createdAt: agent?.createdAt ?? '',
    });
  }
  for (const agent of agents) {
    const item = agentAttention(world, agent, now);
    if (item) attention.push(item);
  }

  const withStatus = agents.filter((a) => world.statuses[a.id]);
  const liveOf = (role: Agent['role']) =>
    withStatus.filter((a) => a.role === role && isLive(world.statuses[a.id]));
  const harmonizers = liveOf('harmonizer');
  const harmonizer =
    harmonizers.at(-1) ??
    withStatus
      .filter((a) => a.role === 'harmonizer')
      .sort(byAge)
      .at(-1);

  const midnight = startOfLocalDay(now);
  let total = NO_COST;
  let today = NO_COST;
  let brains = NO_COST;
  let stewards = NO_COST;
  for (const a of withStatus) {
    const s = world.statuses[a.id];
    total = addCost(total, s);
    if (s && Date.parse(s.lastEventAt) >= midnight) today = addCost(today, s);
    if (a.role === 'steward') stewards = addCost(stewards, s);
    else brains = addCost(brains, s);
  }

  const hourAgo = now - 3_600_000;
  const spawnsLastHour = agents.filter(
    (a) => a.role !== 'harmonizer' && Date.parse(a.createdAt) >= hourAgo,
  ).length;

  return {
    projects: countBy(
      projects.map((p) => p.state),
      WORK_STATE_ORDER,
    ),
    tasks: countBy(
      tasks.map((t) => t.state),
      WORK_STATE_ORDER,
    ),
    agents: countBy(
      withStatus.map((a) => world.statuses[a.id]!.state),
      AGENT_STATE_ORDER,
    ),
    live: {
      stewards: liveOf('steward').length,
      waykeepers: liveOf('waykeeper').length,
      harmonizer: harmonizer ? world.statuses[harmonizer.id]?.state : undefined,
    },
    attention: sortAttention(attention),
    questions: questionCounts(open),
    waiting: waitingForUserCount(world),
    cards: Object.values(world.proposals).filter(
      (p) => p.state === 'pending' || p.state === 'edited',
    ).length,
    cost: { total, today, brains, stewards },
    caps: {
      // Decision 43: the concurrency cap counts Stewards only.
      liveStewards: { used: liveOf('steward').length, limit: opts.caps?.maxConcurrentAgents },
      spawnsLastHour: { used: spawnsLastHour, limit: opts.caps?.maxSpawnsPerHour },
    },
  };
}

// --- project ------------------------------------------------------------------------------------

/** One task as the project and task views show it. */
export interface TaskRow {
  task: Task;
  /** The Steward the task opens: the newest live one, else the newest (decision 53). */
  steward: Agent | undefined;
  status: StatusRecord | undefined;
  selection: Selection | undefined;
  blocked: boolean;
  /** How many Stewards the task has had (a respawn counts again). */
  stewards: number;
  questions: QuestionCounts;
  /** Every Steward of the task, respawns included. */
  cost: CostTotal;
}

const TASK_RANK = (state: WorkState) => {
  const i = WORK_STATE_ORDER.indexOf(state);
  return i < 0 ? WORK_STATE_ORDER.length : i;
};

export function taskRow(world: WorldState, task: Task): TaskRow {
  const stewards = agentsFor(world, { taskId: task.id });
  const steward = primaryAgent(world, stewards);
  const ids = new Set(stewards.map((a) => a.id));
  const questions = questionCounts(questionsOfAgents(world, ids));
  return {
    task,
    steward,
    status: steward ? world.statuses[steward.id] : undefined,
    selection: selectionOf(steward),
    blocked: task.state === 'blocked_on_user' || questions.forUser > 0,
    stewards: stewards.length,
    questions,
    cost: costOf(world, stewards),
  };
}

export interface SubProjectRow {
  project: Project;
  selection: Selection | undefined;
  blocked: boolean;
  stewards: StewardCount;
}

export interface ProjectStatus {
  project: Project;
  parent: Project | undefined;
  /** The Waykeeper the project opens (newest live, else newest). */
  waykeeper: Agent | undefined;
  tasks: StateCount<WorkState>[];
  /** Its own tasks (not its sub-projects'), blocked first, then by state, oldest first; archived left out. */
  rows: TaskRow[];
  archivedTasks: number;
  stewards: StewardCount;
  /** Its live Stewards against the per-Waykeeper cap (decision 18). */
  stewardCap: CapUse;
  attention: AttentionItem[];
  questions: QuestionCounts;
  /** Its Waykeepers and its tasks' Stewards (sub-projects count on their own). */
  cost: CostTotal;
  subProjects: SubProjectRow[];
}

export function projectStatus(
  world: WorldState,
  projectId: Id,
  opts: { now: number; caps?: SettingsCaps | undefined },
): ProjectStatus | undefined {
  const project = world.projects[projectId];
  if (!project) return undefined;
  const waykeepers = agentsFor(world, { projectId });
  const waykeeper = primaryAgent(world, waykeepers);
  const tasks = Object.values(world.tasks).filter((t) => t.projectId === projectId);
  const rows = tasks
    .filter((t) => t.state !== 'archived')
    .map((t) => taskRow(world, t))
    .sort(
      (a, b) =>
        Number(b.blocked) - Number(a.blocked) ||
        TASK_RANK(a.task.state) - TASK_RANK(b.task.state) ||
        byAge(a.task, b.task),
    );
  const stewardAgents = tasks.flatMap((t) => agentsFor(world, { taskId: t.id }));
  const ids = new Set([...waykeepers, ...stewardAgents].map((a) => a.id));

  const attention: AttentionItem[] = [];
  for (const row of rows) {
    const own = agentsFor(world, { taskId: row.task.id });
    const item = workAttention(
      world,
      'task',
      row.task,
      row.task.description,
      own,
      new Set(own.map((a) => a.id)),
    );
    // A question for the user before the derived state says so (or on failed work): still loud.
    if (row.blocked && row.task.state !== 'blocked_on_user')
      attention.push({
        key: `task:${row.task.id}:blocked`,
        kind: 'task',
        id: row.task.id,
        label: row.task.description,
        tone: 'blocked',
        detail: `${plural(row.questions.forUser, 'question')} for you`,
        selection: row.selection,
        createdAt: row.task.createdAt,
      });
    if (item) attention.push(item);
  }
  const waykeeperAsks = questionsOfAgents(world, new Set(waykeepers.map((a) => a.id))).filter(
    (q) => q.holder.type === 'user',
  ).length;
  if (waykeeperAsks > 0 && waykeeper)
    attention.push({
      key: `agent:${waykeeper.id}:blocked`,
      kind: 'agent',
      id: waykeeper.id,
      label: agentLabel(waykeeper, world),
      tone: 'blocked',
      detail: `${plural(waykeeperAsks, 'question')} for you`,
      selection: selectionOf(waykeeper),
      createdAt: waykeeper.createdAt,
    });
  for (const agent of [...waykeepers, ...stewardAgents]) {
    const item = agentAttention(world, agent, opts.now);
    if (item) attention.push(item);
  }

  const liveStewards = stewardAgents.filter((a) => isLive(world.statuses[a.id])).length;
  const subProjects = Object.values(world.projects)
    .filter((p) => p.parentProjectId === projectId && p.state !== 'archived')
    .map((p) => ({
      project: p,
      selection: selectionOf(primaryAgent(world, agentsFor(world, { projectId: p.id }))),
      blocked: p.state === 'blocked_on_user',
      stewards: stewardCount(world, p.id),
    }))
    .sort(
      (a, b) =>
        TASK_RANK(a.project.state) - TASK_RANK(b.project.state) || byAge(a.project, b.project),
    );

  return {
    project,
    parent: project.parentProjectId ? world.projects[project.parentProjectId] : undefined,
    waykeeper,
    tasks: countBy(
      tasks.map((t) => t.state),
      WORK_STATE_ORDER,
    ),
    rows,
    archivedTasks: tasks.filter((t) => t.state === 'archived').length,
    stewards: stewardCount(world, projectId),
    stewardCap: { used: liveStewards, limit: opts.caps?.maxStewardsPerWaykeeper },
    attention: sortAttention(attention),
    questions: questionCounts(questionsOfAgents(world, ids)),
    cost: costOf(world, [...waykeepers, ...stewardAgents]),
    subProjects,
  };
}

// --- task (the Steward view's additions) ---------------------------------------------------------

export interface TaskStatus extends TaskRow {
  project: Project | undefined;
  /** When the task entered its current state (its row's `updatedAt`). */
  since: string;
  /** Milliseconds since the selected Steward's last event, when it has a status record. */
  silentForMs: number | undefined;
}

export function taskStatus(
  world: WorldState,
  taskId: Id,
  opts: { now: number; agentId?: Id | undefined },
): TaskStatus | undefined {
  const task = world.tasks[taskId];
  if (!task) return undefined;
  const row = taskRow(world, task);
  const status = opts.agentId ? world.statuses[opts.agentId] : row.status;
  const last = status ? Date.parse(status.lastEventAt) : NaN;
  return {
    ...row,
    project: task.projectId ? world.projects[task.projectId] : undefined,
    since: task.updatedAt,
    silentForMs: Number.isFinite(last) ? Math.max(0, opts.now - last) : undefined,
  };
}

/** "blocked on user" → "blocked on you", "in_progress" → "in progress". */
export const stateWords = (state: string) =>
  state === 'blocked_on_user'
    ? 'blocked on you'
    : state === 'waiting_for_input'
      ? 'waiting for input'
      : state.replace(/_/g, ' ');

/** The text the "ask the Harmonizer" button sends: the one LLM path of the status views. */
export function narrativeRequest(
  scope: { kind: 'system' } | { kind: 'project'; project: Project },
) {
  return scope.kind === 'system'
    ? 'Give me a short narrative status of the whole system: what is moving, what is blocked, and what needs me.'
    : `Give me a short narrative status of the project "${scope.project.name}" (${scope.project.id}): what is moving, what is blocked, and what needs me.`;
}
