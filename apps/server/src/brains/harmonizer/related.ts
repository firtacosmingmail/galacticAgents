import { basename } from 'node:path';
import type { Id, Project, Task, WorkState } from '@galactic/protocol';

/**
 * `find_related_work` (P2-08; SPEC §3.1 "before sizing, the Harmonizer asks itself whether the
 * new work belongs to an existing project"): a deterministic word-overlap search over projects
 * (name, workspace folder, task descriptions) and tasks. It informs; the model decides.
 */

export interface RelatedMatch {
  kind: 'project' | 'task';
  id: Id;
  /** The project's name or the task's description. */
  name: string;
  state: WorkState;
  /** The task's project, for a project task. */
  projectId?: Id;
  workspace?: string;
  /** Shared words over the request's words, 0–1. */
  score: number;
  matched: string[];
}

const STOPWORDS = new Set(
  (
    'the and for with that this from into onto over under about after before then than when ' +
    'what which who whom whose where why how all any some each every more most other such only ' +
    'own same too very can will just should would could may might must shall also not but are ' +
    'was were been being have has had having does did doing make made new add start build ' +
    'create please want need like let get use using our your their its his her them they you ' +
    'project task work thing one two'
  ).split(' '),
);

/** Lower-case words of at least three letters, stopwords dropped, a plural `s` trimmed. */
export function words(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    out.add(raw.length > 4 && raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw);
  }
  return [...out];
}

/** Finished-and-gone work is not "related": archived items are skipped unless asked for. */
const GONE: ReadonlySet<WorkState> = new Set(['archived']);

export function findRelated(
  request: string,
  world: { projects: Project[]; tasks: Task[] },
  opts: { limit?: number; includeArchived?: boolean } = {},
): RelatedMatch[] {
  const wanted = words(request);
  if (wanted.length === 0) return [];
  const score = (haystack: string) => {
    const have = new Set(words(haystack));
    const matched = wanted.filter((w) => have.has(w));
    return { matched, score: matched.length / wanted.length };
  };
  const keep = (state: WorkState) => opts.includeArchived === true || !GONE.has(state);
  const out: RelatedMatch[] = [];
  for (const p of world.projects) {
    if (!keep(p.state)) continue;
    const taskText = world.tasks
      .filter((t) => t.projectId === p.id)
      .map((t) => t.description)
      .join(' ');
    const s = score(`${p.name} ${basename(p.workspace)} ${taskText}`);
    if (s.matched.length === 0) continue;
    out.push({
      kind: 'project',
      id: p.id,
      name: p.name,
      state: p.state,
      workspace: p.workspace,
      ...s,
    });
  }
  for (const t of world.tasks) {
    if (!keep(t.state)) continue;
    const s = score(t.description);
    if (s.matched.length === 0) continue;
    const workspace = t.projectId
      ? world.projects.find((p) => p.id === t.projectId)?.workspace
      : (t.meta?.['workspace'] as string | undefined);
    out.push({
      kind: 'task',
      id: t.id,
      name: t.description,
      state: t.state,
      ...(t.projectId ? { projectId: t.projectId } : {}),
      ...(workspace ? { workspace } : {}),
      ...s,
    });
  }
  return out
    .sort((a, b) => b.score - a.score || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
    .slice(0, opts.limit ?? 5);
}
