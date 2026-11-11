import {
  scheduleText,
  type Job,
  type JobCollect,
  type JobRun,
  type JobSource,
  type JobStep,
  type Panel,
} from '@galactic/protocol';

/**
 * The job map's model (P15-09; SPEC decision 156): where a job's data comes from, what it
 * collects, what it does with it and which panels show it, with the links between them. Pure: the
 * view draws it. A source's state comes from the job's last run: a `problem` it reported, `unused`
 * (declared, but the run did not read it) or `undeclared` (the run read something the map does not
 * list, added as an extra flagged node).
 */

export type SourceState = 'ok' | 'problem' | 'unused' | 'undeclared';
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

export function jobMapModel(job: Job, lastRun: JobRun | undefined, panels: Panel[]): JobMapModel {
  const map = job.dataMap;
  const used = lastRun?.sources ?? [];
  const problems = new Map(
    (lastRun?.data?.sourceProblems ?? []).map((p) => [p.sourceId, p.problem]),
  );
  const sameSource = (s: { kind: string; target: string }, u: { kind: string; target: string }) =>
    s.kind === u.kind && s.target === u.target;

  const sources: MapSource[] = [];
  if (map) {
    for (const s of map.sources) {
      const problem = problems.get(s.id);
      if (problem !== undefined) sources.push({ ...s, state: 'problem', problem });
      else if (lastRun && !used.some((u) => sameSource(s, u)))
        sources.push({ ...s, state: 'unused' });
      else sources.push({ ...s, state: 'ok' });
    }
  }
  for (const u of used) {
    const declared = map?.sources.some((s) => sameSource(s, u)) ?? false;
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
