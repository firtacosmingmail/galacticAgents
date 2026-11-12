import { useCallback, useEffect, useState } from 'react';
import { isJobTask, panelsOf, type Id, type PanelData, type WorldState } from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import { useApi } from '../../console/hierarchy/shared.js';

/**
 * A long-term project's dashboard data (P15-06): `GET /api/projects/:id/dashboard`, read again
 * whenever something it depends on changes in the live world — a job's run ended or its state
 * changed (`job_run.ended`, `job.updated`), a panel was created, changed, arranged or removed
 * (`panel.*`), or one of the project's own tasks (a status board reads them; never a job's hidden
 * task) was added or changed (`task.*`). The world folds those events, so a stamp over the
 * project's jobs, panels and tasks moves exactly then, and this hook needs no stream of its own.
 */
export function dashboardStamp(world: WorldState, projectId: Id): string {
  const jobs = Object.values(world.jobs)
    .filter((j) => j.projectId === projectId)
    .map((j) =>
      [
        j.id,
        j.state,
        j.lastRun?.runId,
        j.lastRun?.outcome,
        j.runningRunId,
        j.failureQuestionId,
      ].join(':'),
    );
  const panels = panelsOf(world, projectId).map((p) =>
    [p.id, p.updatedAt, p.layout.order, p.layout.hidden ? 'h' : ''].join(':'),
  );
  const tasks = Object.values(world.tasks)
    .filter((t) => t.projectId === projectId && !isJobTask(t))
    .map((t) => [t.id, t.state, t.updatedAt].join(':'))
    .sort();
  return `${jobs.join('|')}#${panels.join('|')}#${tasks.join('|')}`;
}

export interface DashboardState {
  /** Each panel's data by panel id; empty until the first read. */
  data: Record<Id, PanelData>;
  loaded: boolean;
  error: string | undefined;
  reload: () => void;
}

export function useDashboard(projectId: Id): DashboardState {
  const api = useApi();
  const stamp = useAppStore((s) => dashboardStamp(s.world, projectId));
  const [data, setData] = useState<Record<Id, PanelData>>({});
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();
  const [manual, setManual] = useState(0);
  useEffect(() => {
    let live = true;
    api.dashboard(projectId).then(
      (r) => {
        if (!live) return;
        setData(Object.fromEntries(r.panels.map((p) => [p.panelId, p])));
        setLoaded(true);
        setError(undefined);
      },
      (e: unknown) => {
        if (live) setError((e as Error).message);
      },
    );
    return () => {
      live = false;
    };
  }, [api, projectId, stamp, manual]);
  const reload = useCallback(() => setManual((n) => n + 1), []);
  return { data, loaded, error, reload };
}
