import { z } from 'zod';
import { Actor } from './domain.js';
import { Id, Meta, Timestamp } from './primitives.js';

// ---------------------------------------------------------------------------
// Deliverables (Phase 9; SPEC §4.7, decisions 118–134; TECHNOLOGY §9). A deliverable is a pointer
// to what a project or a task produced — never the bytes themselves (decision 118). The rows are
// folded from `deliverable.*` events (and their `lastRun` from `run.*`) by the shared world fold
// (`world.ts`), so the server, the web client and the import agree.
// ---------------------------------------------------------------------------

/** What a deliverable points at (decision 118). */
export const DeliverableKind = z.enum(['file', 'folder', 'app', 'image', 'command', 'url']);
export type DeliverableKind = z.infer<typeof DeliverableKind>;

/** The kinds that point at a path (`location`); `command` has a `command`, `url` a `url`. */
export const PATH_KINDS: ReadonlySet<DeliverableKind> = new Set<DeliverableKind>([
  'file',
  'folder',
  'app',
  'image',
]);

/** Who added it (decision 119): an agent declared it, the server detected it, the user added it. */
export const DeliverableSource = z.enum(['agent', 'detected', 'user']);
export type DeliverableSource = z.infer<typeof DeliverableSource>;

/**
 * Where a path deliverable is (TECHNOLOGY §9.1, §9.4): `in_place` inside the project's folder (its
 * `deliverables/` folder included when it was declared there), `worktree` inside a task's worktree
 * (re-pointed or copied by the merge hook, decision 123), `copy` in the project's `deliverables/`
 * folder, copied from `originalPath`. `missing` once it could not be kept (the copy was refused,
 * decision 123) — a file the user deleted is reported missing by the file facts, not stored.
 */
export const DeliverableLocation = z.object({
  storage: z.enum(['in_place', 'worktree', 'copy']),
  /** Absolute and canonical (symlink-free) when written. */
  path: z.string().min(1),
  originalPath: z.string().min(1).optional(),
  missing: z.object({ reason: z.string().min(1), at: Timestamp }).optional(),
});
export type DeliverableLocation = z.infer<typeof DeliverableLocation>;

/** A run command (decision 129): the line and the folder it runs in. */
export const DeliverableCommand = z.object({
  line: z.string().min(1),
  /** Absolute and canonical when written. */
  cwd: z.string().min(1),
  /** The file it was found in (`package.json`, `Makefile`, …) for a detected command. */
  detectedFrom: z.string().min(1).optional(),
});
export type DeliverableCommand = z.infer<typeof DeliverableCommand>;

/**
 * A run's state. The world folds only `running` (from `run.started`) and `ended` (from
 * `run.ended`); `starting` and `stopping` are the run service's live states, shown by its REST
 * reads (P9-08).
 */
export const RunState = z.enum(['starting', 'running', 'stopping', 'ended']);
export type RunState = z.infer<typeof RunState>;

/** How a run ended (decision 130): its own exit, a signal or start failure, or a stop. */
export const RunOutcome = z.enum(['exited', 'failed', 'stopped']);
export type RunOutcome = z.infer<typeof RunOutcome>;

/**
 * Why the server ended a run (TECHNOLOGY §9.8). Free text on the wire so a later build may add
 * one; these are the ones this build writes.
 */
export const RUN_END_REASONS = [
  'project_closed',
  'task_finished',
  'deliverable_removed',
  'server_stopping',
  'server_restarted',
] as const;
export type RunEndReason = (typeof RUN_END_REASONS)[number];

/** A TCP port a run listens on. */
export const Port = z.number().int().min(1).max(65_535);

/** The newest run of a command deliverable, as the world folds it (`Deliverable.lastRun`). */
export const RunSummary = z.object({
  runId: Id,
  state: RunState,
  startedAt: Timestamp,
  endedAt: Timestamp.optional(),
  outcome: RunOutcome.optional(),
  exitCode: z.number().int().optional(),
  signal: z.string().min(1).optional(),
  reason: z.string().min(1).optional(),
  ports: z.array(Port),
});
export type RunSummary = z.infer<typeof RunSummary>;

/**
 * One run of a command (`deliverable_runs`, TECHNOLOGY §9.1): the run history a REST read lists
 * (`GET /api/deliverables/:id/runs`). A projection of `run.*` events, written with them.
 */
export const DeliverableRun = z.object({
  id: Id,
  deliverableId: Id,
  /** The command as the user confirmed (or edited) it for this run. */
  line: z.string().min(1),
  cwd: z.string().min(1),
  state: RunState,
  startedAt: Timestamp,
  endedAt: Timestamp.optional(),
  outcome: RunOutcome.optional(),
  exitCode: z.number().int().optional(),
  signal: z.string().min(1).optional(),
  reason: z.string().min(1).optional(),
  ports: z.array(Port),
  startedBy: Actor,
  stoppedBy: Actor.optional(),
  meta: Meta.optional(),
});
export type DeliverableRun = z.infer<typeof DeliverableRun>;

/** A title and a description, as agents may write them (decision 120's defaults). */
export const DELIVERABLE_TITLE_MAX = 120;
export const DELIVERABLE_DESCRIPTION_MAX = 2_000;

/**
 * A deliverable (decision 118; TECHNOLOGY §9.1). It belongs to a task (`taskId`, plus the task's
 * `projectId` when the task is a project's) or to a project (`projectId` only). `version` grows on
 * every change of the row's own fields (`deliverable.updated` / `removed` / `restored`): it is the
 * stale check of a run's confirmation (decision 129). `lastRun` is folded from `run.*` and does
 * not change `version` or `updatedAt`. A removed row stays (`removedAt`), so the history keeps it
 * (decision 132).
 */
export const Deliverable = z.object({
  id: Id,
  projectId: Id.optional(),
  taskId: Id.optional(),
  kind: DeliverableKind,
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  source: DeliverableSource,
  addedBy: Actor,
  location: DeliverableLocation.optional(),
  command: DeliverableCommand.optional(),
  url: z.string().min(1).optional(),
  /** A detected command's or folder's key (`package.json#dev`, `folder`), unique per project. */
  detectedKey: z.string().min(1).optional(),
  version: z.number().int().positive(),
  removedAt: Timestamp.optional(),
  removedBy: Actor.optional(),
  removedReason: z.string().min(1).optional(),
  lastRun: RunSummary.optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  /**
   * What is not worth a column (TECHNOLOGY §9.1): `size` and `mtime` at declaration, a detected
   * script's `important` rank, `confirmedOpen{fingerprint, at, by}` (decision 128), `copy{bytes}`.
   */
  meta: Meta.optional(),
});
export type Deliverable = z.infer<typeof Deliverable>;

/**
 * What `deliverable.updated` may change. An absent key is unchanged, an explicit `null` clears one
 * of `CLEARABLE_DELIVERABLE_FIELDS`, like `project.updated` (P2-20). `projectId` changes only when
 * the deliverable's task moves to another project (decision 124); `meta` is the whole new value.
 */
export const DeliverableChanges = Deliverable.pick({
  projectId: true,
  kind: true,
  title: true,
})
  .extend({
    description: z.string().min(1).nullable(),
    location: DeliverableLocation.nullable(),
    command: DeliverableCommand.nullable(),
    url: z.string().min(1).nullable(),
    meta: Meta.nullable(),
  })
  .partial();
export type DeliverableChanges = z.infer<typeof DeliverableChanges>;

export const CLEARABLE_DELIVERABLE_FIELDS = [
  'description',
  'location',
  'command',
  'url',
  'meta',
] as const;

/** Whether a deliverable is listed as current (not removed). */
export const isActiveDeliverable = (d: Pick<Deliverable, 'removedAt'>): boolean =>
  d.removedAt === undefined;

/** Whether a deliverable's command has a run that has not ended (as the world knows it). */
export const isRunLive = (d: Pick<Deliverable, 'lastRun'>): boolean =>
  d.lastRun !== undefined && d.lastRun.state !== 'ended';

/** An address a `url` deliverable may hold: `http` or `https` only (decision 121). */
export function isDeliverableUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * What the row must hold for its kind: a path kind its `location`, a command its `command`, an
 * address its `url` (http/https), and nothing of the others. `undefined` when it is consistent,
 * else why not (the command's refusal text).
 */
export function deliverableShapeError(
  d: Pick<Deliverable, 'kind' | 'location' | 'command' | 'url' | 'projectId' | 'taskId'>,
): string | undefined {
  if (!d.projectId && !d.taskId) return 'a deliverable belongs to a project or a task';
  const wants = PATH_KINDS.has(d.kind) ? 'location' : d.kind === 'command' ? 'command' : 'url';
  if (wants === 'location' && !d.location) return `a ${d.kind} deliverable needs a path`;
  if (wants === 'command' && !d.command) return 'a command deliverable needs a command line';
  if (wants === 'url' && !d.url) return 'a url deliverable needs an address';
  if (wants !== 'location' && d.location) return `a ${d.kind} deliverable has no path`;
  if (wants !== 'command' && d.command) return `a ${d.kind} deliverable has no command line`;
  if (wants !== 'url' && d.url) return `a ${d.kind} deliverable has no address`;
  if (d.url && !isDeliverableUrl(d.url)) return 'an address is http or https only';
  if (d.location && !d.location.path.startsWith('/')) return 'a path is absolute';
  if (d.location?.originalPath !== undefined && !d.location.originalPath.startsWith('/')) {
    return 'a path is absolute';
  }
  if (d.command && !d.command.cwd.startsWith('/')) return "a command's folder is absolute";
  return undefined;
}

// ---------------------------------------------------------------------------
// REST bodies (TECHNOLOGY §9.6–§9.8). The routes are P9-05, P9-07 and P9-08's; the shapes live
// here so the panel and the server share them.
// ---------------------------------------------------------------------------

const flagParam = z
  .enum(['0', '1', 'true', 'false'])
  .transform((v) => v === '1' || v === 'true')
  .optional();

/** `GET /api/deliverables?projectId=&taskId=&removed=`. */
export const DeliverablesQuery = z.object({
  projectId: Id.optional(),
  taskId: Id.optional(),
  /** Include removed rows ("Show removed", the history inspector). */
  removed: flagParam,
});
export type DeliverablesQuery = z.input<typeof DeliverablesQuery>;

/**
 * A path deliverable's file facts, computed on every read and never stored (TECHNOLOGY §9.2):
 * whether it is there, its size and time, what the viewer can show, and whether opening it would
 * run code (decision 128).
 */
export const DeliverableFacts = z.object({
  exists: z.boolean(),
  /** Why it cannot be read (`missing`, `outside`, `changed`, …) when `exists` is false. */
  problem: z.string().min(1).optional(),
  isDirectory: z.boolean().optional(),
  size: z.number().int().nonnegative().optional(),
  mtime: Timestamp.optional(),
  kindGuess: z.enum(['text', 'image', 'pdf', 'binary', 'folder']).optional(),
  /** The preview content type the viewer gets (a fixed table, TECHNOLOGY §9.6). */
  contentType: z.string().min(1).optional(),
  runsCode: z.boolean().optional(),
});
export type DeliverableFacts = z.infer<typeof DeliverableFacts>;

/** One row of the list: the deliverable plus its live facts (path kinds only). */
export const DeliverableListItem = Deliverable.extend({ facts: DeliverableFacts.optional() });
export type DeliverableListItem = z.infer<typeof DeliverableListItem>;

export const DeliverablesResponse = z.object({
  deliverables: z.array(DeliverableListItem),
  /** The project's (or standalone task's) `deliverables/` folder, once made (decision 122). */
  folder: z.string().min(1).optional(),
});
export type DeliverablesResponse = z.infer<typeof DeliverablesResponse>;

/** `POST /api/deliverables` (by hand, decision 121): one of `path`, `command`, `url`. */
export const AddDeliverableBody = z
  .object({
    projectId: Id.optional(),
    taskId: Id.optional(),
    kind: DeliverableKind,
    title: z.string().trim().min(1).max(DELIVERABLE_TITLE_MAX),
    description: z.string().trim().min(1).max(DELIVERABLE_DESCRIPTION_MAX).optional(),
    path: z.string().min(1).optional(),
    command: z.object({ line: z.string().min(1), cwd: z.string().min(1).optional() }).optional(),
    url: z.string().min(1).optional(),
  })
  .refine((b) => b.projectId !== undefined || b.taskId !== undefined, {
    message: 'a deliverable belongs to a project or a task',
  });
export type AddDeliverableBody = z.infer<typeof AddDeliverableBody>;

/** `PATCH /api/deliverables/:id`: the user's edit, against the `version` the panel showed. */
export const EditDeliverableBody = z.object({
  version: z.number().int().positive(),
  title: z.string().trim().min(1).max(DELIVERABLE_TITLE_MAX).optional(),
  description: z.string().trim().min(1).max(DELIVERABLE_DESCRIPTION_MAX).nullable().optional(),
  command: z.object({ line: z.string().min(1) }).optional(),
  url: z.string().min(1).optional(),
});
export type EditDeliverableBody = z.infer<typeof EditDeliverableBody>;

/** `POST /api/deliverables/:id/remove` (the files stay, decision 122). */
export const RemoveDeliverableBody = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
});
export type RemoveDeliverableBody = z.infer<typeof RemoveDeliverableBody>;

/** How a deliverable is opened on the Mac (decision 127): `deliverable.opened{action}`. */
export const OpenAction = z.enum(['open', 'reveal', 'ide', 'app']);
export type OpenAction = z.infer<typeof OpenAction>;

/** `POST /api/deliverables/:id/open`; `fingerprint` confirms an application (decision 128). */
export const OpenDeliverableBody = z.object({
  action: OpenAction,
  fingerprint: z.string().min(1).max(200).optional(),
});
export type OpenDeliverableBody = z.infer<typeof OpenDeliverableBody>;

/** The 409 an application's first (or changed) open answers: what the dialog asks about. */
export const OpenConfirmation = z.object({
  code: z.literal('confirm'),
  fingerprint: z.string().min(1),
  addedBy: Actor,
  name: z.string().min(1),
});
export type OpenConfirmation = z.infer<typeof OpenConfirmation>;

/**
 * `POST /api/deliverables/folder/reveal`: Reveal in Finder for a project's (or a standalone
 * task's) `deliverables/` folder (decision 122), which is not a deliverable of its own. The server
 * finds the recorded folder itself; the request never names a path. Mac only, never remote.
 */
export const RevealFolderBody = z
  .object({ projectId: Id.optional(), taskId: Id.optional() })
  .refine((b) => (b.projectId === undefined) !== (b.taskId === undefined), {
    message: 'a project or a task',
  });
export type RevealFolderBody = z.infer<typeof RevealFolderBody>;

/** `POST /api/deliverables/:id/download` → a one-time link (decision 126). */
export const DownloadTicketResponse = z.object({ url: z.string().startsWith('/files/') });
export type DownloadTicketResponse = z.infer<typeof DownloadTicketResponse>;

/**
 * `POST /api/deliverables/:id/runs` and `POST /api/runs/:id/restart` (decision 129): the confirmed
 * version, the line edited for this run, and the preview's `confirmation` for exactly that line
 * (the stored one when `line` is absent) — a token bound to the deliverable, its version and the
 * line's hash, so a start never runs a line the dialog did not show (wave-3 review S3). An edited
 * line is one line: no newline or other control character (400 `invalid`).
 */
export const StartRunBody = z.object({
  version: z.number().int().positive(),
  line: z.string().min(1).max(10_000).optional(),
  confirmation: z.string().min(1).max(256),
});
export type StartRunBody = z.infer<typeof StartRunBody>;

/**
 * `POST /api/deliverables/:id/run-preview {line?}`: the preview of the line the user edited in the
 * dialog (its warnings and its `confirmation`); without `line`, the stored one (as `GET`).
 */
export const RunPreviewBody = z.object({
  line: z.string().min(1).max(10_000).optional(),
});
export type RunPreviewBody = z.infer<typeof RunPreviewBody>;

/** `POST /api/deliverables/:id/runs` → the run that started. */
export const StartRunResponse = z.object({ run: DeliverableRun });
export type StartRunResponse = z.infer<typeof StartRunResponse>;

/**
 * Why a run cannot start now, as the preview reports it before the user confirms (and the start
 * answers it): `after_merge` (the command's folder is a task's worktree — "available after the
 * merge"), `running` (one run per command), `run_cap` (`deliverables.runs.maxConcurrent`),
 * `folder` (the folder no longer passes the path rules), `removed`.
 */
export const RunRefusal = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});
export type RunRefusal = z.infer<typeof RunRefusal>;

/** `GET /api/deliverables/:id/run-preview`: what the confirmation shows (decision 129). */
export const RunPreviewResponse = z.object({
  deliverableId: Id,
  version: z.number().int().positive(),
  /** The line the run would execute, redacted (`[redacted:…]` where a secret was). */
  line: z.string().min(1),
  cwd: z.string().min(1),
  /** The environment's keys, never their values. */
  envKeys: z.array(z.string()),
  /** The permission engine's reading of the line ("deletes files", "uses the network", …). */
  warnings: z.array(z.string()),
  /** The engine's own lines behind the warnings (what it read where), for a "details" toggle. */
  reasons: z.array(z.string()).optional(),
  source: DeliverableSource,
  addedBy: Actor,
  /** The file a detected command was found in (`package.json`, `Makefile`, …). */
  detectedFrom: z.string().min(1).optional(),
  /**
   * What a detected command runs as its file says it now (`meta.detected.body`: the script, rule
   * or recipe body, redacted; P9-05). For display only: the run executes `line`.
   */
  body: z.string().optional(),
  /**
   * The body differs from the one the command's last run was confirmed with (wave-2 review S4):
   * "changed since the last run". Absent when there was no run with a body, or none at all.
   */
  bodyChanged: z.boolean().optional(),
  /** The body the last run was confirmed with, when it differs from `body`. */
  lastRunBody: z.string().optional(),
  /** Set when a start now would be refused (the dialog says why and offers no Run). */
  refusal: RunRefusal.optional(),
  /**
   * What the start (or restart) sends back to confirm exactly this `line` at this `version`
   * (wave-3 review S3): opaque, valid for 15 minutes and for this server run only.
   */
  confirmation: z.string().min(1).optional(),
});
export type RunPreviewResponse = z.infer<typeof RunPreviewResponse>;

/** `GET /api/deliverables/:id/runs`: newest first. */
export const RunsResponse = z.object({ runs: z.array(DeliverableRun) });
export type RunsResponse = z.infer<typeof RunsResponse>;

/** One batch of a run's output (`run_output`), redacted before it is stored. */
export const RunOutputChunk = z.object({
  runId: Id,
  seq: z.number().int().positive(),
  at: Timestamp,
  chunk: z.string(),
});
export type RunOutputChunk = z.infer<typeof RunOutputChunk>;

/** `GET /api/runs/:id/output?after=&limit=`. */
export const RunOutputQuery = z.object({
  after: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(5_000).default(1_000),
});
export type RunOutputQuery = z.input<typeof RunOutputQuery>;

export const RunOutputResponse = z.object({
  runId: Id,
  chunks: z.array(RunOutputChunk),
  /** Older output was dropped past the size limit (decision 130): "earlier output dropped". */
  truncatedBefore: z.number().int().nonnegative().optional(),
  hasMore: z.boolean(),
});
export type RunOutputResponse = z.infer<typeof RunOutputResponse>;

/** `GET /api/deliverables/usage`: each project's `deliverables/` folder size (decision 122). */
export const DeliverablesUsageResponse = z.object({
  folders: z.array(
    z.object({
      projectId: Id.optional(),
      taskId: Id.optional(),
      path: z.string().min(1),
      bytes: z.number().int().nonnegative(),
    }),
  ),
});
export type DeliverablesUsageResponse = z.infer<typeof DeliverablesUsageResponse>;
