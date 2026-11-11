import {
  evaluatePanel,
  type Id,
  type Job,
  type JobRun,
  type Panel,
  type PanelData,
  type Task,
} from '@galactic/protocol';

/**
 * Every panel's data now, in the order given (P15-04, shared with the Waykeeper's `list_panels`,
 * P15-05): `evaluatePanel` over each panel's job and that job's runs, which are read once per job.
 */
export interface DashboardSource {
  job(jobId: Id): Job | undefined;
  /** A job's runs, newest first. */
  runs(jobId: Id): JobRun[];
  /** The project's own tasks (read by a status board sourced from them). */
  tasks: Task[];
}

export function evaluateDashboard(
  panels: Panel[],
  source: DashboardSource,
  now: string,
): PanelData[] {
  const runsByJob = new Map<Id, JobRun[]>();
  const runsOf = (jobId: Id): JobRun[] => {
    let runs = runsByJob.get(jobId);
    if (!runs) runsByJob.set(jobId, (runs = source.runs(jobId)));
    return runs;
  };
  return panels.map((panel) => {
    const jobId = panel.source.kind === 'job' ? panel.source.jobId : undefined;
    const job = jobId ? source.job(jobId) : undefined;
    return evaluatePanel(panel, job, jobId ? runsOf(jobId) : [], now, source.tasks);
  });
}
