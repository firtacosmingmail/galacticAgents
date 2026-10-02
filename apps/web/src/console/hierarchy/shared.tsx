import { createContext, useContext, useState } from 'react';
import type { Actor, Agent, Id, Project, Task } from '@galactic/protocol';
import type { WorldState } from '../../state/reduce.js';
import type { Api } from '../api.js';

/**
 * Small pieces the hierarchy console (P2-18) shares: the API in context, a per-widget action
 * runner with its own error line, and how agents and actors are named on the page.
 */

export const ApiContext = createContext<Api | undefined>(undefined);

export function useApi(): Api {
  const api = useContext(ApiContext);
  if (!api) throw new Error('the hierarchy console needs an ApiContext');
  return api;
}

/** Runs one action at a time for a widget; a refusal is kept for its error line. */
export function useAction() {
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { run, error, busy, clear: () => setError(undefined) };
}

export function ErrorLine({ error }: { error: string | undefined }) {
  return error ? (
    <p className="error" role="alert">
      {error}
    </p>
  ) : null;
}

export function StatePill({ state }: { state: string | undefined }) {
  const s = state ?? 'unknown';
  return <span className={`pill state-${s}`}>{s.replace(/_/g, ' ')}</span>;
}

const short = (text: string, n = 48) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/** "Harmonizer", "Waykeeper · CSV tool", "Steward · write the parser". */
export function agentLabel(
  agent: Agent | undefined,
  world: Pick<WorldState, 'projects' | 'tasks'>,
): string {
  if (!agent) return 'an agent';
  switch (agent.role) {
    case 'harmonizer':
      return 'Harmonizer';
    case 'waykeeper': {
      const project: Project | undefined = agent.projectId
        ? world.projects[agent.projectId]
        : undefined;
      return `Waykeeper · ${project?.name ?? agent.projectId ?? agent.id}`;
    }
    case 'steward': {
      const task: Task | undefined = agent.taskId ? world.tasks[agent.taskId] : undefined;
      return `Steward · ${task ? short(task.description) : agent.id}`;
    }
  }
}

/** Who an actor is, as the page says it. */
export function actorLabel(
  actor: Actor | undefined,
  world: Pick<WorldState, 'agents' | 'projects' | 'tasks'>,
): string {
  if (!actor) return 'nobody';
  if (actor.type === 'user') return 'you';
  if (actor.type === 'system') return 'the system';
  return actor.id ? agentLabel(world.agents[actor.id], world) : 'an agent';
}

/** The agents of the hierarchy that run a project (its Waykeepers) or a task (its Stewards). */
export function agentsFor(
  world: Pick<WorldState, 'agents'>,
  of: { projectId: Id } | { taskId: Id },
): Agent[] {
  return Object.values(world.agents)
    .filter((a) =>
      'taskId' in of
        ? a.role === 'steward' && a.taskId === of.taskId
        : a.role === 'waykeeper' && a.projectId === of.projectId,
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
