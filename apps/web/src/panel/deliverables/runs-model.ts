import {
  isActiveDeliverable,
  isRunLive,
  type Deliverable,
  type DeliverableRun,
  type Id,
  type RunPreviewResponse,
  type RunSummary,
} from '@galactic/protocol';
import { ApiError } from '../../console/api.js';
import type { WorldState } from '../../state/reduce.js';
import type { ClientRules } from './deliverables-model.js';
import { runStateText } from './deliverables-model.js';

/**
 * The panel's runs, pure (P9-10; SPEC decisions 129–131, 134; TECHNOLOGY §9.8): which run actions
 * a command row offers on this client, the Run dialog's choices (where the focus starts, whether
 * Run may be sent, what a refusal says), the ports as addresses, the run history's words, and the
 * Deliverables view's running count. No React, no fetch.
 */

// --- actions -----------------------------------------------------------------------------------

export type RunAction = 'run' | 'stop' | 'restart';

export interface RunActions {
  /** Offered here. */
  actions: RunAction[];
  /** Run and Restart on the phone: shown as "on the Mac" (decision 131). */
  macOnly: RunAction[];
}

/**
 * A command row's run actions (decisions 129–131): Run while no run lives, Stop and Restart while
 * one does — Run and Restart on the Mac only (they start a program there), Stop everywhere (it
 * only ends what the Mac started). A removed row has none.
 */
export function runActions(
  row: Pick<Deliverable, 'kind' | 'command' | 'removedAt'>,
  lastRun: RunSummary | undefined,
  rules: Pick<ClientRules, 'local'>,
): RunActions {
  if (row.kind !== 'command' || !row.command || !isActiveDeliverable(row)) {
    return { actions: [], macOnly: [] };
  }
  const live = lastRun !== undefined && lastRun.state !== 'ended';
  const out: RunAction[] = [];
  const mac: RunAction[] = [];
  const mine = (a: RunAction) => (rules.local ? out.push(a) : mac.push(a));
  if (!live) mine('run');
  if (live && lastRun.state !== 'stopping') out.push('stop');
  if (live) mine('restart');
  return { actions: out, macOnly: mac };
}

// --- the dialog --------------------------------------------------------------------------------

/**
 * Where the Run dialog puts the focus once the preview is read (P9-10, recorded in TECHNOLOGY
 * §9.8): on **Cancel** when the engine read a warning in the line or the script's body changed
 * since the last run — the user has to move to Run on purpose — else on **Run**. Enter in the
 * command field never runs (it re-reads the line).
 */
export function initialFocus(preview: Pick<RunPreviewResponse, 'warnings' | 'bodyChanged'>) {
  return preview.warnings.length > 0 || preview.bodyChanged === true ? 'cancel' : 'run';
}

/** The refusals a restart does not count: the run it replaces is the command's live run. */
const RESTART_IGNORES = new Set(['running', 'run_cap']);

/** The preview's refusal that stops this dialog from offering its button, if any. */
export function blockingRefusal(
  preview: Pick<RunPreviewResponse, 'refusal'>,
  mode: 'run' | 'restart',
): RunPreviewResponse['refusal'] {
  const r = preview.refusal;
  if (!r) return undefined;
  if (mode === 'restart' && RESTART_IGNORES.has(r.code)) return undefined;
  return r;
}

/** The words of a refusal the dialog shows, by code (TECHNOLOGY §9.8's refusals). */
const REFUSAL_TEXT: Record<string, string> = {
  stale:
    'The command changed since the dialog opened. The dialog now shows the new one: read it again before you run it.',
  unconfirmed:
    'The confirmation ran out or does not cover this line (it is good for 15 minutes). The command was read again: check it and run again.',
  running: 'This command is already running: stop it first.',
  after_merge:
    'Available after the merge: the command is still only in a task’s worktree, and runs only in the project’s folder.',
  folder:
    'Its folder is no longer one a run may use (moved, or replaced by a link): runs happen in the project’s folder or its deliverables folder only.',
  remote_control: 'Commands are run from the Mac only.',
  not_found: 'This command is not there any more.',
  removed: 'This command was removed.',
};

/**
 * What a refused start, restart, stop or preview says (by the server's code, or its HTTP status
 * for a refused write: 507 the disk is full, 503 the database is not taking writes — decision 107).
 * `run_cap`, `invalid` and `start_failed` keep the server's own words (the cap's number, what is
 * wrong with the line, why it could not start).
 */
export function refusalText(error: unknown): string {
  if (!(error instanceof ApiError)) return (error as Error)?.message ?? String(error);
  if (error.status === 507) {
    return 'The disk is full: Mission Control could not note the run, so it did not start. Free some space and try again.';
  }
  if (error.status === 503) {
    return 'Mission Control cannot write to its database right now, so the run did not start. Try again shortly.';
  }
  const code = error.code ?? '';
  if (code === 'run_cap') return error.message || 'Too many runs at once: stop one first.';
  return REFUSAL_TEXT[code] ?? error.message;
}

/** A preview's refusal in the dialog's words. */
export const previewRefusalText = (r: { code: string; message: string }): string =>
  r.code === 'run_cap' ? r.message : (REFUSAL_TEXT[r.code] ?? r.message);

/** Who added the command, as the dialog says it (decision 129). */
export function addedByLine(
  preview: Pick<RunPreviewResponse, 'source' | 'detectedFrom'>,
  who: string,
): string {
  if (preview.source === 'detected') {
    return preview.detectedFrom ? `found in ${preview.detectedFrom}` : 'found in the project';
  }
  if (preview.source === 'user') return 'added by you';
  return `declared by ${who}`;
}

/** A piece of a command line as the Run dialog shows it (P9-12 review S1). */
export interface LineSegment {
  text: string;
  /** Something the eye would miss: shown as a marked placeholder, `title` saying what it is. */
  odd?: { title: string };
}

/** A character the dialog never shows as is: control, format, separator, odd space. */
// eslint-disable-next-line no-control-regex -- making control characters visible is the point
const ODD = /[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}]|[^\P{Zs} ]/u;

/** Runs of spaces at least this long are shown as `␠×n`. */
export const SPACE_RUN = 3;

/**
 * A command line cut into what the dialog shows as is and what it makes visible (P9-12 review
 * S1): a run of `SPACE_RUN` or more spaces as `␠×n` (a payload pushed past the field's edge),
 * a tab as `⇥`, and any control, format (bidi, zero-width), separator or other non-plain space
 * character as `⟨U+XXXX⟩` — the server refuses those in a stored line, so they only show in a
 * line kept from before, but the dialog never shows them invisibly.
 */
export function lineSegments(line: string): LineSegment[] {
  const out: LineSegment[] = [];
  let plain = '';
  const flush = () => {
    if (plain) out.push({ text: plain });
    plain = '';
  };
  const chars = [...line];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (c === ' ') {
      let n = 1;
      while (chars[i + n] === ' ') n++;
      if (n >= SPACE_RUN) {
        flush();
        out.push({ text: `␠×${n}`, odd: { title: `${n} spaces` } });
        i += n - 1;
      } else {
        plain += ' '.repeat(n);
        i += n - 1;
      }
      continue;
    }
    if (c === '\t') {
      flush();
      out.push({ text: '⇥', odd: { title: 'a tab' } });
      continue;
    }
    if (ODD.test(c)) {
      flush();
      const code = c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
      out.push({ text: `⟨U+${code}⟩`, odd: { title: `an invisible character (U+${code})` } });
      continue;
    }
    plain += c;
  }
  flush();
  return out;
}

/**
 * The body's lines, each marked when it is not in the last run's body ("changed since the last
 * run", P9-08's `bodyChanged`). Without a last body nothing is marked.
 */
export function bodyLines(
  body: string,
  lastRunBody: string | undefined,
): { text: string; changed: boolean }[] {
  const before = lastRunBody === undefined ? undefined : new Set(lastRunBody.split('\n'));
  return body.split('\n').map((text) => ({ text, changed: before ? !before.has(text) : false }));
}

/** The preview's warnings worth a line (blank ones dropped). */
export const warningsOf = (preview: Pick<RunPreviewResponse, 'warnings'>): string[] =>
  preview.warnings.filter((w) => w.trim() !== '');

// --- ports -------------------------------------------------------------------------------------

/** A port a run listens on, as an address on the Mac (decision 130): `http://localhost:<port>`. */
export const portUrl = (port: number): string => `http://localhost:${port}`;

// --- history -----------------------------------------------------------------------------------

/** "3 s", "2 min 5 s", "1 h 4 min": how long a run lasted (or has lasted, `now`). */
export function durationText(startedAt: string, endedAt: string | undefined, now = Date.now()) {
  const ms = (endedAt ? Date.parse(endedAt) : now) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min${s % 60 ? ` ${s % 60} s` : ''}`;
  const h = Math.floor(m / 60);
  return `${h} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

/** A run of the history as the run summary `runStateText` reads. */
export const summaryOf = (run: DeliverableRun): RunSummary => ({
  runId: run.id,
  state: run.state,
  startedAt: run.startedAt,
  ...(run.endedAt ? { endedAt: run.endedAt } : {}),
  ...(run.outcome ? { outcome: run.outcome } : {}),
  ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
  ...(run.signal ? { signal: run.signal } : {}),
  ...(run.reason ? { reason: run.reason } : {}),
  ports: run.ports,
});

/** One line of the history: its outcome, how long it lasted, its ports. */
export function historyText(run: DeliverableRun, now = Date.now()): string {
  const state = runStateText({ ...summaryOf(run), ports: [] });
  const took = durationText(run.startedAt, run.endedAt, now);
  const ports = run.ports.length > 0 ? ` · ${run.ports.map((p) => `:${p}`).join(' ')}` : '';
  return `${state}${took ? ` · ${took}` : ''}${ports}`;
}

/** Whether the run's line differs from the command as stored now (edited for that run). */
export const wasEdited = (run: DeliverableRun): boolean => run.meta?.['edited'] === true;

// --- the Deliverables view's indicator -----------------------------------------------------------

/**
 * How many commands of a project (its own and its tasks') have a live run (decision 133's "▶"
 * for the panel: the dock switch's Deliverables shows it).
 */
export function liveRunCount(world: Pick<WorldState, 'deliverables'>, projectId: Id): number {
  let n = 0;
  for (const d of Object.values(world.deliverables ?? {})) {
    if (d.projectId === projectId && isActiveDeliverable(d) && isRunLive(d)) n += 1;
  }
  return n;
}

/** ANSI escape sequences (colours, cursor moves, OSC links) removed, carriage returns folded. */
export function stripAnsi(text: string): string {
  /* eslint-disable no-control-regex -- escape sequences are what this removes */
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC … BEL / ST
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // CSI
    .replace(/\x1b[@-Z\\-_]/g, '') // other two-byte escapes
    .replace(/[^\n]*\r(?!\n)/g, '') // a line redrawn after a carriage return: its last state
    .replace(/\r\n/g, '\n');
  /* eslint-enable no-control-regex */
}
