import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import type {
  Actor,
  AddDeliverableInput,
  CommandResult,
  Deliverable,
  DeliverableEdit,
  DeliverableWriteOptions,
  Id,
} from '@galactic/protocol';
import type { Tables } from '../db/tables.js';
import { workspaceMeta } from '../workspace/workspaces.js';
import {
  MANIFEST_FILES,
  MAX_DETECTED_COMMANDS,
  detectCommands,
  type DetectedCommand,
  type DetectionProblem,
  type ReadResult,
} from './detect.js';

/**
 * The scan service (P9-05; TECHNOLOGY §9.3, SPEC decision 119): keeps a project's detected
 * deliverables — its folder (`detected_key = 'folder'`) and the run scripts at the top of its
 * folder — in step with what is on disk. A scan reads the manifest files as text (`detect.ts`,
 * nothing executed), diffs against the project's detected rows and writes through the domain
 * commands as `system`:
 *
 * - a new key → `deliverable.added`;
 * - a key whose detected line, title or description changed → `deliverable.updated` (compared
 *   with what the last scan wrote, `meta.detected`, so the user's own edit of a row stays until
 *   the file itself changes);
 * - a key no longer found → `deliverable.removed{reason: 'no longer in <file>'}`;
 * - a key the scan had removed and finds again → `deliverable.restored` (and updated);
 * - a row **the user removed is never added, restored or changed again** (decision 119): the
 *   unique `(project_id, detected_key)` index keeps it, removed, and "Show removed" → Restore is
 *   the only way back;
 * - a file that cannot be read or parsed adds nothing and keeps the rows it gave before (a
 *   half-saved `package.json` does not empty the list); its problem is logged once.
 *
 * Triggers: the project's folder prepared (`Workspaces.prepareProject`), every successful merge
 * (`Workspaces.mergeTask`), the panel's Rescan (`detectProject`), and once at startup for every
 * prepared, unarchived project (`detectAll`, staggered). At most one scan per project
 * per `minIntervalMs` (10 s): a call inside the window waits for its end and shares that scan.
 * A scan never throws: what fails is in its result.
 */

/** The folder deliverable's key. */
export const FOLDER_KEY = 'folder';

/** A manifest file larger than this is not read (it adds nothing). */
export const MAX_MANIFEST_BYTES = 1024 * 1024;

/** At most one scan per project in this window (TECHNOLOGY §9.3). */
export const SCAN_INTERVAL_MS = 10_000;

/** The pause between two projects' scans of the startup pass (TECHNOLOGY §9.3). */
export const STARTUP_GAP_MS = 250;

const SYSTEM: Actor = { type: 'system' };

/** The commands the scan writes through (`Commands`). */
export interface DetectionCommands {
  addDeliverable(
    input: AddDeliverableInput,
    by: Actor,
    write?: DeliverableWriteOptions,
  ): Promise<CommandResult<Deliverable>>;
  updateDeliverable(
    deliverableId: Id,
    changes: DeliverableEdit,
    by: Actor,
    write?: DeliverableWriteOptions,
  ): Promise<CommandResult<Deliverable>>;
  removeDeliverable(
    deliverableId: Id,
    by: Actor,
    reason?: string,
    write?: DeliverableWriteOptions,
  ): Promise<CommandResult<Deliverable>>;
  restoreDeliverable(
    deliverableId: Id,
    by: Actor,
    write?: DeliverableWriteOptions,
  ): Promise<CommandResult<Deliverable>>;
}

/** The file-system calls a scan makes. */
export interface ScanFs {
  /** Every symlink followed; on-disk names. */
  realpath(path: string): string;
  isDirectory(path: string): boolean;
  readdir(path: string): string[];
  /**
   * Reads a top-level file: never through a symlink (`O_NOFOLLOW`), a regular file only, at most
   * `maxBytes` (a larger one is a problem, not a partial read).
   */
  readText(path: string, maxBytes: number): ReadResult;
}

export const nodeScanFs: ScanFs = {
  realpath: (p) => nodeFs.realpathSync.native(p),
  isDirectory: (p) => {
    try {
      return nodeFs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  readdir: (p) => nodeFs.readdirSync(p),
  readText: (path, maxBytes) => {
    const { O_RDONLY, O_NONBLOCK, O_NOFOLLOW } = nodeFs.constants;
    let fd: number;
    try {
      fd = nodeFs.openSync(path, O_RDONLY | O_NONBLOCK | O_NOFOLLOW);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        ok: false,
        reason:
          code === 'ELOOP' ? 'is a symbolic link (not followed)' : `cannot be opened (${code})`,
      };
    }
    try {
      const stat = nodeFs.fstatSync(fd);
      if (!stat.isFile()) return { ok: false, reason: 'is not a regular file' };
      if (stat.size > maxBytes) {
        return { ok: false, reason: `is larger than ${Math.round(maxBytes / 1024)} KiB` };
      }
      const buffer = Buffer.alloc(maxBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const n = nodeFs.readSync(fd, buffer, length, buffer.length - length, length);
        if (n === 0) break;
        length += n;
      }
      if (length > maxBytes) {
        return { ok: false, reason: `is larger than ${Math.round(maxBytes / 1024)} KiB` };
      }
      return { ok: true, text: buffer.subarray(0, length).toString('utf8') };
    } catch (error) {
      return { ok: false, reason: `cannot be read (${(error as NodeJS.ErrnoException).code})` };
    } finally {
      nodeFs.closeSync(fd);
    }
  },
};

/** What a scan did. */
export interface ScanResult {
  projectId: Id;
  /** False when the project was not scanned (`skipped` says why). */
  scanned: boolean;
  skipped?: string;
  added: Id[];
  updated: Id[];
  removed: Id[];
  restored: Id[];
  /** Commands detected past the cap of 50: counted, not listed. */
  overflow: number;
  /** Manifest files present that could not be read or parsed, and rows that could not be written. */
  problems: DetectionProblem[];
}

export interface DetectionOptions {
  tables: Tables;
  commands: DetectionCommands;
  fs?: ScanFs;
  /** Default `SCAN_INTERVAL_MS`; tests pass 0. */
  minIntervalMs?: number;
  /** Default `MAX_MANIFEST_BYTES`. */
  maxFileBytes?: number;
  /** Milliseconds; default `Date.now`. */
  now?: () => number;
  /** Default `setTimeout` / `clearTimeout`. */
  timers?: {
    set(fn: () => void, ms: number): unknown;
    clear(handle: unknown): void;
  };
  /** A problem worth a log line (each one once per project and file). */
  onProblem?: (message: string) => void;
}

/** What the scan wrote last for a detected row (`meta.detected`). */
interface DetectedMeta {
  line?: string;
  title: string;
  description?: string;
  path?: string;
}

interface ProjectState {
  last?: number;
  running?: Promise<ScanResult> | undefined;
  pending?: Promise<ScanResult> | undefined;
}

function keyFile(key: string): string {
  const i = key.indexOf('#');
  return i === -1 ? key : key.slice(0, i);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ProjectDetection {
  private readonly tables: Tables;
  private readonly commands: DetectionCommands;
  private readonly fs: ScanFs;
  private readonly minIntervalMs: number;
  private readonly maxFileBytes: number;
  private readonly now: () => number;
  private readonly timers: NonNullable<DetectionOptions['timers']>;
  private readonly onProblem: (message: string) => void;
  private readonly states = new Map<Id, ProjectState>();
  private readonly sleeping = new Map<unknown, () => void>();
  private readonly logged = new Set<string>();
  private disposed = false;

  constructor(opts: DetectionOptions) {
    this.tables = opts.tables;
    this.commands = opts.commands;
    this.fs = opts.fs ?? nodeScanFs;
    this.minIntervalMs = opts.minIntervalMs ?? SCAN_INTERVAL_MS;
    this.maxFileBytes = opts.maxFileBytes ?? MAX_MANIFEST_BYTES;
    this.now = opts.now ?? Date.now;
    this.timers = opts.timers ?? {
      set: (fn, ms) => setTimeout(fn, ms),
      clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
    this.onProblem = opts.onProblem ?? (() => {});
  }

  /**
   * Scans the project's folder and brings its detected deliverables in step (the folder and the
   * run scripts). Within `minIntervalMs` of the last scan the call waits for the window's end;
   * calls made meanwhile share that one scan. Never rejects.
   */
  detectProject(projectId: Id): Promise<ScanResult> {
    const state = this.states.get(projectId) ?? {};
    this.states.set(projectId, state);
    if (state.pending) return state.pending;
    const pending = (async (): Promise<ScanResult> => {
      await null; // `state.pending` is set before anything below runs.
      if (state.running) await state.running;
      const wait = state.last === undefined ? 0 : state.last + this.minIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      state.pending = undefined;
      if (this.disposed) return this.skipped(projectId, 'the server is stopping');
      const run = this.scan(projectId);
      state.running = run;
      try {
        return await run;
      } finally {
        state.last = this.now();
        if (state.running === run) state.running = undefined;
      }
    })();
    state.pending = pending;
    return pending;
  }

  /** The projects a scan reads: prepared (decision 27) and not archived. */
  scannable(): Id[] {
    return this.tables.projects
      .all()
      .filter((p) => p.state !== 'archived' && workspaceMeta(p) !== undefined)
      .map((p) => p.id);
  }

  /**
   * The startup pass (TECHNOLOGY §9.3, decision 119): every scannable project once, one after the
   * other with `gapMs` between two scans, so a large map does not hold the server's first seconds.
   * What changed on disk while the server was down is then listed without a Rescan. Stops when
   * disposed (the rest resolve as skipped); never rejects.
   */
  async detectAll(opts: { gapMs?: number } = {}): Promise<ScanResult[]> {
    const gap = opts.gapMs ?? STARTUP_GAP_MS;
    const results: ScanResult[] = [];
    for (const [i, projectId] of this.scannable().entries()) {
      if (this.disposed) break;
      if (i > 0 && gap > 0) await this.sleep(gap);
      if (this.disposed) break;
      results.push(await this.detectProject(projectId));
    }
    return results;
  }

  /** Stops waiting scans (they resolve as skipped); a scan already writing finishes. */
  dispose(): void {
    this.disposed = true;
    for (const [handle, wake] of this.sleeping) {
      this.timers.clear(handle);
      wake();
    }
    this.sleeping.clear();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const handle = this.timers.set(() => {
        this.sleeping.delete(handle);
        resolve();
      }, ms);
      this.sleeping.set(handle, resolve);
    });
  }

  private skipped(projectId: Id, why: string): ScanResult {
    return {
      projectId,
      scanned: false,
      skipped: why,
      added: [],
      updated: [],
      removed: [],
      restored: [],
      overflow: 0,
      problems: [],
    };
  }

  private problem(projectId: Id, file: string, reason: string): void {
    const key = `${projectId}\0${file}\0${reason}`;
    if (this.logged.has(key)) return;
    this.logged.add(key);
    this.onProblem(`detection: project ${projectId}: ${file} ${reason}; it adds nothing`);
  }

  private async scan(projectId: Id): Promise<ScanResult> {
    try {
      return await this.scanNow(projectId);
    } catch (error) {
      this.onProblem(`detection: project ${projectId}: scan failed: ${errorText(error)}`);
      return this.skipped(projectId, `the scan failed: ${errorText(error)}`);
    }
  }

  private async scanNow(projectId: Id): Promise<ScanResult> {
    const project = this.tables.projects.get(projectId);
    if (!project) return this.skipped(projectId, `no project ${projectId}`);
    if (project.state === 'archived') return this.skipped(projectId, 'the project is archived');
    // Only a prepared folder (decision 27): a proposed project's path may not be its yet.
    if (!workspaceMeta(project)) {
      return this.skipped(projectId, "the project's folder is not prepared");
    }
    let dir: string;
    try {
      dir = this.fs.realpath(project.workspace);
    } catch {
      return this.skipped(projectId, `the project's folder ${project.workspace} is missing`);
    }
    if (!this.fs.isDirectory(dir)) {
      return this.skipped(projectId, `the project's folder ${dir} is not a folder`);
    }

    const wanted = new Set(MANIFEST_FILES);
    const entries = this.fs.readdir(dir);
    const detection = detectCommands({
      entries,
      read: (name) =>
        wanted.has(name)
          ? this.fs.readText(join(dir, name), this.maxFileBytes)
          : { ok: false, reason: 'is not a manifest file' },
    });
    for (const p of detection.problems) this.problem(projectId, p.file, p.reason);

    const result: ScanResult = {
      projectId,
      scanned: true,
      added: [],
      updated: [],
      removed: [],
      restored: [],
      overflow: detection.overflow.length,
      problems: [...detection.problems],
    };
    const rows = new Map<string, Deliverable>();
    for (const d of this.tables.deliverables.of({ projectId })) {
      if (d.source === 'detected' && d.detectedKey !== undefined && d.taskId === undefined) {
        rows.set(d.detectedKey, d);
      }
    }
    const write = async (key: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (error) {
        result.problems.push({ file: keyFile(key), reason: errorText(error) });
        this.onProblem(`detection: project ${projectId}: ${key}: ${errorText(error)}`);
      }
    };

    // The folder itself.
    const folder: Wanted = {
      kind: 'folder',
      title: 'Project folder',
      location: { storage: 'in_place', path: dir },
      detected: { title: 'Project folder', path: dir },
    };
    await write(FOLDER_KEY, () => this.keep(projectId, FOLDER_KEY, folder, rows, result));

    // The run scripts.
    const listed = new Set<string>();
    for (const c of detection.commands) {
      listed.add(c.key);
      await write(c.key, () => this.keep(projectId, c.key, this.commandRow(c, dir), rows, result));
    }

    // What is no longer found.
    const failed = new Set(detection.problems.map((p) => p.file));
    const past = new Set(detection.overflow);
    for (const [key, row] of rows) {
      if (key === FOLDER_KEY || listed.has(key) || row.removedAt !== undefined) continue;
      const file = keyFile(key);
      if (failed.has(file)) continue; // unreadable now: keep what it gave before
      const reason = past.has(key)
        ? `more than ${MAX_DETECTED_COMMANDS} commands detected`
        : `no longer in ${file}`;
      await write(key, async () => {
        await this.commands.removeDeliverable(row.id, SYSTEM, reason);
        result.removed.push(row.id);
      });
    }
    return result;
  }

  private commandRow(c: DetectedCommand, cwd: string): Wanted {
    return {
      kind: 'command',
      title: c.title,
      ...(c.description !== undefined ? { description: c.description } : {}),
      command: { line: c.line, cwd, detectedFrom: c.file },
      ...(c.important !== undefined ? { important: c.important } : {}),
      detected: {
        line: c.line,
        title: c.title,
        ...(c.description !== undefined ? { description: c.description } : {}),
        path: cwd,
      },
    };
  }

  /** Adds, restores or updates one detected row (never one the user removed). */
  private async keep(
    projectId: Id,
    key: string,
    want: Wanted,
    rows: Map<string, Deliverable>,
    result: ScanResult,
  ): Promise<void> {
    const row = rows.get(key);
    const meta = {
      detected: want.detected,
      ...(want.important !== undefined ? { important: want.important } : {}),
    };
    if (!row) {
      const added = await this.commands.addDeliverable(
        {
          projectId,
          kind: want.kind,
          title: want.title,
          ...(want.description !== undefined ? { description: want.description } : {}),
          source: 'detected',
          ...(want.location ? { location: want.location } : {}),
          ...(want.command ? { command: want.command } : {}),
          detectedKey: key,
          meta,
        },
        SYSTEM,
      );
      result.added.push(added.value.id);
      return;
    }
    // What the user removed stays removed (decision 119).
    if (row.removedAt !== undefined && row.removedBy?.type !== 'system') return;
    if (row.removedAt !== undefined) {
      await this.commands.restoreDeliverable(row.id, SYSTEM);
      result.restored.push(row.id);
    }
    const last = row.meta?.['detected'] as DetectedMeta | undefined;
    if (JSON.stringify(last) === JSON.stringify(want.detected) && row.kind === want.kind) {
      if (row.meta?.['important'] === want.important) return;
      const updated = await this.commands.updateDeliverable(
        row.id,
        { meta: { important: want.important ?? null } },
        SYSTEM,
      );
      if (updated.events.length > 0) result.updated.push(row.id);
      return;
    }
    // The file changed since the last scan: the detected values replace the row's.
    const updated = await this.commands.updateDeliverable(
      row.id,
      {
        kind: want.kind,
        title: want.title,
        description: want.description ?? null,
        ...(want.location ? { location: want.location } : {}),
        ...(want.command ? { command: want.command } : {}),
        meta: { detected: want.detected, important: want.important ?? null },
      },
      SYSTEM,
    );
    if (updated.events.length > 0) result.updated.push(row.id);
  }
}

/** A detected row as the scan wants it. */
interface Wanted {
  kind: 'folder' | 'command';
  title: string;
  description?: string;
  location?: { storage: 'in_place'; path: string };
  command?: { line: string; cwd: string; detectedFrom: string };
  important?: number;
  detected: DetectedMeta;
}
