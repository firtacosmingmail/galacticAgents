import {
  scheduleText,
  type Job,
  type JobCollect,
  type JobRun,
  type JobSource,
  type JobSourceKind,
  type JobStep,
  type Panel,
  type UsedSource,
} from '@galactic/protocol';

/**
 * The job map's model (P15-09; SPEC decision 156): where a job's data comes from, what it
 * collects, what it does with it and which panels show it, with the links between them. Pure: the
 * view draws it. A source's state: a `problem` the newest run reported (`data.sourceProblems`);
 * else, judged against the newest ended `quiet` or `findings` run that has recorded sources (the
 * "good run"), `ok` (used) or `unused` (declared, not used); a source the good run used that the
 * map does not declare is an extra `undeclared` node. With no good run, or for a kind Mission
 * Control never records (database, command, other), a source is `unknown`: no used/unused state.
 */

export type SourceState = 'ok' | 'problem' | 'unused' | 'undeclared' | 'unknown';
export type MapSource = JobSource & { state: SourceState; problem?: string };
export type MapCollect = JobCollect;
export type MapStep = JobStep & { id: string };
export interface MapPanel {
  panelId: string;
  title: string;
  values: string[];
}
export interface MapEdge {
  from: string;
  to: string;
}
export interface MapHeader {
  lastRun?: Pick<JobRun, 'startedAt' | 'outcome' | 'purpose' | 'summary'> & { durationMs?: number };
  nextRunAt?: string;
  schedule: string;
}
export interface JobMapModel {
  /** False for a job without a data map: only what its last run used is shown. */
  hasMap: boolean;
  sources: MapSource[];
  collects: MapCollect[];
  steps: MapStep[];
  shownIn: MapPanel[];
  edges: MapEdge[];
  header: MapHeader;
}

export const sourceNode = (id: string): string => `source:${id}`;
export const collectNode = (name: string): string => `collect:${name}`;
export const stepNode = (index: number): string => `step:${index}`;
export const panelNode = (id: string): string => `panel:${id}`;

/** The kinds Mission Control records a run using (P15-02): only these are judged used or unused. */
const RECORDED_KINDS: ReadonlySet<JobSourceKind> = new Set(['mcp', 'site', 'files']);

export const isRecordedKind = (kind: JobSourceKind): boolean => RECORDED_KINDS.has(kind);

/** "posthog.com" from "https://PostHog.com/docs" or "posthog.com"; `undefined` when it is neither. */
function hostOf(target: string): string | undefined {
  const given = target.trim();
  for (const url of [given, `http://${given}`]) {
    try {
      const host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
      if (host) return host;
    } catch {
      // Not a URL: try it as a bare host.
    }
  }
  return undefined;
}

/** A folder without its trailing slashes ("/" stays "/"). */
const folderOf = (path: string): string => path.trim().replace(/\/+$/, '') || '/';

/**
 * Whether a run's recorded source (`used`) is the declared one (`declared`), by kind:
 *
 *  - `mcp`: the MCP server's name, ignoring case;
 *  - `site`: the declared target is a host or a URL; a used host matches its hostname or a
 *    subdomain of it (`api.posthog.com` matches `posthog.com`);
 *  - `files`: the declared target is a folder; a used folder matches it or a folder inside it;
 *  - `database`, `command`, `other`: never recorded, so never matched.
 */
export function sourceMatches(
  declared: Pick<JobSource, 'kind' | 'target'>,
  used: UsedSource,
): boolean {
  if (declared.kind !== used.kind) return false;
  switch (declared.kind) {
    case 'mcp':
      return declared.target.trim().toLowerCase() === used.target.trim().toLowerCase();
    case 'site': {
      const want = hostOf(declared.target);
      const got = hostOf(used.target);
      return want !== undefined && got !== undefined && (got === want || got.endsWith(`.${want}`));
    }
    case 'files': {
      const want = folderOf(declared.target);
      const got = folderOf(used.target);
      return got === want || got.startsWith(want === '/' ? '/' : `${want}/`);
    }
    default:
      return false;
  }
}

/** The run sources are judged against: the newest ended quiet or findings run with sources. */
const goodRunOf = (runs: JobRun[]): JobRun | undefined =>
  runs.find((r) => (r.outcome === 'quiet' || r.outcome === 'findings') && r.sources !== undefined);

/** `runs`: the job's recent runs, newest first (the header shows the newest). */
export function jobMapModel(job: Job, runs: JobRun[], panels: Panel[]): JobMapModel {
  const map = job.dataMap;
  const lastRun = runs[0];
  const good = goodRunOf(runs);
  const used = good?.sources ?? [];
  const problems = new Map(
    (lastRun?.data?.sourceProblems ?? []).map((p) => [p.sourceId, p.problem]),
  );

  const sources: MapSource[] = [];
  if (map) {
    for (const s of map.sources) {
      const problem = problems.get(s.id);
      if (problem !== undefined) sources.push({ ...s, state: 'problem', problem });
      else if (!good || !isRecordedKind(s.kind)) sources.push({ ...s, state: 'unknown' });
      else if (used.some((u) => sourceMatches(s, u))) sources.push({ ...s, state: 'ok' });
      else sources.push({ ...s, state: 'unused' });
    }
  }
  for (const u of used) {
    const declared = map?.sources.some((s) => sourceMatches(s, u)) ?? false;
    const id = `${map ? 'undeclared' : 'used'}:${u.kind}:${u.target}`;
    if (declared || sources.some((s) => s.id === id)) continue;
    sources.push({
      id,
      label: u.target,
      kind: u.kind,
      target: u.target,
      state: map ? 'undeclared' : 'ok',
    });
  }

  const collects = map?.collects ?? [];
  const steps: MapStep[] = (map?.steps ?? []).map((s, i) => ({ ...s, id: stepNode(i) }));
  const shownIn: MapPanel[] = panels
    .filter((p) => p.source.kind === 'job' && p.source.jobId === job.id)
    .map((p) => ({
      panelId: p.id,
      title: p.title,
      values: p.source.kind === 'job' ? p.source.values : [],
    }));

  const sourceIds = new Set(sources.map((s) => s.id));
  const collectNames = new Set(collects.map((c) => c.name));
  const edges: MapEdge[] = [];
  for (const c of collects)
    for (const id of c.sourceIds)
      if (sourceIds.has(id)) edges.push({ from: sourceNode(id), to: collectNode(c.name) });
  steps.forEach((s, i) => {
    for (const name of s.uses) {
      if (collectNames.has(name)) edges.push({ from: collectNode(name), to: stepNode(i) });
      else if (sourceIds.has(name)) edges.push({ from: sourceNode(name), to: stepNode(i) });
    }
    for (const name of s.produces)
      if (collectNames.has(name)) edges.push({ from: stepNode(i), to: collectNode(name) });
  });
  for (const p of shownIn)
    for (const v of p.values)
      if (collectNames.has(v)) edges.push({ from: collectNode(v), to: panelNode(p.panelId) });

  const started = lastRun ? Date.parse(lastRun.startedAt) : NaN;
  const ended = lastRun?.endedAt ? Date.parse(lastRun.endedAt) : NaN;
  const header: MapHeader = { schedule: scheduleText(job.schedule) };
  if (lastRun) {
    header.lastRun = {
      startedAt: lastRun.startedAt,
      outcome: lastRun.outcome,
      purpose: lastRun.purpose,
      summary: lastRun.summary,
      ...(Number.isFinite(started) && Number.isFinite(ended)
        ? { durationMs: ended - started }
        : {}),
    };
  }
  if (job.nextRunAt) header.nextRunAt = job.nextRunAt;
  return { hasMap: map !== undefined, sources, collects, steps, shownIn, edges, header };
}

/** Every node linked to `nodeId` going downstream and going upstream (not sideways). */
export function highlight(model: JobMapModel, nodeId: string): Set<string> {
  const walk = (next: (id: string) => string[]): string[] => {
    const seen = new Set<string>([nodeId]);
    const todo = [nodeId];
    while (todo.length > 0) {
      for (const n of next(todo.pop()!)) {
        if (!seen.has(n)) {
          seen.add(n);
          todo.push(n);
        }
      }
    }
    return [...seen];
  };
  const forward = walk((id) => model.edges.filter((e) => e.from === id).map((e) => e.to));
  const backward = walk((id) => model.edges.filter((e) => e.to === id).map((e) => e.from));
  return new Set([...forward, ...backward]);
}

/** Every node's label, by node id (the phone layout names a node's links in words). */
export function nodeLabels(model: JobMapModel): Map<string, string> {
  const labels = new Map<string, string>();
  for (const s of model.sources) labels.set(sourceNode(s.id), s.label);
  for (const c of model.collects) labels.set(collectNode(c.name), c.name);
  for (const s of model.steps) labels.set(s.id, s.text);
  for (const p of model.shownIn) labels.set(panelNode(p.panelId), p.title);
  return labels;
}

/** "14 s", "2 min 5 s". */
export function durationText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return s % 60 === 0 ? `${m} min` : `${m} min ${s % 60} s`;
}
