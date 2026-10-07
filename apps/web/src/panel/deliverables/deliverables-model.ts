import {
  isDeliverableUrl,
  type Deliverable,
  type DeliverableFacts,
  type DeliverableListItem,
  type Id,
  type RunSummary,
} from '@galactic/protocol';
import type { WorldState } from '../../state/reduce.js';
import { actorLabel } from '../../console/hierarchy/shared.js';

/**
 * The deliverables views' pure model (P9-09; SPEC §4.7, decisions 118–134; TECHNOLOGY §9.5):
 * grouping and ordering, the words a row shows (who added it, where it is, what a copy left out,
 * a command's state), which actions a row offers on this client, and the viewer's choices (what
 * can be previewed, the highlighter's language, the allow-listed image types, the links
 * Markdown may keep). No React, no fetch.
 */

// --- the client --------------------------------------------------------------------------------

/**
 * What this page may do with deliverables (decisions 131, 134):
 * - `local`: the Mac's own browser or the desktop app — open, reveal, open in IDE, open an
 *   application (the server refuses every other client whatever its settings);
 * - `download`: not inside the desktop app (Open and Reveal in Finder do that job there);
 * - `edit`: add, edit, remove, restore, rescan — the settings' `writable` (decision 51: local, or
 *   any client with `autoApproveRemote`); without the settings, the Mac's own page only;
 * - `addOutside`: a path from outside the project (copied in, then downloadable by every client):
 *   the Mac's own page only, whatever `autoApproveRemote` says.
 */
export interface ClientRules {
  local: boolean;
  download: boolean;
  edit: boolean;
  addOutside: boolean;
}

export function clientRules(input: {
  loopback: boolean;
  desktop: boolean;
  writable: 'all' | 'limited' | undefined;
}): ClientRules {
  const local = input.loopback || input.desktop;
  return {
    local,
    download: !input.desktop,
    edit: input.writable === undefined ? local : input.writable === 'all',
    addOutside: local,
  };
}

// --- grouping (decision 124) -------------------------------------------------------------------

export interface TaskGroup {
  taskId: Id;
  /** The task's description, or its id when the world does not know it. */
  label: string;
  rows: DeliverableListItem[];
}

export interface ProjectGroups {
  /** The project's own: its folder, its run commands (important first), then what was declared. */
  own: DeliverableListItem[];
  /** Its tasks' deliverables, grouped by task, newest task first. */
  tasks: TaskGroup[];
}

const newestFirst = (a: Deliverable, b: Deliverable) =>
  b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);

/** The rank of a project's own row: the folder, the detected commands, then the rest. */
function ownRank(d: Deliverable): number {
  if (d.source === 'detected' && d.kind === 'folder') return 0;
  if (d.source === 'detected') return 1;
  return 2;
}

const importance = (d: Deliverable): number => {
  const v = d.meta?.['important'];
  return typeof v === 'number' ? v : Number.POSITIVE_INFINITY;
};

/** A project's own rows in decision 124's order. */
export function orderOwn<T extends Deliverable>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const r = ownRank(a) - ownRank(b);
    if (r !== 0) return r;
    if (ownRank(a) === 1) {
      const i = importance(a) - importance(b);
      if (i !== 0 && !Number.isNaN(i)) return i;
      return (
        (a.detectedKey ?? a.title).localeCompare(b.detectedKey ?? b.title) ||
        a.id.localeCompare(b.id)
      );
    }
    return newestFirst(a, b);
  });
}

/**
 * A project's rows as its Deliverables view shows them (decision 124): its own first, then its
 * tasks' grouped by task, newest task first (by the task's creation; a task the world does not
 * know by its newest deliverable). Rows of a sub-project are not here: each sub-project is folded
 * below and reads its own.
 */
export function groupForProject(
  rows: readonly DeliverableListItem[],
  world: Pick<WorldState, 'tasks'>,
): ProjectGroups {
  const own = orderOwn(rows.filter((d) => d.taskId === undefined));
  const byTask = new Map<Id, DeliverableListItem[]>();
  for (const d of rows) {
    if (d.taskId === undefined) continue;
    const list = byTask.get(d.taskId) ?? [];
    list.push(d);
    byTask.set(d.taskId, list);
  }
  const stamp = (taskId: Id, list: DeliverableListItem[]) =>
    world.tasks[taskId]?.createdAt ??
    list.reduce((max, d) => (d.createdAt > max ? d.createdAt : max), '');
  const tasks = [...byTask.entries()]
    .map(([taskId, list]) => ({
      taskId,
      label: world.tasks[taskId]?.description ?? taskId,
      rows: [...list].sort(newestFirst),
      at: stamp(taskId, list),
    }))
    .sort((a, b) => b.at.localeCompare(a.at) || a.taskId.localeCompare(b.taskId))
    .map(({ at: _at, ...g }) => g);
  return { own, tasks };
}

/** A task's rows (the Steward view, a task in the history): newest first. */
export const orderTask = <T extends Deliverable>(rows: readonly T[]): T[] =>
  [...rows].sort(newestFirst);

// --- the words of a row ------------------------------------------------------------------------

export const KIND_LABEL: Record<Deliverable['kind'], string> = {
  file: 'file',
  folder: 'folder',
  app: 'application',
  image: 'image',
  command: 'command',
  url: 'web address',
};

/** Who added it (decision 119): "detected", "you", or the agent's name. */
export function addedByText(
  d: Pick<Deliverable, 'source' | 'addedBy'>,
  world: Pick<WorldState, 'agents' | 'projects' | 'tasks'>,
): string {
  if (d.source === 'detected') return 'detected';
  return actorLabel(d.addedBy, world);
}

/** `path` relative to `base` (`''` for the base itself), or `undefined` when it is not inside. */
export function relativeTo(path: string, base: string | undefined): string | undefined {
  if (!base) return undefined;
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  if (path === b) return '';
  return path.startsWith(`${b}/`) ? path.slice(b.length + 1) : undefined;
}

/** The folders a row's path is shown relative to. */
export interface Places {
  workspace?: string | undefined;
  worktree?: string | undefined;
}

/**
 * The project's folder as the server wrote its paths (canonical: links resolved, e.g. macOS's
 * `/tmp` → `/private/tmp`): the detected "Project folder" row's path, else the parent of the
 * recorded `deliverables/` folder, else the folder the world knows.
 */
export function canonicalWorkspace(
  rows: readonly Deliverable[],
  folder: string | undefined,
  workspace: string | undefined,
): string | undefined {
  const own = rows.find(
    (d) => d.source === 'detected' && d.detectedKey === 'folder' && d.location !== undefined,
  )?.location?.path;
  if (own) return own;
  if (folder && folder.lastIndexOf('/') > 0) return folder.slice(0, folder.lastIndexOf('/'));
  return workspace;
}

/** `places` with the workspace (and a worktree inside it) moved onto `canonical`. */
export function rebase(places: Places, canonical: string | undefined): Places {
  const ws = places.workspace;
  if (!canonical || !ws || canonical === ws) return places;
  const wt = places.worktree;
  return {
    workspace: canonical,
    worktree: wt !== undefined && wt.startsWith(`${ws}/`) ? canonical + wt.slice(ws.length) : wt,
  };
}

/** `relativeTo`, also trying macOS's canonical form of `/tmp`, `/var` and `/etc`. */
function relativeToAny(path: string, base: string | undefined): string | undefined {
  const rel = relativeTo(path, base);
  if (rel !== undefined || !base || !/^\/(tmp|var|etc)(\/|$)/.test(base)) return rel;
  return relativeTo(path, `/private${base}`);
}

/** Where a row is, in words (SPEC §4.7), and whether it is missing. */
export interface WhereText {
  text: string;
  /** Shown as a path (monospace). */
  path?: string;
  missing?: string;
}

/**
 * Where it is: a path relative to the project's folder (copies are under `deliverables/`), the
 * task's worktree while the task works, the folder a command runs in, an address — or "missing"
 * with why (a copy refused, the file moved or deleted, a link that now leaves the project).
 */
export function whereText(d: DeliverableListItem, places: Places): WhereText {
  if (d.kind === 'command' && d.command) {
    const rel = relativeToAny(d.command.cwd, places.workspace);
    return {
      text: rel === '' ? 'runs in the project folder' : 'runs in',
      ...(rel === '' ? {} : { path: rel ?? d.command.cwd }),
    };
  }
  if (d.kind === 'url') return { text: 'web address', ...(d.url ? { path: d.url } : {}) };
  const loc = d.location;
  if (!loc) return { text: 'nowhere', missing: 'it has no path' };
  const missing = loc.missing?.reason ?? missingText(d.facts);
  const inWorktree =
    loc.storage === 'worktree' ? relativeToAny(loc.path, places.worktree) : undefined;
  const rel = inWorktree ?? relativeToAny(loc.path, places.workspace);
  const text =
    loc.storage === 'copy'
      ? 'in the deliverables folder'
      : loc.storage === 'worktree'
        ? "in the task's worktree"
        : rel === ''
          ? 'the project folder'
          : 'in the project folder';
  return {
    text,
    ...(rel === '' ? {} : { path: rel ?? loc.path }),
    ...(missing ? { missing } : {}),
  };
}

/** Why the file facts say it cannot be read, in words (`undefined`: it is there). */
export function missingText(facts: DeliverableFacts | undefined): string | undefined {
  if (!facts || facts.exists) return undefined;
  switch (facts.problem) {
    case undefined:
    case 'missing':
      return 'not there any more (moved or deleted)';
    case 'changed':
      return 'it changed while it was read: try again';
    case 'outside':
      return 'it now points outside the project';
    case 'refused_area':
      return 'it now points into a protected folder';
    case 'secret':
      return 'its name looks like a secret';
    case 'hard_link':
      return 'it has more than one hard link';
    default:
      return facts.problem.replace(/_/g, ' ');
  }
}

/** One entry a copy left out (`meta.copy.skipped`, TECHNOLOGY §9.4). */
export interface SkippedEntry {
  path: string;
  reason: string;
}

const SKIP_REASON: Record<string, string> = {
  secret: 'secret',
  hard_link: 'hard link',
  symlink: 'link',
  special: 'not a file',
  missing: 'gone',
  changed: 'changed while copied',
  stray_refused: 'not made by the agent',
  refused_area: 'protected folder',
  outside: 'outside the project',
};

/** What a copy left out (wave-2 review S1): the listed entries and how many in all. */
export function skippedOf(
  meta: Deliverable['meta'],
): { count: number; entries: SkippedEntry[] } | undefined {
  const copy = meta?.['copy'];
  if (typeof copy !== 'object' || copy === null) return undefined;
  const raw = (copy as { skipped?: unknown }).skipped;
  const entries = Array.isArray(raw)
    ? raw.filter(
        (e): e is SkippedEntry =>
          typeof e === 'object' &&
          e !== null &&
          typeof (e as SkippedEntry).path === 'string' &&
          typeof (e as SkippedEntry).reason === 'string',
      )
    : [];
  const counted = (copy as { skippedCount?: unknown }).skippedCount;
  const count = typeof counted === 'number' && counted >= entries.length ? counted : entries.length;
  return count > 0 ? { count, entries } : undefined;
}

/** "3 files left out: .env (secret), keys/id_rsa (secret), cache (link)". */
export function skippedText(skipped: { count: number; entries: SkippedEntry[] }, shown = 3) {
  const head = `${skipped.count} ${skipped.count === 1 ? 'entry' : 'entries'} left out`;
  const listed = skipped.entries
    .slice(0, shown)
    .map((e) => `${e.path} (${SKIP_REASON[e.reason] ?? e.reason.replace(/_/g, ' ')})`);
  const more = skipped.count - listed.length;
  return `${head}: ${listed.join(', ')}${more > 0 ? `, and ${more} more` : ''}`;
}

const REASON_WORDS: Record<string, string> = {
  server_restarted: 'Mission Control restarted',
  server_stopping: 'Mission Control stopped',
  project_closed: 'the project closed',
  task_finished: 'the task finished',
  deliverable_removed: 'it was removed',
};

/** A command's state (SPEC §4.7): "not run yet", "running · :5173", "exited 1", "stopped — …". */
export function runStateText(run: RunSummary | undefined): string {
  if (!run) return 'not run yet';
  const ports = run.ports.length > 0 ? ` · ${run.ports.map((p) => `:${p}`).join(' ')}` : '';
  if (run.state === 'starting') return 'starting';
  if (run.state === 'running') return `running${ports}`;
  if (run.state === 'stopping') return `stopping${ports}`;
  const why = run.reason ? ` — ${REASON_WORDS[run.reason] ?? run.reason.replace(/_/g, ' ')}` : '';
  if (run.outcome === 'exited') return `exited ${run.exitCode ?? 0}${why}`;
  if (run.outcome === 'failed') return `failed${run.signal ? ` (${run.signal})` : ''}${why}`;
  return `stopped${why}`;
}

// --- actions -----------------------------------------------------------------------------------

export type DeliverableAction =
  'view' | 'open' | 'reveal' | 'download' | 'ide' | 'app' | 'link' | 'edit' | 'remove' | 'restore';

/** The preview limits of the page (decision 125), not of the files. */
export const PREVIEW_IMAGE_BYTES = 20 * 1024 * 1024;

/** Whether the viewer can show a file: text (cut at 2 MiB by the server) or an image ≤ 20 MiB. */
export function canPreview(d: Pick<DeliverableListItem, 'kind' | 'facts'>): boolean {
  if (d.kind !== 'file' && d.kind !== 'image') return false;
  const f = d.facts;
  if (!f?.exists || f.isDirectory) return false;
  if (f.kindGuess === 'text') return true;
  if (f.kindGuess === 'image') return f.size === undefined || f.size <= PREVIEW_IMAGE_BYTES;
  return false;
}

export interface RowActions {
  /** Offered here. */
  actions: DeliverableAction[];
  /** Opening actions this client cannot do (the phone): shown as "on the Mac". */
  macOnly: DeliverableAction[];
}

/**
 * The actions of a row (SPEC §4.7's table) on this client. A removed row has none but Restore
 * (decision 132: "removed by …", without actions); a missing file keeps Reveal (its folder may
 * still be there) and loses View, Open and Download.
 */
export function rowActions(d: DeliverableListItem, rules: ClientRules): RowActions {
  if (d.removedAt !== undefined) return { actions: rules.edit ? ['restore'] : [], macOnly: [] };
  const out: DeliverableAction[] = [];
  const mac: DeliverableAction[] = [];
  const present = d.facts?.exists === true && !d.location?.missing;
  const mine = (a: DeliverableAction) => (rules.local ? out.push(a) : mac.push(a));
  switch (d.kind) {
    case 'file':
    case 'image':
      if (canPreview(d)) out.push('view');
      if (present) mine('open');
      if (present) mine('reveal');
      if (present && rules.download && !d.facts?.isDirectory) out.push('download');
      break;
    case 'folder':
      if (present) mine('ide');
      if (present) mine('reveal');
      break;
    case 'app':
      if (present) mine('app');
      if (present) mine('reveal');
      break;
    case 'url':
      if (d.url && isDeliverableUrl(d.url)) out.push('link');
      break;
    case 'command':
      // Run, Stop and Restart are the runs' (decision 129; P9-10).
      break;
  }
  if (rules.edit) out.push('edit', 'remove');
  return { actions: out, macOnly: mac };
}

// --- the viewer --------------------------------------------------------------------------------

/** The image types the viewer puts in an `<img>` from a blob (TECHNOLOGY §9.5): never HTML. */
export const IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/svg+xml',
]);

/** The bare media type of a `Content-Type` header, lower-cased. */
export const mediaType = (contentType: string): string =>
  contentType.split(';')[0]!.trim().toLowerCase();

/** The allow-listed image type of a response, or `undefined`: it is not shown as a picture. */
export function imageTypeOf(contentType: string): string | undefined {
  const t = mediaType(contentType);
  return IMAGE_TYPES.has(t) ? t : undefined;
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** A file name's extension, lower-cased (`''` without one); `Makefile`-like names by name. */
export function extensionOf(path: string): string {
  const name = baseName(path).toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : '';
}

export const isMarkdownPath = (path: string) =>
  ['md', 'markdown', 'mdown', 'mkd'].includes(extensionOf(path));

/** highlight.js's language for a file (one of the fixed set the viewer registers), or none. */
export function languageOf(path: string): string | undefined {
  const name = baseName(path).toLowerCase();
  if (name === 'makefile' || name === 'gnumakefile') return 'makefile';
  if (name === 'dockerfile') return 'dockerfile';
  if (name === 'justfile') return 'makefile';
  const ext = extensionOf(path);
  return LANGUAGES[ext];
}

const LANGUAGES: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'scss',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  vue: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  command: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  cfg: 'ini',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  sql: 'sql',
  diff: 'diff',
  patch: 'diff',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  rb: 'ruby',
  php: 'php',
  dockerfile: 'dockerfile',
  mk: 'makefile',
};

/** Past this, text is shown plain (highlighting megabytes would freeze the page). */
export const HIGHLIGHT_MAX_CHARS = 256 * 1024;

/**
 * The links rendered Markdown keeps (decision 126): `http`, `https` and `mailto` only — a
 * `javascript:` or `data:` link, a relative one (another file) and an anchor become plain text.
 */
export function safeLink(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:'
      ? u.href
      : undefined;
  } catch {
    return undefined;
  }
}
