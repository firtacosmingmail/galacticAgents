import { useEffect, useId, useMemo, useState } from 'react';
import type { Id, Job, JobRun } from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import { useApi } from '../../console/hierarchy/shared.js';
import { revealInbox, revealQuestion } from '../inbox-reveal.js';
import { choiceText, jobPublishesWith } from '../providers.js';
import { jobsModel, providerText, runLine, useJobsFilter, type JobRow } from './jobs-model.js';
import './jobs.css';

/**
 * The Jobs tab (P10-07; SPEC decision 144): a long-term project's Waykeeper view lists what needs
 * Cosmin first — paused jobs ("Fix & retry" opens the failure question in the inbox) and jobs with
 * questions waiting there — then every area's jobs with their moon. A job opens its last 20 runs,
 * read from `GET /api/jobs/:id/runs`. A moon filter (`useJobsFilter`) narrows it to one moon's
 * areas. On a phone it fills the chat area like the other dock views.
 */

/** How many runs an expanded job lists. */
export const RUNS_SHOWN = 20;

/** "Now" for the relative days, refreshed twice a minute. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The job's open questions other than its failure question (that one has "Fix & retry"). */
const otherWaiting = (row: JobRow): Id[] =>
  row.waitingIds.filter((id) => id !== row.job.failureQuestionId);

function InboxLink({ ids }: { ids: Id[] }) {
  if (ids.length === 0) return null;
  return (
    <button type="button" className="jobs-link" onClick={() => void revealQuestion(ids[0]!)}>
      {ids.length} in inbox <span aria-hidden="true">→</span>
    </button>
  );
}

export function JobsPane({ projectId }: { projectId: Id }) {
  const world = useAppStore((s) => s.world);
  const bodyId = useJobsFilter((s) => s.bodyId);
  const setFilter = useJobsFilter((s) => s.set);
  const now = useNow();
  const model = useMemo(
    () => jobsModel(world, projectId, bodyId === undefined ? {} : { bodyId }, now),
    [world, projectId, bodyId, now],
  );
  const project = world.projects[projectId];
  if (!project) return <p className="pnl-empty">This project is not in the current log.</p>;

  return (
    <section className="jobs" aria-label={`jobs of ${project.name}`}>
      {model.moon && (
        <div className="jobs-filter">
          <h2 className="jobs-filter-title">
            {model.areas.map((s) => s.area.name).join(', ')} · {model.moon.name}
          </h2>
          <button type="button" className="secondary" onClick={() => setFilter(undefined)}>
            Show all jobs
          </button>
        </div>
      )}
      {model.needsYou.length > 0 && (
        <section className="jobs-section jobs-needs" aria-label="Needs you">
          <h2 className="pnl-eyebrow">Needs you</h2>
          <ul className="jobs-list">
            {model.needsYou.map((row) => (
              <NeedsYouItem key={row.job.id} row={row} />
            ))}
          </ul>
        </section>
      )}
      {model.areas.length === 0 && (
        <p className="muted jobs-empty">
          No jobs yet. Ask the Waykeeper in the chat to set one up.
        </p>
      )}
      {model.areas.map((s) => {
        const title = `${s.area.name} · ${s.moonName}`;
        return (
          <section key={s.area.id} className="jobs-section" aria-label={title}>
            <h2 className="pnl-eyebrow">{title}</h2>
            {s.shared && (
              <p className="muted jobs-shared">
                shares {s.moonName} with {s.sharedWith.join(', ')}
              </p>
            )}
            {s.rows.length === 0 ? (
              <p className="muted jobs-empty">No jobs in this area yet.</p>
            ) : (
              <ul className="jobs-list">
                {s.rows.map((row) => (
                  <JobItem key={row.job.id} row={row} now={now} />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </section>
  );
}

/** A paused job (with "Fix & retry"), or a job whose questions wait in the inbox. */
function NeedsYouItem({ row }: { row: JobRow }) {
  const { job } = row;
  const paused = job.state === 'paused';
  const fix = () => {
    if (job.failureQuestionId) void revealQuestion(job.failureQuestionId);
    else revealInbox();
  };
  return (
    <li className={`jobs-job tone-${paused ? 'bad' : row.tone}`}>
      <div className="jobs-row">
        <span className="jobs-name">
          {paused && (
            <span className="jobs-mark" aria-hidden="true">
              ✕{' '}
            </span>
          )}
          {row.area.name} · {job.name}
        </span>
        <span className="jobs-actions">
          {paused && (
            <button type="button" className="jobs-link" onClick={fix}>
              Fix &amp; retry
            </button>
          )}
          <InboxLink ids={otherWaiting(row)} />
        </span>
      </div>
      {row.pausedText && <p className="muted jobs-line">{row.pausedText}</p>}
    </li>
  );
}

function nextText(row: JobRow): string {
  switch (row.job.state) {
    case 'stopped':
      return 'stopped';
    case 'paused':
      return 'paused';
    default:
      return row.nextRunText ? `next: ${row.nextRunText}` : 'next: not scheduled';
  }
}

/** One job: name, schedule, last result, provider and next run; it opens its run history. */
function JobItem({ row, now }: { row: JobRow; now: Date }) {
  const { job } = row;
  const [open, setOpen] = useState(false);
  const runsId = useId();
  return (
    <li className={`jobs-job tone-${row.tone}${job.state === 'stopped' ? ' is-stopped' : ''}`}>
      <div className="jobs-row">
        <button
          type="button"
          className="jobs-open"
          aria-expanded={open}
          aria-controls={runsId}
          onClick={() => setOpen((o) => !o)}
        >
          <span aria-hidden="true">{open ? '▾ ' : '▸ '}</span>
          {job.name}
        </button>
        <span className="jobs-pill">{row.scheduleText}</span>
      </div>
      {row.lastLine && <p className={`jobs-line jobs-last tone-${row.tone}`}>{row.lastLine}</p>}
      <p className="jobs-line jobs-meta muted">
        <span>
          {choiceText(job.provider, job.model) ?? providerText(job.provider)} · {nextText(row)}
        </span>
        <InboxLink ids={otherWaiting(row)} />
      </p>
      {!jobPublishesWith(job).ok && (
        <p className="jobs-line muted">Publishes with: {jobPublishesWith(job).text}</p>
      )}
      <div id={runsId}>{open && <JobRuns job={job} now={now} />}</div>
    </li>
  );
}

/** The job's last runs, newest first; read again when a run starts or ends. */
function JobRuns({ job, now }: { job: Job; now: Date }) {
  const api = useApi();
  const [runs, setRuns] = useState<JobRun[]>();
  const [error, setError] = useState<string>();
  const stamp = `${job.lastRun?.runId ?? ''}:${job.lastRun?.outcome ?? ''}:${job.runningRunId ?? ''}`;
  useEffect(() => {
    let live = true;
    api.jobRuns(job.id, RUNS_SHOWN).then(
      (r) => {
        if (!live) return;
        setRuns(r.runs);
        setError(undefined);
      },
      (e: unknown) => live && setError((e as Error).message),
    );
    return () => {
      live = false;
    };
  }, [api, job.id, stamp]);
  if (error)
    return (
      <p className="error" role="alert">
        Could not read the runs: {error}
      </p>
    );
  if (!runs) return <p className="muted jobs-line">Reading the runs…</p>;
  if (runs.length === 0) return <p className="muted jobs-line">No runs yet.</p>;
  return (
    <ol className="jobs-runs" aria-label={`runs of ${job.name}`}>
      {runs.map((r) => (
        <li key={r.id} className={`tone-${r.outcome}`}>
          {runLine(r, now)}
          {r.note && <span className="muted"> · your note: {r.note}</span>}
        </li>
      ))}
    </ol>
  );
}
