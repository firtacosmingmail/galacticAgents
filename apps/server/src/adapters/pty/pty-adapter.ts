import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PTY_TERMINAL_SIZE,
  type Actor,
  type AgentAdapter,
  type AgentEvent,
  type Id,
  type PermissionGate,
  type RuntimePreflight,
  type SendOptions,
  type SpawnHandle,
  type SpawnOptions,
  type StopOptions,
} from '@galactic/protocol';
import { EventQueue } from '../../lib/event-queue.js';
import type {
  ManagedProcess,
  ProcessOutcome,
  ProcessSupervisor,
} from '../../runtime/supervisor.js';
import {
  ALLOW,
  compileClarifications,
  compileIdle,
  compilePatterns,
  detect,
  oneLine,
  type QuestionPattern,
  type QuestionPatternConfig,
} from './detect.js';
import { ptyPreflight } from './preflight.js';
import { loadPty, ptyFork } from './pty-child.js';
import { TerminalText } from './terminal-text.js';

/**
 * The `pty` adapter (P8-08; TECHNOLOGY §3.3): any command-line agent with no machine protocol,
 * run under a pseudo-terminal (`node-pty`) and read like a person would read its screen —
 * "observable but dumb".
 *
 * **One CLI process per session**, started from the configured command through the supervisor's
 * `adopt()` with a `fork` hook that puts it under a PTY (`pty-child.ts`): own process group, PID
 * table, launch intent (P8-11), the `GALACTIC_AGENT_ID` marker, the graceful stop and the group
 * reaping, like every agent process. The terminal is `PTY_TERMINAL_SIZE` (120×32).
 *
 * **Who may run one** (decision 112). A terminal agent's tool calls are invisible: no
 * structured call reaches the permission table, so GalacticAgents cannot judge what it does.
 * Every spawn (and every later message, and every clarification answer) first asks the gate about
 * the session as a whole — an unclassified call `pty:session` with the command line — and runs
 * only when the project's table allows what it cannot classify (the `trusted` preset, or a custom
 * table saying so). A refusal fails the spawn with the reason; later, it ends the agent
 * (`agent.failed`: "the project's permission table no longer allows terminal agents").
 *
 * **The prompt is typed into the terminal**: once the CLI is ready — its idle prompt is on the
 * screen, or it has been quiet for `quietMs` — the first prompt (a Steward's role instructions
 * before it) is typed as one line and Enter; every later message the same way. Newlines become
 * spaces (they would submit early) and every other control character is dropped (`oneLine`), so
 * nothing typed acts as a keystroke.
 *
 * **Long lines.** A terminal in line mode keeps at most 1024 bytes of a line (macOS `MAX_CANON`);
 * the rest is lost. So the first prompt and every message longer than `LONG_LINE` (1000 bytes)
 * go into a file — `<cwd>/.galactic/pty/<session>-<n>.txt`, the directory 0700, the file 0600,
 * removed when the session ends (`.galactic/` is excluded from git) — and the line typed is
 * `Read your instructions from <path>`. When `args` holds `{promptFile}`, the first prompt is
 * written to such a file and its path passed on the command line instead of typing anything.
 * An answer or the user's own line is typed as is (it answers a prompt, a file would not do),
 * with a warning in the transcript when it is that long.
 *
 * **Output.** The raw terminal output (escapes kept) goes to the transcript as `terminal` chunks,
 * batched (≈ every 100 ms or 8 KB), for the terminal view; its text — escapes stripped, `\r`
 * redraws collapsed (`TerminalText`) — as `text` blocks of lines, for the conversation, history
 * and search. The first line of each turn and then one line every `progressEveryMs` become
 * `agent.progress` (the status's current activity).
 *
 * **Status, heuristically.** Output is work (the status store's `touch`); silence past the PTY
 * stall threshold (2 min) is `stalled` (the status store). Once the output has been quiet for
 * `quietMs`, the line the cursor sits on is read (`detect.ts`): the CLI's own prompt
 * (`idlePattern`) ends the turn with `agent.idle`; any question opens a permission-kind question
 * (fail closed: never answered by a brain or the table — it carries no tool call — so the user
 * answers it: on a yes/no prompt "allow" types its yes token, anything else its no token; on a
 * free-form one "allow" presses Enter and anything else interrupts), unless a configured
 * `clarificationPatterns` regex matched it: a clarification, whose answer is typed. With
 * `idleAfterMs`, silence that long also ends a turn.
 * The exit code decides the end: 0 → `agent.finished` (its last lines as the result), another
 * code → `agent.failed(runtime)`, a signal → `agent.failed(crash)`.
 *
 * **A question the CLI moved on from** (more lines came after it — it was not waiting after all)
 * is still answered by whoever answers it, but nothing is typed: the transcript says so.
 *
 * **Interrupt** is Ctrl-C; the turn ends when the idle prompt shows (or the output goes quiet,
 * without an `idlePattern`), at the latest after `interruptIdleMs`. **Pause** is SIGSTOP/SIGCONT
 * on the group. **Stop** is the supervisor's sequence with Ctrl-C then Ctrl-D (end of file) as
 * the hook, then SIGTERM, then SIGKILL.
 *
 * **No resume** (`resumeSession` absent): a terminal session cannot be re-attached, so after a
 * restart the agent stays `interrupted`, and the panel's restart action starts it afresh from
 * its first prompt. **No cost**: nothing is reported, budgets say "cost not reported".
 *
 * **Typing by the user** (`input`): one line into the terminal now, whatever the turn does — the
 * panel offers it on the Mac only (the route refuses remote clients) and the runtime logs it as
 * the user's message (secrets redacted). Typed while the agent is idle, it opens a turn: the
 * screen is read again for questions, and the runtime holds queued messages until it ends.
 */

/** The CLI the adapter starts for every session, and how its screen is read. */
export interface PtyAgentCommand {
  command: string;
  args?: string[];
  /** Server variables the CLI needs on top of the supervisor's allow-list (credentials: by name). */
  passEnv?: string[];
  /** Extra environment (tests). */
  env?: Record<string, string | undefined>;
  /** The CLI's own input prompt, as a regular expression on the cursor's line: the turn is over. */
  idlePattern?: string;
  /** Permission (yes/no) shapes tried before the built-in ones. */
  questionPatterns?: QuestionPatternConfig[];
  /** Prompt lines its supervisor may answer (clarifications); any other question is a permission. */
  clarificationPatterns?: string[];
  /** Silence after which the screen is read (default 750 ms). */
  quietMs?: number;
  /** Silence after which a turn ends with `agent.idle` even without an idle prompt (default off). */
  idleAfterMs?: number;
}

export interface PtyAdapterOptions {
  supervisor: ProcessSupervisor;
  agent: PtyAgentCommand;
  /** How long `stop()` waits for the turn to end after Ctrl-C (default 10 s). */
  graceMs?: number;
  /** Longest wait for the CLI to be ready before the first prompt is typed anyway (default 15 s). */
  readyTimeoutMs?: number;
  /** After Ctrl-C, the turn ends at the latest after this long (default 3 s). */
  interruptIdleMs?: number;
  /** One `agent.progress` at most this often within a turn, after its first (default 30 s). */
  progressEveryMs?: number;
  /** Raw output batch interval (default 100 ms). */
  flushMs?: number;
  /** How long a batch of only `\r` redraws (a spinner) is held (default 1 s). */
  redrawFlushMs?: number;
  onError?: (error: unknown, context: string) => void;
  /** The runtime check (P25-01); default `ptyPreflight(agent)`. */
  preflight?: () => Promise<RuntimePreflight>;
}

/** Names `pty.passEnv` may not carry: the server's own configuration and secrets. */
export const REFUSED_PASS_ENV = /^GALACTIC_/i;

/** Throws when `passEnv` names a variable the CLI may never get (`GALACTIC_*`). */
export function checkPassEnv(passEnv: readonly string[] | undefined): void {
  const refused = (passEnv ?? []).filter((k) => REFUSED_PASS_ENV.test(k));
  if (refused.length > 0) {
    throw new Error(
      `pty.passEnv may not name the server's own variables: ${refused.join(', ')} (GALACTIC_*)`,
    );
  }
}

/** The tool name the session is judged under: one the policy engine does not know. */
export const PTY_SESSION_TOOL = 'pty:session';

const SYSTEM: Actor = { type: 'system' };
const ENDED_MEMORY = 256;
const RAW_BATCH = 8 * 1024;
const TEXT_BLOCK_LINES = 60;
const CONTEXT_LINES = 3;
const RESULT_LINES = 5;
const CTRL_C = '\x03';
const CTRL_D = '\x04';
/** A line longer than this (bytes) goes through a file: line mode keeps 1024 at most. */
export const LONG_LINE = 1000;
/** The `args` placeholder for the first prompt's file. */
export const PROMPT_FILE_PLACEHOLDER = '{promptFile}';
/** The reason a running terminal agent ends when its table stops allowing it (decision 112). */
export const TABLE_NO_LONGER_ALLOWS =
  "the project's permission table no longer allows terminal agents";

type Phase = 'starting' | 'turn' | 'idle';

interface OpenQuestion {
  id: Id;
  kind: 'permission' | 'clarification';
  yes: string;
  no: string;
  /** A permission with no yes/no tokens: allow presses Enter, refuse interrupts. */
  freeform: boolean;
  /** Non-empty lines completed since it was asked: the CLI went on without the answer. */
  movedOn: boolean;
}

/** Whether a raw batch only redraws the cursor's line: a `\r` and no newline. */
export function isRedrawOnly(raw: string): boolean {
  return raw.includes('\r') && !raw.includes('\n');
}

class Session {
  process: ManagedProcess | undefined;
  phase: Phase = 'starting';
  /** The first prompt, typed once the CLI is ready. */
  firstPrompt: string;
  paused = false;
  stopping = false;
  interrupting = false;
  terminal: 'finished' | 'failed' | 'stopped' | undefined;
  /** Raw output not yet emitted as a `terminal` chunk. */
  raw = '';
  readonly text = new TerminalText();
  /** Completed lines not yet emitted as a `text` block. */
  lines: string[] = [];
  /** How much of the cursor's line was already emitted (a prompt shown before its answer). */
  emittedPartial = '';
  /** Output since the screen was last read (or since the last thing typed). */
  fresh = false;
  /** The last non-empty lines (question context, `result`). */
  recent: string[] = [];
  question: OpenQuestion | undefined;
  progressAt: number | undefined;
  quietTimer: NodeJS.Timeout | undefined;
  rawTimer: NodeJS.Timeout | undefined;
  /** When the raw batch got its first byte. */
  rawSince = 0;
  readyTimer: NodeJS.Timeout | undefined;
  interruptTimer: NodeJS.Timeout | undefined;
  idleTimer: NodeJS.Timeout | undefined;
  stopDone: Promise<void> | undefined;
  /** Prompt files written for this session (removed when it ends). */
  readonly files: string[] = [];
  private turnWaiters: (() => void)[] = [];

  constructor(
    readonly sessionId: string,
    readonly agentId: Id,
    readonly gate: PermissionGate,
    readonly cwd: string,
    firstPrompt: string,
  ) {
    this.firstPrompt = firstPrompt;
  }

  get turnOpen(): boolean {
    return this.phase === 'turn';
  }

  turnEnd(): Promise<void> {
    if (this.phase !== 'turn') return Promise.resolve();
    return new Promise((r) => this.turnWaiters.push(r));
  }

  closeTurn(phase: Phase = 'idle'): void {
    this.phase = phase;
    this.interrupting = false;
    for (const w of this.turnWaiters.splice(0)) w();
  }

  clearTimers(): void {
    for (const t of [
      this.quietTimer,
      this.rawTimer,
      this.readyTimer,
      this.interruptTimer,
      this.idleTimer,
    ]) {
      if (t) clearTimeout(t);
    }
    this.quietTimer = this.rawTimer = this.readyTimer = this.interruptTimer = undefined;
    this.idleTimer = undefined;
  }
}

export class PtyAdapter implements AgentAdapter {
  readonly runtime = 'pty' as const;
  readonly events = new EventQueue<AgentEvent>();
  private readonly sessions = new Map<string, Session>();
  private readonly byAgent = new Map<Id, Session>();
  private readonly byQuestion = new Map<Id, Session>();
  private readonly ended = new Map<string, NonNullable<Session['terminal']>>();
  private readonly onError: (error: unknown, context: string) => void;
  private readonly idle: RegExp | undefined;
  private readonly patterns: QuestionPattern[];
  private readonly clarifications: RegExp[];
  private readonly quietMs: number;
  private readonly flushMs: number;
  private disposed = false;

  constructor(private readonly opts: PtyAdapterOptions) {
    checkPassEnv(opts.agent.passEnv);
    this.onError = opts.onError ?? (() => {});
    this.idle = compileIdle(opts.agent.idlePattern);
    this.patterns = compilePatterns(opts.agent.questionPatterns);
    this.clarifications = compileClarifications(opts.agent.clarificationPatterns);
    this.quietMs = opts.agent.quietMs ?? 750;
    this.flushMs = opts.flushMs ?? 100;
  }

  preflight(): Promise<RuntimePreflight> {
    return (this.opts.preflight ?? (() => ptyPreflight(this.opts.agent)))();
  }

  // --- startup -----------------------------------------------------------------

  async spawn(opts: SpawnOptions): Promise<SpawnHandle> {
    if (this.disposed) throw new Error('adapter disposed');
    if (opts.bare) throw new Error('bare mode is a claude-sdk option; the pty runtime has none');
    if (opts.tools && opts.tools.length > 0) {
      throw new Error(
        'brains need the claude-sdk runtime: a terminal agent cannot serve their tools',
      );
    }
    if (!existsSync(opts.cwd) || !statSync(opts.cwd).isDirectory()) {
      throw new Error(`the working directory does not exist: ${opts.cwd}`);
    }
    const refused = this.judgeSession(opts.gate, opts.cwd);
    if (refused) throw new Error(refused);
    const pty = await loadPty();
    if (this.disposed) throw new Error('adapter disposed');
    const first = opts.systemPrompt ? `${opts.systemPrompt}\n\n${opts.prompt}` : opts.prompt;
    const session = new Session(randomUUID(), opts.agentId, opts.gate, opts.cwd, first);
    this.sessions.set(session.sessionId, session);
    this.byAgent.set(opts.agentId, session);
    const { agent } = this.opts;
    let args = agent.args ?? [];
    try {
      if (args.some((a) => a.includes(PROMPT_FILE_PLACEHOLDER))) {
        // The first prompt goes on the command line as a file: nothing to type once it is ready.
        const file = this.promptFile(session, first);
        args = args.map((a) => a.split(PROMPT_FILE_PLACEHOLDER).join(file));
        session.phase = 'turn';
      }
      session.process = this.opts.supervisor.adopt({
        agentId: opts.agentId,
        command: agent.command,
        args,
        cwd: opts.cwd,
        env: this.env(),
        meta: { runtime: 'pty', command: agent.command },
        fork: ptyFork(pty, PTY_TERMINAL_SIZE),
        onStdout: (chunk) => this.onData(session, chunk),
        interrupt: (proc) => this.stopHook(session, proc),
        onOutcome: (outcome) => this.onOutcome(session, outcome),
      });
    } catch (error) {
      session.terminal = 'failed';
      this.removeFiles(session);
      this.forget(session);
      throw error;
    }
    // Ready: the idle prompt, or quiet (`onQuiet`); at the latest after the ready timeout.
    this.armQuiet(session);
    if (session.phase === 'starting') {
      session.readyTimer = setTimeout(
        () => this.ready(session),
        this.opts.readyTimeoutMs ?? 15_000,
      );
    }
    return { sessionId: session.sessionId };
  }

  /**
   * decision 112: the session as a whole asked of the gate as a call it cannot classify.
   * `undefined` when allowed, else the refusal. Never reserved against the tool-call cap.
   */
  private judgeSession(gate: PermissionGate, cwd: string): string | undefined {
    const { command, args } = this.opts.agent;
    let verdict;
    try {
      verdict = gate.check(
        {
          toolName: PTY_SESSION_TOOL,
          input: { command: [command, ...(args ?? [])].join(' '), cwd },
        },
        { reserve: false },
      );
    } catch (error) {
      verdict = { decision: 'deny' as const, reason: (error as Error).message };
    }
    if (verdict.decision === 'allow') return undefined;
    if (
      verdict.decision === 'ask' &&
      (verdict.action === 'push' || verdict.reasons.some((r) => /\bpush\b/i.test(r)))
    ) {
      return (
        "the terminal agent's command line mentions a push, and a push always asks the user " +
        '(decision 49): a terminal agent cannot stop to ask, so it cannot run with this command ' +
        `(${verdict.reasons.join('; ')})`
      );
    }
    const why =
      verdict.decision === 'deny' ? verdict.reason : verdict.reasons.join('; ') || 'it asks';
    return (
      'a terminal agent runs commands GalacticAgents cannot see or judge, so it runs only where ' +
      'the permission table allows what it cannot classify (the "trusted" preset): ' +
      `this table does not (${why})`
    );
  }

  private env(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {};
    for (const key of this.opts.agent.passEnv ?? []) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    return { COLORTERM: 'truecolor', ...env, ...(this.opts.agent.env ?? {}) };
  }

  // --- output --------------------------------------------------------------------

  private onData(session: Session, chunk: string): void {
    if (session.terminal) return;
    if (!session.raw) session.rawSince = Date.now();
    session.raw += chunk;
    if (session.raw.length >= RAW_BATCH) this.flushRaw(session);
    else if (!session.rawTimer) this.armRawFlush(session, this.flushMs);
    for (const line of session.text.feed(chunk)) this.onLine(session, line);
    session.fresh = true;
    this.armQuiet(session);
  }

  private onLine(session: Session, line: string): void {
    const already = session.emittedPartial;
    session.emittedPartial = '';
    // The part of a prompt already shown (it waited, then the answer completed the line).
    const rest = already && line.startsWith(already) ? line.slice(already.length) : line;
    if (rest.trim() || !already) session.lines.push(rest);
    const text = line.trim();
    if (!text) return;
    session.recent.push(text);
    if (session.recent.length > 20) session.recent.shift();
    if (session.question) session.question.movedOn = true;
    if (session.lines.length >= TEXT_BLOCK_LINES) this.flushText(session);
    if (session.phase === 'turn' && !session.paused) {
      const now = Date.now();
      const every = this.opts.progressEveryMs ?? 30_000;
      if (session.progressAt === undefined || now - session.progressAt >= every) {
        session.progressAt = now;
        this.emit(session, {
          type: 'agent.progress',
          agentId: session.agentId,
          summary: text.length > 160 ? `${text.slice(0, 157)}…` : text,
        });
      }
    }
  }

  /**
   * Schedules the raw batch's flush. A batch that is only carriage-return redraws (a spinner, a
   * progress bar: `\r` and no newline) is held up to `redrawFlushMs` (default 1 s) instead of
   * `flushMs`, so a spinner costs a transcript row a second, not ten (P8-08 review); the view
   * renders the same final frame either way.
   */
  private armRawFlush(session: Session, ms: number): void {
    session.rawTimer = setTimeout(() => {
      session.rawTimer = undefined;
      const held = Date.now() - session.rawSince;
      const redrawMs = this.opts.redrawFlushMs ?? 1_000;
      if (isRedrawOnly(session.raw) && held < redrawMs) {
        this.armRawFlush(session, redrawMs - held);
        return;
      }
      this.flushRaw(session);
    }, ms);
  }

  /** The raw batch as one `terminal` chunk. Held while paused (nothing is emitted then). */
  private flushRaw(session: Session): void {
    if (session.rawTimer) {
      clearTimeout(session.rawTimer);
      session.rawTimer = undefined;
    }
    if (!session.raw || session.paused) return;
    const raw = session.raw;
    session.raw = '';
    this.output(session, 'terminal', raw);
  }

  /**
   * The completed lines as one `text` block; with `partial`, the cursor's line too (a prompt
   * waiting for an answer), remembered so the rest of it follows when the line completes.
   */
  private flushText(session: Session, partial = false): void {
    if (session.paused) return;
    const lines = session.lines;
    session.lines = [];
    if (partial) {
      const current = session.text.current;
      const shown = session.emittedPartial;
      const add = current.startsWith(shown) ? current.slice(shown.length) : current;
      if (add.trim()) {
        lines.push(add);
        session.emittedPartial = current;
      }
    }
    while (lines.length > 0 && !lines[0]!.trim()) lines.shift();
    while (lines.length > 0 && !lines.at(-1)!.trim()) lines.pop();
    if (lines.length === 0) return;
    this.output(session, 'text', lines.join('\n'));
  }

  private flushAll(session: Session, partial = true): void {
    this.flushRaw(session);
    this.flushText(session, partial);
  }

  // --- reading the screen --------------------------------------------------------

  private armQuiet(session: Session): void {
    if (session.quietTimer) clearTimeout(session.quietTimer);
    session.quietTimer = setTimeout(() => {
      session.quietTimer = undefined;
      this.onQuiet(session);
    }, this.quietMs);
    const idleAfter = this.opts.agent.idleAfterMs;
    if (idleAfter !== undefined) {
      if (session.idleTimer) clearTimeout(session.idleTimer);
      session.idleTimer = setTimeout(() => {
        session.idleTimer = undefined;
        if (session.paused || session.terminal || session.stopping) return;
        if (session.phase === 'turn' && !session.question) this.endTurn(session);
      }, idleAfter);
    }
  }

  /** The output went quiet: read the cursor's line. */
  private onQuiet(session: Session): void {
    if (session.terminal || session.paused || session.stopping) return;
    // A redraw-only batch (a spinner) younger than `redrawFlushMs` stays with its redraw timer
    // (`armRawFlush`): the quiet read must not flush it early — that broke the one-row-a-second
    // promise whenever the spinner paused for `quietMs`.
    const redrawMs = this.opts.redrawFlushMs ?? 1_000;
    if (
      session.raw &&
      isRedrawOnly(session.raw) &&
      Date.now() - session.rawSince < redrawMs &&
      session.rawTimer
    ) {
      this.flushText(session, true);
    } else {
      this.flushAll(session);
    }
    if (session.phase === 'starting') {
      this.ready(session);
      return;
    }
    if (!session.fresh) return;
    session.fresh = false;
    if (session.phase !== 'turn' || session.question) return;
    const found = detect(session.text.current, {
      idle: this.idle,
      patterns: this.patterns,
      clarifications: this.clarifications,
    });
    if (session.interrupting) {
      // After Ctrl-C: the prompt is back (or, with no prompt to wait for, the output stopped).
      if (found?.kind === 'idle' || !this.idle) this.endTurn(session);
      return;
    }
    if (!found) return;
    if (found.kind === 'idle') {
      this.endTurn(session);
      return;
    }
    this.ask(session, found);
  }

  /** The CLI is ready for its first prompt. */
  private ready(session: Session): void {
    if (session.readyTimer) {
      clearTimeout(session.readyTimer);
      session.readyTimer = undefined;
    }
    if (session.phase !== 'starting' || session.terminal || session.stopping) return;
    if (session.paused) return; // typed on resume
    this.startTurn(session, session.firstPrompt);
  }

  /** A message (the first prompt, a later one): a long one goes through a file. */
  private startTurn(session: Session, text: string): void {
    session.phase = 'turn';
    session.progressAt = undefined;
    const line = oneLine(text);
    if (Buffer.byteLength(line) > LONG_LINE) {
      this.type(session, `Read your instructions from ${this.promptFile(session, text)}`);
    } else {
      this.type(session, line);
    }
  }

  /** An answer or the user's own line: typed as is, with a warning when line mode may cut it. */
  private typeReply(session: Session, text: string): void {
    const line = oneLine(text);
    const bytes = Buffer.byteLength(line);
    if (bytes > LONG_LINE) {
      this.flushAll(session);
      this.output(
        session,
        'text',
        `Warning: a ${bytes}-byte line was typed into the terminal; a terminal in line mode ` +
          'keeps about 1024 bytes of a line, so its end may be lost.',
      );
    }
    this.type(session, line);
  }

  /** Types one line and Enter; what came before it is not read again. */
  private type(session: Session, line: string): void {
    this.flushAll(session);
    session.fresh = false;
    session.process?.write(`${line}\r`);
    this.armQuiet(session);
  }

  /**
   * Writes `text` to a new prompt file in the working directory's private folder
   * (`.galactic/pty/`, 0700; the file 0600) and returns its path; removed when the session ends.
   */
  private promptFile(session: Session, text: string): string {
    const dir = join(session.cwd, '.galactic', 'pty');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${session.sessionId}-${session.files.length + 1}.txt`);
    writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`, { mode: 0o600, flag: 'wx' });
    session.files.push(file);
    return file;
  }

  private removeFiles(session: Session): void {
    for (const file of session.files.splice(0)) {
      try {
        rmSync(file, { force: true });
      } catch (error) {
        this.onError(error, `pty prompt file ${file}`);
      }
    }
    try {
      rmdirSync(join(session.cwd, '.galactic', 'pty')); // only when empty
    } catch {
      // not empty (another session's files) or already gone
    }
  }

  private endTurn(session: Session): void {
    if (session.phase !== 'turn') return;
    if (session.interruptTimer) {
      clearTimeout(session.interruptTimer);
      session.interruptTimer = undefined;
    }
    this.flushAll(session);
    this.settleQuestion(session);
    session.closeTurn('idle');
    session.process?.turnEnded();
    if (!session.stopping && !session.terminal) {
      this.emit(session, { type: 'agent.idle', agentId: session.agentId });
    }
  }

  // --- questions -----------------------------------------------------------------

  private ask(
    session: Session,
    found: Exclude<ReturnType<typeof detect>, { kind: 'idle' } | undefined>,
  ): void {
    // The lines before the prompt (the prompt itself is the cursor's line, not one of them).
    const context = session.recent.slice(-CONTEXT_LINES).filter((l) => l !== found.line);
    const lead =
      found.kind === 'clarification'
        ? 'The terminal agent asks:'
        : found.freeform
          ? 'The terminal agent asks (GalacticAgents cannot see what the answer leads to):'
          : 'The terminal agent asks for confirmation (GalacticAgents cannot see what it would do):';
    const tail =
      found.kind === 'permission' && found.freeform
        ? [
            'Allow presses Enter (its default answer); Refuse interrupts it. To answer in words, ' +
              "type into its terminal from this Mac's browser.",
          ]
        : [];
    const text = [lead, ...context.map((l) => `  ${l}`), `> ${found.line}`, ...tail].join('\n');
    const id = `q-${randomUUID()}`;
    session.question = {
      id,
      kind: found.kind,
      yes: found.kind === 'permission' ? found.yes : '',
      no: found.kind === 'permission' ? found.no : '',
      freeform: found.kind === 'permission' && found.freeform,
      movedOn: false,
    };
    this.byQuestion.set(id, session);
    this.emit(session, {
      type: 'agent.needs_input',
      agentId: session.agentId,
      questionId: id,
      kind: found.kind,
      // A permission without a tool call: nothing can judge it, so the user decides (P2-04).
      question: { text },
    });
  }

  /** Withdraws the open question, if any (nothing is typed). */
  private settleQuestion(session: Session): void {
    const q = session.question;
    if (!q) return;
    session.question = undefined;
    this.byQuestion.delete(q.id);
  }

  async answer(questionId: Id, answer: string): Promise<void> {
    const session = this.byQuestion.get(questionId);
    const q = session?.question;
    if (!session || !q || q.id !== questionId) throw new Error(`no pending question ${questionId}`);
    this.settleQuestion(session);
    if (q.movedOn) {
      this.flushAll(session);
      this.output(
        session,
        'text',
        'The terminal went on before the answer came: the answer was not typed.',
      );
      return;
    }
    if (q.kind === 'clarification') {
      // A supervisor may answer it: the table may have changed since (decision 112).
      if (this.judgeSession(session.gate, session.cwd)) throw this.endRefused(session);
      this.typeReply(session, answer);
      return;
    }
    const allowed = ALLOW.test(answer.trim());
    if (q.freeform) {
      // Allow: Enter, the CLI's default. Refuse: interrupt, typing nothing it could act on.
      if (allowed) this.type(session, '');
      else await this.interrupt(session.sessionId);
      return;
    }
    this.type(session, allowed ? q.yes : q.no);
  }

  /**
   * The user dismissed the question (P9-14, SPEC decision 135). A permission prompt is refused as
   * Refuse refuses it (its "no", or an interrupt for a free-form prompt) — never allowed. A
   * terminal cannot be told anything else: a clarification's card is withdrawn and nothing is
   * typed; the prompt stays in its terminal for the user's keyboard.
   */
  async dismiss(questionId: Id, reason: string): Promise<void> {
    const session = this.byQuestion.get(questionId);
    const q = session?.question;
    if (!session || !q || q.id !== questionId) throw new Error(`no pending question ${questionId}`);
    if (q.kind === 'permission') return this.answer(questionId, 'no');
    this.settleQuestion(session);
    this.flushAll(session);
    this.output(
      session,
      'text',
      `The question was ${reason}: nothing was typed. To answer it, type into its terminal ` +
        "from this Mac's browser.",
    );
  }

  /**
   * The table no longer allows terminal agents (decision 112): the agent ends,
   * `agent.failed(runtime)` with the reason, and its process is stopped. Returns the error the
   * refused call throws.
   */
  private endRefused(session: Session): Error {
    const proc = session.process;
    this.flushAll(session);
    this.terminal(session, {
      type: 'agent.failed',
      agentId: session.agentId,
      error: TABLE_NO_LONGER_ALLOWS,
      reason: 'runtime',
    });
    if (proc && proc.state !== 'exited') {
      session.stopping = true;
      this.opts.supervisor
        .stop(session.agentId, { graceMs: this.opts.graceMs ?? 10_000, by: SYSTEM })
        .catch((error: unknown) => this.onError(error, `pty stop ${session.agentId}`));
    }
    return new Error(TABLE_NO_LONGER_ALLOWS);
  }

  // --- control -------------------------------------------------------------------

  async send(sessionId: string, message: string, opts: SendOptions = {}): Promise<void> {
    const session = this.session(sessionId);
    if (session.terminal) throw new Error(`session ${sessionId} has ${session.terminal}`);
    if (session.stopping) throw new Error(`session ${sessionId} is stopping`);
    if (session.phase === 'starting') {
      throw new Error(`session ${sessionId} has not started its first turn yet`);
    }
    if (session.turnOpen) {
      if (!opts.interrupt) {
        throw new Error(
          `session ${sessionId} is mid-turn: the runtime delivers messages only when idle`,
        );
      }
      await this.interrupt(sessionId);
      await session.turnEnd();
    }
    if (session.terminal) throw new Error(`session ${sessionId} has ${session.terminal}`);
    // The table may have changed since the spawn (decision 112).
    if (this.judgeSession(session.gate, session.cwd)) throw this.endRefused(session);
    this.startTurn(session, message);
  }

  async input(sessionId: string, text: string): Promise<void> {
    const session = this.session(sessionId);
    if (session.terminal) throw new Error(`session ${sessionId} has ${session.terminal}`);
    if (session.stopping) throw new Error(`session ${sessionId} is stopping`);
    if (session.paused) throw new Error(`session ${sessionId} is paused: resume it first`);
    if (session.phase === 'idle') {
      // Typed while idle: it starts work the screen must be read for (questions, the turn's end).
      session.phase = 'turn';
      session.progressAt = undefined;
    }
    this.typeReply(session, text);
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.live(sessionId);
    if (!session || session.terminal || !session.turnOpen) return;
    if (session.paused) this.thaw(session); // a frozen CLI cannot read the Ctrl-C
    if (session.interrupting) return;
    session.interrupting = true;
    this.settleQuestion(session);
    this.flushAll(session);
    session.fresh = false;
    session.process?.write(CTRL_C);
    this.armQuiet(session);
    session.interruptTimer = setTimeout(() => {
      session.interruptTimer = undefined;
      if (session.interrupting && !session.paused) this.endTurn(session);
    }, this.opts.interruptIdleMs ?? 3_000);
  }

  async pause(sessionId: string): Promise<void> {
    const session = this.live(sessionId);
    if (!session || session.terminal || session.paused) return;
    if (!session.process || session.process.state === 'exited') {
      throw new Error(`cannot pause session ${sessionId}: no terminal process to freeze`);
    }
    this.flushAll(session);
    session.paused = true;
    session.process.signal('SIGSTOP');
    this.emit(session, { type: 'agent.paused', agentId: session.agentId, by: SYSTEM });
  }

  async resume(sessionId: string): Promise<void> {
    const session = this.live(sessionId);
    if (!session || session.terminal || !session.paused) return;
    this.thaw(session);
  }

  private thaw(session: Session): void {
    session.paused = false;
    session.process?.signal('SIGCONT');
    this.emit(session, { type: 'agent.resumed', agentId: session.agentId, by: SYSTEM });
    this.armQuiet(session);
  }

  async stop(sessionId: string, opts: StopOptions = {}): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.terminal) return;
    if (session.stopDone) return session.stopDone;
    session.stopping = true;
    session.stopDone = (async () => {
      this.settleQuestion(session);
      if (session.process && session.process.state !== 'exited') {
        // The supervisor runs the sequence: our hook (Ctrl-C, the turn's end, Ctrl-D) → SIGTERM
        // → SIGKILL; its `stopped` outcome is the terminal event.
        await this.opts.supervisor.stop(session.agentId, {
          graceMs: opts.graceMs ?? this.opts.graceMs ?? 10_000,
          by: SYSTEM,
        });
      }
      if (!session.terminal) {
        this.terminal(session, { type: 'agent.stopped', agentId: session.agentId, by: SYSTEM });
      }
    })();
    return session.stopDone;
  }

  /** The supervisor's graceful stop, step 1: thaw, Ctrl-C and the turn's end, then Ctrl-D. */
  private async stopHook(session: Session, proc: ManagedProcess): Promise<void> {
    if (session.paused) {
      proc.signal('SIGCONT');
      session.paused = false;
    }
    if (session.turnOpen) {
      if (!session.interrupting) {
        session.interrupting = true;
        session.fresh = false;
        proc.write(CTRL_C);
        this.armQuiet(session);
        session.interruptTimer = setTimeout(
          () => this.endTurn(session),
          this.opts.interruptIdleMs ?? 3_000,
        );
      }
      await session.turnEnd();
    }
    proc.expectExit();
    proc.write(CTRL_D);
    proc.turnEnded();
  }

  private onOutcome(session: Session, outcome: ProcessOutcome): void {
    if (outcome.kind === 'restarting') return; // adopt() has no restart policy
    // The supervisor waited for the output to drain: what is left is the CLI's last words.
    this.flushAll(session);
    switch (outcome.kind) {
      case 'start_failed':
        this.terminal(session, {
          type: 'agent.failed',
          agentId: session.agentId,
          error: outcome.error,
          reason: 'runtime',
        });
        return;
      case 'crashed': {
        const { code, signal } = outcome.exit;
        this.terminal(
          session,
          signal
            ? {
                type: 'agent.failed',
                agentId: session.agentId,
                error: `the terminal agent was killed (${signal})`,
                reason: 'crash',
              }
            : {
                type: 'agent.failed',
                agentId: session.agentId,
                error: `the terminal agent exited with code ${code}${this.lastWords(session)}`,
                reason: 'runtime',
              },
        );
        return;
      }
      case 'stopped':
        this.terminal(session, { type: 'agent.stopped', agentId: session.agentId, by: outcome.by });
        return;
      case 'exited':
        if (session.stopping) {
          this.terminal(session, { type: 'agent.stopped', agentId: session.agentId, by: SYSTEM });
        } else {
          const result = session.recent.slice(-RESULT_LINES).join('\n');
          this.terminal(session, {
            type: 'agent.finished',
            agentId: session.agentId,
            ...(result ? { result } : {}),
          });
        }
        return;
    }
  }

  private lastWords(session: Session): string {
    const last = session.recent.at(-1);
    return last ? `: ${last.length > 200 ? `${last.slice(0, 197)}…` : last}` : '';
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.stop(id)));
    this.events.close();
  }

  // --- helpers -------------------------------------------------------------------

  private session(sessionId: string): Session {
    const s = this.sessions.get(sessionId);
    if (s) return s;
    const ended = this.ended.get(sessionId);
    if (ended) throw new Error(`session ${sessionId} has ${ended}`);
    throw new Error(`unknown pty session ${sessionId}`);
  }

  private live(sessionId: string): Session | undefined {
    if (!this.sessions.has(sessionId) && this.ended.has(sessionId)) return undefined;
    return this.session(sessionId);
  }

  private current(session: Session): boolean {
    return this.byAgent.get(session.agentId) === session;
  }

  private output(
    session: Session,
    kind: 'text' | 'tool' | 'thinking' | 'terminal',
    text: string,
  ): void {
    this.emit(session, { type: 'agent.output', agentId: session.agentId, kind, text });
  }

  private emit(session: Session, event: AgentEvent): void {
    if (session.terminal || !this.current(session)) return;
    this.events.push(event);
  }

  private terminal(
    session: Session,
    event: Extract<AgentEvent, { type: 'agent.finished' | 'agent.failed' | 'agent.stopped' }>,
  ): void {
    if (session.terminal) return;
    if (this.current(session)) this.events.push(event);
    session.terminal =
      event.type === 'agent.finished'
        ? 'finished'
        : event.type === 'agent.failed'
          ? 'failed'
          : 'stopped';
    session.clearTimers();
    this.settleQuestion(session);
    session.closeTurn('idle');
    this.removeFiles(session);
    this.forget(session);
  }

  private forget(session: Session): void {
    this.byQuestion.forEach((s, id) => {
      if (s === session) this.byQuestion.delete(id);
    });
    if (this.sessions.get(session.sessionId) === session) this.sessions.delete(session.sessionId);
    if (this.current(session)) this.byAgent.delete(session.agentId);
    if (session.terminal) {
      this.ended.set(session.sessionId, session.terminal);
      if (this.ended.size > ENDED_MEMORY) this.ended.delete(this.ended.keys().next().value!);
    }
  }

  /** Live session count (tests: ended sessions are freed). */
  get sessionCount(): number {
    return this.sessions.size;
  }
}
