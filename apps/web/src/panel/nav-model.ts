import { ENDED_STATES, type Agent, type Id, type WorkState } from '@galactic/protocol';
import type { WorldState } from '../state/reduce.js';
import type { Selection } from '../state/selection.js';
import { agentsFor } from '../console/hierarchy/shared.js';

/**
 * The panel's navigation, as data (P25-02): the projects (sub-projects and tasks nested) and the
 * standalone asteroid tasks, each with its derived state (P2-15) and what clicking it selects.
 * "Blocked on user" is the loudest state (SPEC §4.4), so blocked items sort first at every level.
 */
export interface NavItem {
  /** `project:<id>` or `task:<id>`. */
  key: string;
  kind: 'project' | 'task';
  id: Id;
  label: string;
  state: WorkState;
  blocked: boolean;
  /** What clicking the item selects: the project's Waykeeper or the task's Steward, if any. */
  selection?: Selection | undefined;
  /** The agent ids the item stands for (to highlight it when one of them is selected). */
  agentIds: Id[];
  children: NavItem[];
}

export interface NavModel {
  projects: NavItem[];
  asteroids: NavItem[];
}

const FINISHED: ReadonlySet<WorkState> = new Set(['completed', 'failed', 'moved']);

/** 0 blocked on user, 1 open work, 2 finished, 3 archived. */
export function navRank(state: WorkState): number {
  if (state === 'blocked_on_user') return 0;
  if (state === 'archived') return 3;
  if (FINISHED.has(state)) return 2;
  return 1;
}

const byRank = (a: NavItem & { createdAt: string }, b: NavItem & { createdAt: string }) =>
  navRank(a.state) - navRank(b.state) ||
  a.createdAt.localeCompare(b.createdAt) ||
  a.id.localeCompare(b.id);

/** The agent an item opens: the newest one still running, else the newest one. */
export function primaryAgent(world: Pick<WorldState, 'statuses'>, agents: Agent[]) {
  const newestFirst = [...agents].reverse();
  return (
    newestFirst.find((a) => {
      const s = world.statuses[a.id]?.state;
      return s !== undefined && !ENDED_STATES.has(s);
    }) ?? newestFirst[0]
  );
}

type Sortable = NavItem & { createdAt: string };

const strip = ({ createdAt: _c, children, ...item }: Sortable): NavItem => ({
  ...item,
  children: (children as Sortable[]).map(strip),
});

export function buildNav(world: WorldState, opts: { showArchived?: boolean } = {}): NavModel {
  const visible = (state: WorkState) => opts.showArchived === true || state !== 'archived';

  const taskItem = (taskId: Id): Sortable => {
    const task = world.tasks[taskId]!;
    const agents = agentsFor(world, { taskId });
    const agent = primaryAgent(world, agents);
    return {
      key: `task:${task.id}`,
      kind: 'task',
      id: task.id,
      label: task.description,
      state: task.state,
      blocked: task.state === 'blocked_on_user',
      selection: agent ? { kind: 'steward', id: agent.id } : undefined,
      agentIds: agents.map((a) => a.id),
      children: [],
      createdAt: task.createdAt,
    };
  };

  const projects = Object.values(world.projects).filter((p) => visible(p.state));
  const projectItem = (projectId: Id): Sortable => {
    const project = world.projects[projectId]!;
    const agents = agentsFor(world, { projectId });
    const agent = primaryAgent(world, agents);
    const subs = projects.filter((p) => p.parentProjectId === project.id).map((p) => p.id);
    const tasks = Object.values(world.tasks)
      .filter((t) => t.projectId === project.id && visible(t.state))
      .map((t) => t.id);
    return {
      key: `project:${project.id}`,
      kind: 'project',
      id: project.id,
      label: project.name,
      state: project.state,
      blocked: project.state === 'blocked_on_user',
      selection: agent ? { kind: 'waykeeper', id: agent.id } : undefined,
      agentIds: agents.map((a) => a.id),
      children: [...subs.map(projectItem), ...tasks.map(taskItem)].sort(byRank),
      createdAt: project.createdAt,
    };
  };

  const top = projects
    .filter((p) => !p.parentProjectId || !world.projects[p.parentProjectId])
    .map((p) => projectItem(p.id))
    .sort(byRank);
  const asteroids = Object.values(world.tasks)
    .filter((t) => !t.projectId && visible(t.state))
    .map((t) => taskItem(t.id))
    .sort(byRank);
  return { projects: top.map(strip), asteroids: asteroids.map(strip) };
}

/** Whether an item, or anything nested in it, stands for one of these agents. */
export function containsAgent(item: NavItem, agentId: Id | undefined): boolean {
  if (agentId === undefined) return false;
  return item.agentIds.includes(agentId) || item.children.some((c) => containsAgent(c, agentId));
}

/** Whether anything nested in the item is blocked on the user. */
export function hasBlockedChild(item: NavItem): boolean {
  return item.children.some((c) => c.blocked || hasBlockedChild(c));
}
