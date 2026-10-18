import { randomUUID } from 'node:crypto';
import {
  BRAIN_SLASH_COMMANDS,
  brainSlashCommands,
  excerpt,
  isHarnessMeta,
  slashCommandIs,
  type Actor,
  type Agent,
  type AgentAdapter,
  type AgentCaps,
  type AgentEvent,
  type AgentRole,
  type AgentRuntime as RuntimeName,
  type Event,
  type Id,
  type SetAnswer,
  type PermissionAction,
  type PermissionPolicy,
  type PermissionRule,
  type RequestOrigin,
  type ReplyQuote,
  type SlashCommand,
  type SpawnHandle,
  type SpawnOptions,
  type ToolCall,
  type ToolDefinition,
} from '@galactic/protocol';
import { isStorageFailure } from '../db/database.js';
import type { CommandContext, EventLog } from '../domain/event-log.js';
import { createAgent, recordSpawned } from '../domain/agents.js';
import {
  answerQuestion,
  cancelQuestion,
  checkAnswer,
  checkDismiss,
  type Dismissal,
} from '../domain/questions.js';
import {
  endAgentQuestions,
  holdersNow,
  rerouteHeldBy,
  livingFromStatuses,
  logRouting,
  openFromNeedsInput,
  type QuestionRouting,
} from '../domain/question-service.js';
import { DomainError } from '../domain/errors.js';
import { globalDefaultPolicy, type PolicyContext } from '../domain/permissions.js';
import { userFoldersOf } from '../deliverables/folder.js';
import { AgentInbox, type InboxMessage } from './inbox.js';
import {
  CapsEnforcer,
  DEFAULT_CAPS,
  DEFAULT_MAX_CONCURRENT_AGENTS,
  type CapsConfig,
  type SpawnCheck,
} from './caps.js';
import { aliasesOf, createPermissionGate, type RuntimeGate } from './permission-gate.js';
import { redactEvent, redactSecrets, redactValue } from './redact.js';
import type { StatusStore } from './status-store.js';
import { TOOL_RUNTIMES } from './tool-runtimes.js';
import type { TranscriptPipeline } from './transcripts.js';

/**
 * The agent runtime: what ties an adapter's session to the rest of the server (P1-02, P1-05,
 * P1-07; TECHNOLOGY §3.4, §4, §6.2). For every agent it owns the inbox, the caps, the permission
 * gate, the adapter session, and the routing of the adapter's events:
 *
 *   agent.output  → transcript pipeline (redacted, batched) + status store `touch()`
 *   everything else → the event log (one write rule), whose subscribers include the status
 *                     store and, later, the brains' mailboxes
 *
 * Invariants the runtime enforces on the way to the log (P1-17):
 *   - every agent gets exactly one terminal event (`finished` | `failed` | `stopped`); a cap
 *     stop ends in `agent.failed(reason: cap)` and the adapter's own `agent.stopped` is folded
 *     into it, whichever arrives first;
 *   - events for an agent the runtime does not know (never spawned here, or already ended) never
 *     reach the log — the adapter is reporting a session the server no longer owns;
 *   - an agent's open questions are cancelled in the same command as its terminal or
 *     interrupted event, and when it goes idle without an answer (an interrupt withdrew them,
 *     P1-34); the questions it *held* move to the next living supervisor or the user (P2-03);
 *   - a stop that was asked for ends as a stop, even when a shutdown overtakes it (P1-32).
 *
 * `agent.spawned` is emitted here, not by adapters (they do not know bodies). The agent row is
 * created by `domain/agents.ts`; Phase 2's `spawnAgent` command composes the same functions.
 */

export interface SpawnRequest {
  role: AgentRole;
  runtime: RuntimeName;
  prompt: string;
  cwd: string;
  /** The project workspace for the policy engine; defaults to `cwd`. */
  workspace?: string;
  caps?: Partial<AgentCaps>;
  permissionPolicy?: PermissionPolicy;
  bodyId?: Id;
  supervisorId?: Id;
  taskId?: Id;
  projectId?: Id;
  tools?: ToolDefinition[];
  systemPrompt?: string;
  bare?: boolean;
  /** A fixed agent id (tests, resume); default: generated. */
  agentId?: Id;
  /**
   * A free-form agent (the ops console's `POST /api/agents`): recorded as `meta.freeForm`, so it
   * keeps the wall-clock cap whatever its role, across restarts too (SPEC decision 103).
   */
  freeForm?: boolean;
}

export type SpawnResult = { ok: true; agent: Agent } | { ok: false; reason: string };

export interface AgentRuntimeOptions {
  log: EventLog;
  adapters: AgentAdapter[];
  transcripts: TranscriptPipeline;
  statuses: StatusStore;
  /** Hard caps (P1-02) and the hierarchy's spawn caps (P2-17). */
  caps?: CapsConfig;
  /** Delivered messages kept per inbox for inspection; the log has the full history. */
  inboxHistory?: number;
  now?: () => string;
  onError?: (error: unknown, context: string) => void;
  /** Question routing (P2-03); default: the log, with liveness from `statuses`. */
  questions?: QuestionRouting;
  /**
   * How often agent events the storage refused are tried again (P8-04: a full disk). Default
   * 1 s.
   */
  storageRetryMs?: number;
  /**
   * How much the held queue may grow while the storage refuses writes (P8-04 review): past it the
   * oldest agent output (tool calls, progress) is dropped, never a state transition first.
   * Default 10 000 events / 64 MiB (approximate: the events' JSON size).
   */
  heldLimits?: { events?: number; bytes?: number };
}

/** The agent events held for the storage, as the panel's storage banner shows them (P8-09). */
export interface StorageState {
  /** Agent events waiting to be written. */
  held: number;
  /** Their approximate size (JSON bytes). */
  bytes: number;
  /** Agent output dropped since the storage started refusing, to stay within the limits. */
  dropped: number;
  /** When the storage started refusing writes (the first held event's time). */
  since?: string;
  /** The storage's last refusal. */
  error?: string;
  /** Its SQLite code (`SQLITE_FULL`, …): what the panel calls it (`storageConditionOf`). */
  code?: string;
  /** The refusal will not go away by itself (a read-only or missing database file). */
  permanent: boolean;
}

/** An agent event (or a runtime command) the storage refused, waiting to be written in order. */
interface HeldWrite {
  fn: (ctx: CommandContext) => unknown;
  /** When it happened: written with this `at`. */
  at: string;
  bytes: number;
  /** Agent output (a tool call, progress): what is dropped first when the queue is full. */
  droppable: boolean;
}

export const DEFAULT_HELD_LIMITS = { events: 10_000, bytes: 64 * 2 ** 20 };
/** What a held command without a single event is counted as. */
const HELD_COMMAND_BYTES = 512;
/** Agent output: dropped first when the held queue is over its limits (P8-04 review). */
const DROPPABLE = new Set<Event['type']>(['agent.tool_call', 'agent.progress', 'agent.stalled']);
/** Refusals that will not go away by themselves: the database is read-only or missing. */
const PERMANENT_STORAGE = ['SQLITE_READONLY', 'SQLITE_CANTOPEN'];

function isPermanentStorageFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    typeof code === 'string' &&
    PERMANENT_STORAGE.some((c) => code === c || code.startsWith(`${c}_`))
  );
}

const TERMINAL = new Set<AgentEvent['type']>(['agent.finished', 'agent.failed', 'agent.stopped']);
type Terminal = 'agent.finished' | 'agent.failed' | 'agent.stopped' | 'agent.interrupted';

/**
 * How an interrupted agent is reopened (P2-16). A brain passes its definition (`tools`,
 * `systemPrompt`) and its first turn; its messages stay with its mailbox.
 */
export interface ReopenOptions {
  tools?: ToolDefinition[];
  systemPrompt?: string;
  /** The resumed session's first message (default: `RESUME_PROMPT`). */
  prompt?: string;
  /**
   * With it, an agent whose session cannot be resumed (no session ref, a runtime without resume,
   * a failed resume) gets a fresh session on the same agent row, with this first prompt — a brain
   * re-seeded from the database. Without it the agent stays interrupted.
   */
  freshPrompt?: string;
  /**
   * The agent is a brain with a mailbox (P2-06): `send()` only logs its messages from the start,
   * and the messages it never received are not redelivered raw — its runner folds them into the
   * first turn.
   */
  mailbox?: boolean;
  /**
   * The seq up to which the first prompt folded the log (a brain's requeue): recorded on
   * `agent.spawned` so a later requeue cuts there once this session's first turn ended.
   */
  foldedUpTo?: number;
  /**
   * A session resumed from its ref that ends before its first turn did (the SDK hands back a
   * handle at once; a lost or corrupt session only shows when the CLI exits) is a failed resume,
   * not an end: with `freshPrompt` the runtime opens the fresh session on the same row and calls
   * this first, synchronously, with that session's outcome — before the `agent.interrupted` is
   * logged.
   */
  onFallback?: (fresh: Promise<SpawnResult>) => void;
}

/** A reopen's outcome: `resumed` from the session ref, or a `fresh` session on the same row. */
export type ReopenResult = SpawnResult & { mode?: 'resumed' | 'fresh' };

/**
 * Reopens an interrupted brain as a brain (P2-16): through its runner, with its definition. Returns
 * `undefined` for an agent it has no definition for (it is then resumed as a plain agent).
 */
export type BrainResumer = (agent: Agent) => Promise<SpawnResult> | undefined;

/**
 * The server's tools a Steward gets (P9-04: `declare_deliverable`, `list_deliverables`), for its
 * row, or `undefined` for none. Asked at every start of a Steward's session — a spawn, a resume,
 * a fresh restart — that carries no tools of its own; only runtimes in `TOOL_RUNTIMES` are asked
 * (ACP and PTY sessions cannot serve the server's tools).
 */
export type StewardTools = (agent: Agent) => ToolDefinition[] | undefined;

/**
 * The first message of a resumed session (P2-16): the agent continues where it was, instead of
 * being handed its original task prompt again.
 */
export const RESUME_PROMPT =
  'The server restarted and your session was resumed. Continue where you left off; if you had ' +
  'already finished, say so in one line.';

export interface RecoveryReport {
  /** Agents reopened from their session refs. */
  resumed: Id[];
  /** Agents left `interrupted`: no session ref, a runtime that cannot resume, or a failed resume. */
  needAttention: Id[];
}

const LIVE_STATES: ReadonlySet<string> = new Set([
  'starting',
  'working',
  'waiting_for_input',
  'idle',
  'stalled',
  'paused',
]);

interface Live {
  agent: Agent;
  adapter: AgentAdapter;
  /** Set once the adapter's `spawn`/`resumeSession` resolved. */
  handle: SpawnHandle | undefined;
  /** Events the adapter emitted before the handle came back: routed after `agent.spawned`. */
  early: AgentEvent[];
  /** The one place this agent's permissions are decided (P2-04): the adapter's hooks and ours. */
  gate: RuntimeGate;
  /** `permission.decided` events made before the handle came back: logged after `agent.spawned`. */
  decisions: Event[];
  inbox: AgentInbox;
  /** Question ids currently open for this agent (adapter-assigned). */
  questions: Set<Id>;
  paused: boolean;
  idle: boolean;
  /** A cap was hit: the stop under way ends in `agent.failed(cap)` with this reason. */
  capStop: string | undefined;
  /** A cap hit before the session handle existed: acted on once the handle arrives. */
  pendingCap: string | undefined;
  /** Someone asked for a stop that is still under way: it ends as `agent.stopped{by}`. */
  stopRequested: Actor | undefined;
  /** Questions whose answer is being handed to the adapter (not withdrawn by a racing idle). */
  answering: Set<Id>;
  /** The one terminal event routed for this agent. */
  terminal: Terminal | undefined;
  /** How the session was opened; `renewSession()` opens the next one the same way. */
  spec: SpawnRequest;
  /**
   * A brain's mailbox owns its messages (P2-06): `send()` only logs them and the brain runner
   * folds them into its next turn; only a `turn` message reaches the inbox.
   */
  mailbox: boolean;
  /** The current turn (P2-11): its last text output and whether it was cut short. */
  turn: { text: string | undefined; interrupted: boolean };
  /** The session was resumed and its first turn has not ended yet (P2-16). */
  resumedTurn: boolean;
  /**
   * A session resumed from its ref whose first turn has not ended (P2-16): ending now means the
   * resume failed (a lost session), handled by `resumeLost`.
   */
  probation: Probation | undefined;
  /** The session did something (output, a tool call, a question) since it opened. */
  activity: boolean;
  /**
   * The session's slash commands as last read from the adapter (P8-13; `commands()`), a brain's
   * already cut to its allowlist; `undefined` until the first read of this session ends.
   */
  commands?: SlashCommand[] | undefined;
}

/** What a resumed session falls back to if it ends before its first turn did (P2-16). */
interface Probation {
  /** A brain: the fresh session on the same row. Absent: the agent is left interrupted. */
  fresh?: { req: SpawnRequest; mailbox: boolean; foldedUpTo?: number };
  onFallback?: (fresh: Promise<SpawnResult>) => void;
}

/**
 * How one turn of an agent ended (P2-11): what `onTurnEnded` listeners get on every
 * `agent.idle`, after it is logged. `text` is the turn's last text output (redacted);
 * `interrupted` says the turn was cut short (an interrupt, a pause, a stop or a cap stop under
 * way); `queued` counts the messages waiting to start the next turn at once.
 */
export interface TurnEnd {
  agent: Agent;
  text: string | undefined;
  interrupted: boolean;
  queued: number;
  /** The first turn of a resumed session (P2-16): the turn the resume prompt started. */
  resumed: boolean;
}

const SYSTEM: Actor = { type: 'system' };

/** One agent's trace in the log, as recovery needs it. */
class AgentHistory {
  /** A `control.stop` after the agent's last (re)spawn that no terminal event answered. */
  stopRequested: Actor | undefined;
  readonly sent: {
    messageId: Id;
    text: string;
    sender: Actor;
    replyTo?: ReplyQuote | undefined;
  }[] = [];
  readonly delivered = new Set<Id>();
  /** The log has its `agent.created`, its `agent.spawned`, its end (P8-04). */
  created = false;
  /** The `seq` of its `agent.created`: a stop of its task or project after it counts (P8-04). */
  createdSeq = 0;
  spawned = false;
  ended = false;
  /**
   * Created, but the server died before its session started (P8-04: between the row and its
   * `agent.spawned` — for a real CLI the seconds it takes to start): no status record, no session.
   * Only when the log still has the `agent.created`: an older agent's events may have been pruned.
   */
  neverStarted(): boolean {
    return this.created && !this.spawned && !this.ended;
  }
  /** Messages the agent never received, in send order. */
  undelivered(): {
    messageId: Id;
    text: string;
    sender: Actor;
    replyTo?: ReplyQuote | undefined;
  }[] {
    return this.sent.filter((m) => !this.delivered.has(m.messageId));
  }
}
/** How many ended agent ids are remembered so a straggling event is told apart from a stranger. */
const ENDED_MEMORY = 1_000;

/** How much of a quote a reply's delivered text repeats (P8-17). */
const QUOTE_IN_TEXT = 1_000;

/** A reply's text as an agent without a mailbox receives it: the quote first (P8-17). */
export function withQuote(text: string, quote: ReplyQuote): string {
  const from = quote.sender.type === 'agent' ? `agent ${quote.sender.id}` : quote.sender.type;
  return `(replying to ${from}: ${JSON.stringify(excerpt(quote.text, QUOTE_IN_TEXT))})\n${text}`;
}

export class AgentRuntime {
  private readonly adapters = new Map<RuntimeName, AgentAdapter>();
  private readonly live = new Map<Id, Live>();
  /**
   * Where each agent's deliverables folder would be made while none is recorded yet (P9-06,
   * `setDeliverablesFolderLookup`): `galactic-deliverables/` when the repository tracks a
   * `deliverables/` folder of its own, so writes to that source folder do not ask.
   */
  private readonly folderCandidates = new Map<Id, string>();
  private folderLookup?: (target: { projectId?: Id; taskId?: Id }) => Promise<string | undefined>;
  private readonly byQuestion = new Map<Id, Id>();
  /** Recently ended agents, oldest first. */
  private readonly ended = new Set<Id>();
  private readonly now: () => string;
  private readonly onError: (error: unknown, context: string) => void;
  private readonly pumps: Promise<void>[] = [];
  readonly caps: CapsEnforcer;
  private readonly questions: QuestionRouting;
  private disposed = false;
  private readonly turnListeners = new Set<(turn: TurnEnd) => void>();
  private brainResumer: BrainResumer | undefined;
  private stewardTools: StewardTools | undefined;
  /**
   * Interrupted agents startup recovery is about to reopen (P2-16): the brains resumed first must
   * not replace them, so `isReserved` tells the spawn guards they are on their way back.
   */
  private readonly reserved = new Set<Id>();
  /** Brains whose lost resume is being replaced by a fresh session (`resumeLost`). */
  private readonly refreshing = new Set<Id>();
  /**
   * Agent events the storage refused (P8-04: the disk is full), oldest first: written in order
   * once writes work again, and every later one waits behind them, so the log never skips an
   * event the runtime already acted on (an agent it forgot as ended, a question it delivered).
   */
  private held: HeldWrite[] = [];
  private heldBytes = 0;
  private heldTimer: NodeJS.Timeout | undefined;
  /** The current refusal episode (P8-04 review): since when, the last error, what was dropped. */
  private storage: { since?: string; error?: unknown; dropped: number; warnedFull: boolean } = {
    dropped: 0,
    warnedFull: false,
  };
  /** True while `writeHeld` runs: the log's before-command hook must not drain again. */
  private draining = false;
  private readonly unhook: () => void;

  constructor(private readonly opts: AgentRuntimeOptions) {
    this.now = opts.now ?? (() => new Date().toISOString());
    this.onError = opts.onError ?? (() => {});
    this.questions = opts.questions ?? logRouting(opts.log, livingFromStatuses(opts.statuses));
    // Nothing commits ahead of the agent events held for a full disk (P8-04 review).
    this.unhook = opts.log.addBeforeCommand(() => this.beforeCommand());
    const { maxConcurrentAgents, defaults, ...spawn } = opts.caps ?? {};
    this.caps = new CapsEnforcer({
      maxConcurrentAgents: maxConcurrentAgents ?? DEFAULT_MAX_CONCURRENT_AGENTS,
      defaults: defaults ?? DEFAULT_CAPS,
      spawn,
      agentOf: (id) => opts.log.tables.agents.get(id),
      onCapHit: (agentId, reason) => void this.onCapHit(agentId, reason),
    });
    // Spawns per hour survive a restart (P2-17): every agent row created in the last hour counts.
    for (const agent of opts.log.tables.agents.all()) {
      const at = Date.parse(agent.createdAt);
      if (Number.isFinite(at)) this.caps.noteSpawn(agent.supervisorId, at, agent.role);
    }
    for (const adapter of opts.adapters) {
      this.adapters.set(adapter.runtime, adapter);
      this.pumps.push(this.pump(adapter));
    }
  }

  adapter(runtime: RuntimeName): AgentAdapter | undefined {
    return this.adapters.get(runtime);
  }

  /** Agents with a live adapter session. */
  liveAgents(): Agent[] {
    return [...this.live.values()].map((l) => l.agent);
  }

  /**
   * The slash commands the agent's live session offers (P8-13; `AgentAdapter.commands`): `[]`
   * for an agent without a live session, one still starting or ending, and a runtime without
   * commands. Read from the adapter on every call and remembered for `hasCommand`.
   *
   * A brain (the Harmonizer, a Waykeeper) gets only `BRAIN_SLASH_COMMANDS` (SPEC decision 115,
   * P8-13 review): `/clear` would reset its session behind the brain runner's back, `/init` or
   * `/review` would make it do a Steward's work. The endpoint, the composer's list and the
   * runner's `hasCommand` all read this one answer. A Steward keeps the runtime's whole list.
   */
  async commands(agentId: Id): Promise<SlashCommand[]> {
    const live = this.live.get(agentId);
    if (!live?.handle || live.terminal || !live.adapter.commands) return [];
    const sessionId = live.handle.sessionId;
    try {
      const offered = await live.adapter.commands(sessionId);
      const commands = isBrainRole(live.agent.role) ? brainSlashCommands(offered) : offered;
      // The session may have been replaced meanwhile (a renewal): keep only a current answer.
      // An empty answer is not remembered: adapters also give `[]` for "not known yet" (a CLI
      // still starting, a slow call), and a brain then keeps `hasCommand`'s allowlist fallback.
      if (
        offered.length > 0 &&
        this.live.get(agentId) === live &&
        live.handle?.sessionId === sessionId
      ) {
        live.commands = commands;
      }
      return commands;
    } catch (error) {
      this.onError(error, `commands ${agentId}`);
      return [];
    }
  }

  /**
   * Whether the agent's session offered `/name` (its name or an alias) when its commands were
   * last read (`commands()`). Synchronous, for the brain runner (P8-13). A brain's session has
   * its commands read as soon as it opens (`start`); until that read ends, a brain whose runtime
   * has commands at all is taken to offer its allowlist (Claude Code's own `/compact`, `/context`,
   * `/cost`, `/usage`), so a command sent right after a start or a restart still runs. `false`
   * otherwise.
   */
  hasCommand(agentId: Id, name: string): boolean {
    const live = this.live.get(agentId);
    if (!live) return false;
    if (live.commands) return live.commands.some((c) => slashCommandIs(c, name));
    return (
      isBrainRole(live.agent.role) &&
      live.adapter.commands !== undefined &&
      BRAIN_SLASH_COMMANDS.includes(name)
    );
  }

  inbox(agentId: Id): AgentInbox | undefined {
    return this.live.get(agentId)?.inbox;
  }

  /**
   * Creates the agent (row + `agent.spawned`) and starts its session. Refused before anything is
   * written when the runtime is unknown or the concurrency cap is reached: a refused spawn
   * leaves no row, no body and no event behind — the reason goes back to the caller.
   */
  async spawn(req: SpawnRequest): Promise<SpawnResult> {
    if (this.disposed) throw new Error('runtime disposed');
    const adapter = this.adapters.get(req.runtime);
    if (!adapter) return { ok: false, reason: `no adapter for runtime ${req.runtime}` };
    const gate = this.caps.canSpawn(this.spawnCheck(req.role, req.supervisorId));
    if (!gate.ok) return { ok: false, reason: gate.reason };

    const agent = this.opts.log.runCommand((ctx) =>
      createAgent(ctx, {
        role: req.role,
        runtime: req.runtime,
        caps: this.caps.resolve(req.caps),
        ...(req.bodyId ? { bodyId: req.bodyId } : {}),
        ...(req.supervisorId ? { supervisorId: req.supervisorId } : {}),
        ...(req.taskId ? { taskId: req.taskId } : {}),
        ...(req.projectId ? { projectId: req.projectId } : {}),
        ...(req.agentId ? { agentId: req.agentId } : {}),
        meta: {
          cwd: req.cwd,
          prompt: req.prompt,
          ...(req.workspace ? { workspace: req.workspace } : {}),
          ...(req.permissionPolicy ? { permissionPolicy: req.permissionPolicy } : {}),
          ...(req.bare ? { bare: true } : {}),
          ...(req.freeForm ? { freeForm: true } : {}),
        },
      }),
    ).value;
    this.caps.noteSpawn(agent.supervisorId, undefined, agent.role);
    return this.start(agent, req, adapter, (opts) => adapter.spawn(opts), false);
  }

  /** What the caps need to judge a spawn: the role, and who supervises it as what. */
  private spawnCheck(role: AgentRole, supervisorId: Id | undefined, again = false): SpawnCheck {
    const supervisorRole = supervisorId
      ? this.opts.log.tables.agents.get(supervisorId)?.role
      : undefined;
    return {
      role,
      ...(supervisorId ? { supervisorId } : {}),
      ...(supervisorRole ? { supervisorRole } : {}),
      ...(again ? { again: true } : {}),
    };
  }

  /**
   * Re-opens a saved session (P1-14): the agent row exists, the adapter resumes from its ref.
   * Low level — callers outside the runtime use `recoverAgent()`, which checks the agent is
   * interrupted and takes the policy and the pending messages from the log.
   */
  private async resume(
    agent: Agent,
    req: Omit<SpawnRequest, 'role' | 'runtime'>,
    opts: { fresh?: boolean; mailbox?: boolean; foldedUpTo?: number; probation?: Probation } = {},
  ): Promise<SpawnResult> {
    if (this.disposed) throw new Error('runtime disposed');
    if (this.live.has(agent.id)) return { ok: false, reason: `agent ${agent.id} is running` };
    const adapter = this.adapters.get(agent.runtime);
    if (!adapter) return { ok: false, reason: `no adapter for runtime ${agent.runtime}` };
    const ref = agent.sessionRef;
    if (!opts.fresh && (!adapter.resumeSession || !ref)) {
      return { ok: false, reason: `runtime ${agent.runtime} cannot resume sessions` };
    }
    const gate = this.caps.canSpawn(this.spawnCheck(agent.role, agent.supervisorId, true));
    if (!gate.ok) return { ok: false, reason: gate.reason };
    this.ended.delete(agent.id);
    return this.start(
      agent,
      { ...req, role: agent.role, runtime: agent.runtime },
      adapter,
      opts.fresh || !ref
        ? (spawnOpts) => adapter.spawn(spawnOpts)
        : (spawnOpts) => adapter.resumeSession!(ref, spawnOpts),
      true,
      {
        mailbox: opts.mailbox ?? false,
        resumed: !opts.fresh,
        ...(opts.foldedUpTo !== undefined ? { foldedUpTo: opts.foldedUpTo } : {}),
        ...(opts.probation && !opts.fresh && ref ? { probation: opts.probation } : {}),
      },
    );
  }

  private async start(
    agent: Agent,
    req: SpawnRequest,
    adapter: AgentAdapter,
    open: (opts: SpawnOptions) => Promise<SpawnHandle>,
    resuming: boolean,
    how: { mailbox?: boolean; resumed?: boolean; foldedUpTo?: number; probation?: Probation } = {},
  ): Promise<SpawnResult> {
    const caps = agent.caps;
    const tools = this.toolsOf(agent, req);
    // Registered before the adapter runs: whatever it emits before the handle comes back is
    // buffered and routed after `agent.spawned`, and counts against the caps from the start.
    // The project's table as of each check (P2-04): a changed policy applies to the next call.
    const gate = createPermissionGate({
      agentId: agent.id,
      policy: () => this.policyOf(agent.id, req),
      workspace: () => this.workspaceOf(agent.id, req),
      // The project's deliverables folder is the user's (P9-06, decision 122): a write asks.
      userFolders: () => this.userFoldersOf(agent.id, req),
      cwd: req.cwd,
      caps: this.caps,
      // The project's "Allow similar" rules (P9-17), read on every check like its table.
      rules: () => this.rulesOf(agent.id, req),
      onRuleAllow: (call, ruleId, action) =>
        this.permissionDecided(live, { toolCall: call, decision: 'allow', action, ruleId }),
      ...(tools ? { serverTools: tools.map((t) => t.name) } : {}),
      onDeny: (call, verdict, action) =>
        this.permissionDecided(live, {
          toolCall: call,
          decision: 'deny',
          reason: verdict.reason,
          action,
        }),
    });
    const live: Live = {
      agent,
      adapter,
      handle: undefined,
      early: [],
      gate,
      decisions: [],
      inbox: new AgentInbox(agent.id, {
        deliver: async (m) => {
          // The agent is busy from the moment it has the message (P1-33): a pause/resume or a
          // second message right after must not find it "idle".
          live.idle = false;
          live.turn = { text: undefined, interrupted: false };
          await adapter.send(this.session(live), m.text, { interrupt: m.interrupt });
          if (!live.terminal) {
            this.record({ type: 'message.delivered', messageId: m.id, agentId: agent.id });
          }
        },
        interrupt: () => {
          live.turn.interrupted = true;
          return adapter.interrupt(this.session(live));
        },
        now: this.now,
        onError: (e) => this.onError(e, `inbox ${agent.id}`),
        ...(this.opts.inboxHistory !== undefined ? { history: this.opts.inboxHistory } : {}),
      }),
      questions: new Set(),
      paused: false,
      idle: false,
      capStop: undefined,
      pendingCap: undefined,
      stopRequested: undefined,
      answering: new Set(),
      terminal: undefined,
      spec: req,
      // A reopened brain owns its messages from the start (P2-16): nothing slips into the inbox.
      mailbox: how.mailbox ?? false,
      turn: { text: undefined, interrupted: false },
      resumedTurn: how.resumed ?? false,
      probation: how.probation,
      activity: false,
    };
    this.live.set(agent.id, live);
    this.lookUpFolderCandidate(agent.id, req);
    this.caps.track(agent.id, caps, {
      role: agent.role,
      ...(agent.supervisorId ? { supervisorId: agent.supervisorId } : {}),
      ...(agent.meta?.freeForm === true ? { freeForm: true } : {}),
    });
    let handle: SpawnHandle;
    try {
      handle = await open({
        agentId: agent.id,
        role: agent.role,
        cwd: req.cwd,
        prompt: req.prompt,
        gate,
        caps,
        ...(tools ? { tools } : {}),
        ...(req.systemPrompt ? { systemPrompt: req.systemPrompt } : {}),
        ...(req.bare ? { bare: true } : {}),
      });
    } catch (error) {
      const message = (error as Error).message;
      if (resuming) {
        // A failed resume leaves the agent interrupted (the status store keeps that state):
        // the log says so too, rather than a failure the projection would ignore.
        this.recordEnd(
          live,
          { type: 'agent.interrupted', agentId: agent.id, reason: `resume failed: ${message}` },
          'agent.interrupted',
        );
      } else {
        this.recordEnd(
          live,
          { type: 'agent.failed', agentId: agent.id, error: message, reason: 'runtime' },
          'agent.failed',
        );
      }
      return { ok: false, reason: message };
    }
    live.handle = handle;
    live.commands = undefined; // a new session: its commands are read again (P8-13)
    // The row's session ref and `agent.spawned` in one transaction (one write rule). A full disk
    // holds it like any agent event (P8-04 review): lost, the next start would take the agent for
    // one that never started and begin afresh instead of resuming its session.
    this.command((ctx) => {
      const row = ctx.tables.agents.get(live.agent.id) ?? live.agent;
      const spawned = recordSpawned(
        ctx,
        row,
        handle.sessionRef,
        how.foldedUpTo !== undefined ? { foldedUpTo: how.foldedUpTo } : {},
      );
      if (this.live.get(spawned.id) === live) live.agent = spawned;
      return spawned;
    }, `record agent.spawned ${agent.id}`);
    for (const event of live.decisions.splice(0)) this.record(event);
    for (const event of live.early.splice(0)) this.route(event);
    if (live.pendingCap && !live.terminal) void this.onCapHit(agent.id, live.pendingCap);
    // A brain's runner decides from `hasCommand` whether a user's `/name` is a turn of its own:
    // read the new session's commands now rather than when a client first asks (P8-13 review).
    if (isBrainRole(agent.role) && !live.terminal) void this.commands(agent.id);
    return { ok: true, agent: live.agent };
  }

  private session(live: Live): string {
    if (!live.handle) throw new Error(`agent ${live.agent.id} has no session yet`);
    return live.handle.sessionId;
  }

  /**
   * Why `send` would refuse a message to this agent now (not running, stopping or ended), or
   * `undefined`. A reply that answers a clarification asks first (P8-17 review), so the answer
   * is not recorded for a message that cannot be sent.
   */
  sendRefusal(agentId: Id): string | undefined {
    const live = this.live.get(agentId);
    if (!live) return `agent ${agentId} is not running`;
    if (live.capStop || live.stopRequested || live.inbox.currentState === 'ended') {
      return `agent ${agentId} is stopping`;
    }
    return undefined;
  }

  /**
   * Queues a message; delivered when the agent is idle, or now with `interrupt`. Logged as
   * `message.sent` (P1-22) before it is queued, so a restart knows what was still pending.
   */
  send(
    agentId: Id,
    text: string,
    opts: {
      sender: Actor;
      interrupt?: boolean;
      turn?: boolean;
      origin?: RequestOrigin;
      /** The quote the user's message replies to (P8-17), resolved by the caller from the log. */
      replyTo?: ReplyQuote;
    },
  ): InboxMessage {
    const refusal = this.sendRefusal(agentId);
    if (refusal) throw new Error(refusal);
    const live = this.must(agentId);
    const messageId = `m-${randomUUID()}`;
    // The user's line is refused whole on a full disk (SPEC decision 99); an agent's is held.
    this.recordAs(opts.sender, {
      type: 'message.sent',
      messageId,
      agentId,
      sender: opts.sender,
      text,
      interrupt: opts.interrupt ?? false,
      ...(opts.origin ? { origin: opts.origin } : {}),
      ...(opts.turn ? { turn: true as const } : {}),
      ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
    });
    if (live.mailbox && !opts.turn) {
      // Logged only: the brain's mailbox picks it up from the log and folds it into a turn.
      return {
        id: messageId,
        agentId,
        text,
        sender: opts.sender,
        interrupt: opts.interrupt ?? false,
        queuedAt: this.now(),
      };
    }
    // An agent without a mailbox gets the text as typed: a reply carries its quote in front of it
    // (a brain's turn prompt renders it instead, `wake.ts`).
    return live.inbox.enqueue(opts.replyTo ? withQuote(text, opts.replyTo) : text, {
      sender: opts.sender,
      interrupt: opts.interrupt ?? false,
      id: messageId,
    });
  }

  /**
   * Types one line into a terminal agent's terminal now, whatever its turn is doing (P8-08): the
   * user's own keyboard, for a prompt the adapter did not recognise. Not queued — the inbox waits
   * for idle, a terminal waiting on an unrecognised prompt never is. Logged as the user's
   * `message.sent` (so the conversation shows it; secrets redacted, `redactSecrets`) and
   * `message.delivered` once typed; nothing is logged when the adapter refuses. The agent is then
   * busy (`idle = false`, the inbox `working()`): typed while idle, the line opens a turn in the
   * adapter, and queued messages wait for its end. Refused for a runtime without a terminal, an agent that is
   * stopping, and on a full disk (checked first: the line must not reach the terminal unlogged).
   */
  async typeInto(
    agentId: Id,
    text: string,
    opts: { by: Actor; origin?: RequestOrigin },
  ): Promise<{ messageId: Id }> {
    const live = this.must(agentId);
    const { adapter } = live;
    if (!adapter.input) {
      throw new Error(`agent ${agentId} has no terminal (runtime ${live.agent.runtime})`);
    }
    if (live.capStop || live.stopRequested || live.terminal) {
      throw new Error(`agent ${agentId} is stopping`);
    }
    this.ensureWritable(opts.by);
    await adapter.input(this.session(live), text);
    if (!live.terminal) {
      // The line starts (or continues) work: the agent is busy until the adapter reports idle,
      // so the inbox holds queued messages meanwhile (the adapter reads the screen again).
      if (live.idle) live.turn = { text: undefined, interrupted: false };
      live.idle = false;
      if (!live.paused) live.inbox.working();
    }
    const messageId = `m-${randomUUID()}`;
    this.recordAs(opts.by, {
      type: 'message.sent',
      messageId,
      agentId,
      sender: opts.by,
      // Typed lines may carry a token pasted at a prompt: the log keeps the redacted form.
      text: redactSecrets(text),
      interrupt: false,
      ...(opts.origin ? { origin: opts.origin } : {}),
    });
    if (!live.terminal) this.record({ type: 'message.delivered', messageId, agentId });
    return { messageId };
  }

  /**
   * Hands the agent's messages to its brain mailbox (P2-06): from now on `send()` without `turn`
   * logs `message.sent` and queues nothing, and the brain runner delivers whole turns.
   */
  attachMailbox(agentId: Id): void {
    this.must(agentId).mailbox = true;
  }

  /**
   * Replaces a live agent's adapter session with a fresh one on the same row (P2-06: a brain's
   * periodic session reset with a carried summary in `prompt`). The old session is logged
   * `agent.interrupted{reason}` and stopped; its stragglers are dropped; then the adapter spawns
   * a new session with the original options and `agent.spawned` reports the new `sessionRef`.
   * Messages still queued in the old inbox are not carried over (a brain's inbox is empty
   * between turns). Refused while a stop is under way.
   */
  async renewSession(agentId: Id, prompt: string, reason = 'session reset'): Promise<SpawnResult> {
    if (this.disposed) throw new Error('runtime disposed');
    const live = this.must(agentId);
    if (!live.handle) return { ok: false, reason: `agent ${agentId} has no session yet` };
    if (live.capStop || live.stopRequested || live.terminal) {
      return { ok: false, reason: `agent ${agentId} is stopping` };
    }
    const { adapter, spec, mailbox } = live;
    const sessionId = live.handle.sessionId;
    const pending = live.inbox.pending().map((m) => m.id);
    // Same agent row, new session: its held questions stay with it (it lives on).
    this.recordEnd(
      live,
      { type: 'agent.interrupted', agentId, reason, pending },
      'agent.interrupted',
      { keepHeld: true },
    );
    try {
      await adapter.stop(sessionId);
    } catch (error) {
      this.onError(error, `renew stop ${agentId}`);
    }
    // The old session's own `agent.stopped` travels through the event queue: let the pump drop
    // it as a straggler before the new session registers under the same id.
    await new Promise((resolve) => setImmediate(resolve));
    const agent = this.opts.log.tables.agents.get(agentId) ?? live.agent;
    const gate = this.caps.canSpawn(this.spawnCheck(agent.role, agent.supervisorId, true));
    if (!gate.ok) return { ok: false, reason: gate.reason };
    this.ended.delete(agentId);
    const result = await this.start(
      agent,
      { ...spec, prompt },
      adapter,
      (opts) => adapter.spawn(opts),
      false,
    );
    const next = this.live.get(agentId);
    if (result.ok && next && mailbox) next.mailbox = true;
    return result;
  }

  /**
   * A silence the status store detected (corner case 2, P8-04): logged as `agent.stalled` — a real
   * event that wakes the agent's supervisor (the brains' wake rules) and stays in the history.
   * Only for a running, unpaused session of this runtime; output brings the agent back to
   * `working` without an event, and the next silence is logged again.
   */
  noteStalled(agentId: Id, silentForMs: number): void {
    const live = this.live.get(agentId);
    if (!live?.handle || live.terminal || live.paused || this.disposed) return;
    this.record({ type: 'agent.stalled', agentId, silentForMs: Math.round(silentForMs) });
  }

  /**
   * Where a permission request's call is judged (P9-17): the asking agent's project — a Steward's
   * is its task's — its table, and the context its gate uses (workspace, cwd, aliases, the
   * deliverables folder). `undefined` for an agent this runtime does not run.
   */
  permissionContext(
    agentId: Id,
  ): { projectId: Id | undefined; policy: PermissionPolicy; ctx: PolicyContext } | undefined {
    const live = this.live.get(agentId);
    if (!live) return undefined;
    const req = live.spec;
    const workspace = this.workspaceOf(agentId, req);
    const userFolders = this.userFoldersOf(agentId, req);
    return {
      projectId: this.projectIdOf(agentId, req),
      policy: this.policyOf(agentId, req),
      ctx: {
        workspace,
        cwd: req.cwd,
        aliases: aliasesOf(workspace, req.cwd),
        ...(userFolders.length > 0 ? { userFolders } : {}),
      },
    };
  }

  /** Whether a live session asked `questionId` and waits for its answer through the adapter. */
  hasQuestion(questionId: Id): boolean {
    return this.byQuestion.has(questionId);
  }

  async answer(
    questionId: Id,
    answer: string,
    by: Actor,
    answerId?: string,
    repliedIn?: Id,
    detail?: SetAnswer,
  ): Promise<void> {
    const agentId = this.byQuestion.get(questionId);
    if (!agentId) throw new Error(`no open question ${questionId}`);
    const live = this.must(agentId);
    if (live.answering.has(questionId)) {
      throw new DomainError('stale', `question ${questionId} is already being answered`);
    }
    // The full check before the agent sees anything; afterwards the record only needs it open.
    const current = this.opts.log.tables.questions.get(questionId);
    if (!current) throw new Error(`no open question ${questionId}`);
    checkAnswer(current, { questionId, answer, answeredBy: by });
    // The user's answer is refused whole while the disk is full (SPEC decision 99): checked
    // before the agent has it, since afterwards the record can only be held.
    this.ensureWritable(by);
    // The adapter first: a question it no longer knows (re-asked after a resume) must not leave
    // an answer in the log that the agent never saw.
    live.answering.add(questionId);
    try {
      await live.adapter.answer(questionId, answer);
    } finally {
      live.answering.delete(questionId);
    }
    live.questions.delete(questionId);
    this.byQuestion.delete(questionId);
    // Not `command()`: a refused record (the question was cancelled meanwhile) reaches the caller.
    // The agent has the answer: a write the storage refuses is held and written later (P8-04).
    this.recordOrHold((ctx) =>
      answerQuestion(ctx, {
        questionId,
        answer,
        answeredBy: by,
        holders: holdersNow(ctx, questionId, this.questions),
        delivered: true,
        ...(answerId !== undefined ? { answerId } : {}),
        ...(repliedIn !== undefined ? { repliedIn } : {}),
        ...(detail !== undefined ? { detail } : {}),
      }),
    );
  }

  /**
   * Dismisses a question a live session waits on (P9-14, SPEC decision 135): the adapter first —
   * a clarification is declined with `reason`, a permission request denied, never allowed — then
   * `question.cancelled` with `by` (and the user's `origin`), so the log never says "dismissed"
   * for a question the agent still waits on. Refused like an answer: the full check first, and
   * whole on a full disk for the user's own dismissal (decision 99).
   */
  async dismiss(questionId: Id, reason: string, dismissal: Dismissal): Promise<void> {
    const agentId = this.byQuestion.get(questionId);
    if (!agentId) throw new Error(`no open question ${questionId}`);
    const live = this.must(agentId);
    if (live.answering.has(questionId)) {
      throw new DomainError('stale', `question ${questionId} is already being answered`);
    }
    const current = this.opts.log.tables.questions.get(questionId);
    if (!current) throw new Error(`no open question ${questionId}`);
    checkDismiss(current, dismissal.by);
    this.ensureWritable(dismissal.by);
    live.answering.add(questionId);
    let unblocked: boolean | void = true;
    try {
      if (live.adapter.dismiss) unblocked = await live.adapter.dismiss(questionId, reason);
      // An adapter without `dismiss`: a permission is refused, a clarification gets the reason.
      else if (current.kind === 'permission')
        await live.adapter.answer(questionId, `no (${reason})`);
      else await live.adapter.answer(questionId, `(no answer: ${reason})`);
    } finally {
      live.answering.delete(questionId);
    }
    live.questions.delete(questionId);
    this.byQuestion.delete(questionId);
    this.recordOrHold((ctx) =>
      cancelQuestion(
        ctx,
        questionId,
        reason,
        holdersNow(ctx, questionId, this.questions),
        // A terminal's prompt still up: the status store keeps the agent waiting.
        unblocked === false ? { ...dismissal, stillWaiting: true } : dismissal,
      ),
    );
  }

  async pause(agentId: Id, by: Actor): Promise<void> {
    const live = this.must(agentId);
    if (live.paused) return;
    const session = this.session(live); // no session yet: refused before anything is logged
    this.recordAs(by, { type: 'control.pause', target: { kind: 'agent', id: agentId }, by });
    live.paused = true;
    live.inbox.paused();
    // A paused agent's wall clock stops (its cap counts working time only).
    this.caps.pause(agentId);
    try {
      await live.adapter.pause(session);
    } catch (error) {
      // The adapter refused (nothing to freeze): the runtime is not paused either.
      live.paused = false;
      live.inbox.resumed(live.idle);
      this.caps.resume(agentId);
      throw error;
    }
  }

  async resumeAgent(agentId: Id, by: Actor): Promise<void> {
    const live = this.must(agentId);
    if (!live.paused) return;
    const session = this.session(live);
    this.recordAs(by, { type: 'control.resume', target: { kind: 'agent', id: agentId }, by });
    await live.adapter.resume(session); // a failure leaves the agent paused, as the adapter is
    this.unpaused(live);
  }

  /** The runtime's side of a resume: delivery restarts (an interrupt queued meanwhile first). */
  private unpaused(live: Live): void {
    if (!live.paused) return;
    live.paused = false;
    this.caps.resume(live.agent.id);
    live.inbox.resumed(live.idle);
  }

  /** Cancels the current turn. A paused agent is resumed first: a frozen one cannot end a turn. */
  async interrupt(agentId: Id): Promise<void> {
    const live = this.must(agentId);
    if (live.paused) await this.resumeAgent(agentId, SYSTEM);
    live.turn.interrupted = true;
    await live.adapter.interrupt(this.session(live));
  }

  /**
   * Graceful stop. Ends in exactly one terminal event: the adapter's `agent.stopped`, or — if
   * the adapter's stop resolved without one — `agent.stopped{by}` from the runtime, or
   * `agent.failed(runtime)` when the adapter's stop threw (P1-32: never an unkillable agent).
   */
  async stop(agentId: Id, by: Actor): Promise<void> {
    const live = this.live.get(agentId);
    if (!live || !live.handle || live.terminal) return;
    const sessionId = live.handle.sessionId;
    if (!live.stopRequested && !live.capStop) {
      this.recordAs(by, { type: 'control.stop', target: { kind: 'agent', id: agentId }, by });
      live.stopRequested = by;
    }
    try {
      await live.adapter.stop(sessionId);
    } catch (error) {
      this.onError(error, `stop ${agentId}`);
      if (live.capStop) this.failForCap(live);
      else {
        this.recordEnd(
          live,
          {
            type: 'agent.failed',
            agentId,
            error: `stop failed: ${(error as Error).message}`,
            reason: 'runtime',
          },
          'agent.failed',
        );
      }
      return;
    }
    // The adapter's own `agent.stopped` travels through its event queue: let it arrive first.
    await new Promise((resolve) => setImmediate(resolve));
    if (live.terminal) return;
    if (live.capStop) this.failForCap(live);
    else this.recordEnd(live, { type: 'agent.stopped', agentId, by }, 'agent.stopped');
  }

  /**
   * Graceful shutdown (P1-14, P1-15, P1-32; SPEC decision 8). Every live agent's fate is logged
   * first — `agent.interrupted{pending}` (its session ref is already on the row), or, when a stop
   * or a cap stop was already under way, the `agent.stopped` / `agent.failed(cap)` it was heading
   * for, so the next start does not resume an agent the user stopped — and the transcripts are
   * flushed; then every process is stopped in parallel. Events the adapters emit afterwards are
   * dropped: the log already says how each agent ended.
   */
  async shutdown(reason = 'server shutdown'): Promise<Id[]> {
    const interrupted: Id[] = [];
    const stops: { live: Live; sessionId: string }[] = [];
    // Stewards first (P2-16): their own questions go before their supervisors' held ones move up.
    const deepestFirst = [...this.live.values()].sort(
      (a, b) => this.depth(b.agent.id) - this.depth(a.agent.id),
    );
    for (const live of deepestFirst) {
      if (live.terminal) continue;
      const agentId = live.agent.id;
      if (live.capStop) this.failForCap(live);
      else if (live.stopRequested) {
        this.recordEnd(
          live,
          { type: 'agent.stopped', agentId, by: live.stopRequested },
          'agent.stopped',
        );
      } else {
        const pending = live.inbox.pending().map((m) => m.id);
        this.recordEnd(
          live,
          { type: 'agent.interrupted', agentId, reason, pending },
          'agent.interrupted',
        );
        interrupted.push(agentId);
      }
      if (live.handle) stops.push({ live, sessionId: live.handle.sessionId });
    }
    try {
      this.opts.transcripts.flush();
    } catch (error) {
      this.onError(error, 'shutdown flush');
    }
    // A last try for what the storage refused; what is still held is lost with the process, and
    // the next start treats those agents as a crash would (P8-04).
    if (this.writeHeld() > 0) {
      this.onError(
        new Error(`${this.held.length} agent events could not be written before the shutdown`),
        'storage',
      );
    }
    const results = await Promise.allSettled(
      stops.map(({ live, sessionId }) => live.adapter.stop(sessionId)),
    );
    results.forEach((r, i) => {
      if (r.status === 'rejected')
        this.onError(r.reason, `shutdown stop ${stops[i]!.live.agent.id}`);
    });
    return interrupted;
  }

  /**
   * Startup recovery (P1-14, P1-29, P1-33). Agents whose last state is live died with the
   * previous server (nothing can re-attach to a live process): an agent with a stop under way is
   * marked `agent.stopped`, the others `agent.interrupted`. Every interrupted agent whose runtime
   * can resume is then reopened through `recoverAgent()`. The log is read once.
   */
  async recover(): Promise<RecoveryReport> {
    const report: RecoveryReport = { resumed: [], needAttention: [] };
    const histories = this.histories();
    // Agents the previous server created but never started (P8-04): no status record, so the
    // pass below would not see them. Interrupted like the others; they come back fresh (no
    // session to resume) — a brain re-seeded from the database, a Steward from its first prompt.
    // One whose stop was logged meanwhile (its own, or its task's or project's) ends stopped, as
    // a live one with a stop under way does below: it is not started again.
    for (const agent of this.opts.log.tables.agents.all()) {
      if (this.live.has(agent.id) || isHarnessMeta(agent.meta)) continue;
      const history = histories.get(agent.id);
      if (!history?.neverStarted()) continue;
      const stoppedBy = history.stopRequested;
      this.command(({ emit }) =>
        emit(
          stoppedBy
            ? { type: 'agent.stopped', agentId: agent.id, by: stoppedBy }
            : {
                type: 'agent.interrupted',
                agentId: agent.id,
                reason: 'server restarted before the agent started',
              },
        ),
      );
    }
    // Stewards first, supervisors last (P2-16): an agent's own questions are cancelled before the
    // questions its supervisor holds are moved up, so nothing climbs the chain for nothing.
    const deepestFirst = [...this.opts.statuses.all()].sort(
      (a, b) => this.depth(b.agentId) - this.depth(a.agentId),
    );
    for (const record of deepestFirst) {
      if (!LIVE_STATES.has(record.state) || this.live.has(record.agentId)) continue;
      // A scene-harness fake agent (P4-06) never had a process: it ends stopped, never reopened.
      const fake = isHarnessMeta(this.opts.log.tables.agents.get(record.agentId)?.meta);
      const stoppedBy: Actor | undefined = fake
        ? { type: 'system' }
        : histories.get(record.agentId)?.stopRequested;
      this.command((ctx) => {
        ctx.emit(
          stoppedBy
            ? { type: 'agent.stopped', agentId: record.agentId, by: stoppedBy }
            : { type: 'agent.interrupted', agentId: record.agentId, reason: 'server restarted' },
        );
        endAgentQuestions(
          ctx,
          record.agentId,
          stoppedBy ? 'stopped' : 'interrupted',
          this.questions,
        );
      });
    }
    // One Harmonizer at a time (SPEC decision 32): of several interrupted ones, only the newest
    // comes back; the others stay interrupted for the user to look at.
    const created = new Map(this.opts.log.tables.agents.all().map((a, i) => [a.id, i]));
    const harmonizers = this.opts.statuses
      .all()
      .filter((r) => r.state === 'interrupted')
      .map((r) => this.opts.log.tables.agents.get(r.agentId))
      .filter((a): a is Agent => a?.role === 'harmonizer')
      // Newest first; rows created in the same millisecond by creation order (the table's).
      .sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) ||
          (created.get(b.id) ?? 0) - (created.get(a.id) ?? 0),
      );
    const passedOver = new Set(harmonizers.slice(1).map((a) => a.id));
    // Supervisors before their Stewards (P2-16, P2-03): a resumed Steward re-asks its questions,
    // and they must find its Waykeeper (or the Harmonizer) running, not climb to the user.
    const interrupted = this.opts.statuses
      .all()
      .filter((r) => r.state === 'interrupted')
      .sort((a, b) => this.depth(a.agentId) - this.depth(b.agentId));
    // On their way back (P2-16): a brain resumed before its Stewards must not replace them.
    for (const r of interrupted) if (!passedOver.has(r.agentId)) this.reserved.add(r.agentId);
    for (const record of interrupted) {
      if (passedOver.has(record.agentId)) {
        report.needAttention.push(record.agentId);
        this.releaseHeld(record.agentId, 'was not resumed (one Harmonizer at a time)');
        this.flagNeedsAttention(record.agentId, 'not resumed: one Harmonizer at a time');
        continue;
      }
      let result: SpawnResult;
      try {
        result = await this.recoverOne(record.agentId, histories.get(record.agentId));
      } finally {
        this.reserved.delete(record.agentId);
      }
      if (result.ok) report.resumed.push(record.agentId);
      else {
        this.onError(new Error(result.reason), `recover ${record.agentId}`);
        report.needAttention.push(record.agentId);
        this.releaseHeld(record.agentId, 'could not be resumed');
        this.flagNeedsAttention(record.agentId, result.reason);
      }
    }
    this.reserved.clear();
    return report;
  }

  /**
   * Reopens one interrupted agent from its session ref (the panel's "Resume session", P1-29):
   * refused unless the agent is `interrupted` and not running. The permission policy, workspace
   * and `bare` come from the agent's saved spawn options; every message sent to it that it never
   * received is delivered again, with its original id, before anything new.
   */
  async recoverAgent(agentId: Id): Promise<SpawnResult> {
    return this.recoverOne(agentId, undefined, { restart: true });
  }

  /**
   * Who reopens brains (P2-16): the composition registers its brain definitions here, so startup
   * recovery and the panel's resume action bring a Harmonizer or Waykeeper back through its
   * runner — tools, system prompt and mailbox — never as a bare session.
   */
  setBrainResumer(resumer: BrainResumer | undefined): void {
    this.brainResumer = resumer;
  }

  /** Who gives Stewards the server's tools (P9-04): the composition registers it. */
  setStewardTools(tools: StewardTools | undefined): void {
    this.stewardTools = tools;
  }

  /** The tools of a start: the request's own, else a Steward's on a runtime that serves them. */
  private toolsOf(agent: Agent, req: SpawnRequest): ToolDefinition[] | undefined {
    if (req.tools) return req.tools;
    if (agent.role !== 'steward' || !agent.taskId || !TOOL_RUNTIMES.has(agent.runtime)) {
      return undefined;
    }
    const tools = this.stewardTools?.(agent);
    return tools && tools.length > 0 ? tools : undefined;
  }

  /**
   * Reopens one interrupted agent with explicit options (P2-16: a brain runner reopening its
   * brain). Refused unless the agent is `interrupted` and not running; one Harmonizer at a time.
   * Tries the session ref first; with `freshPrompt`, falls back to a fresh session on the same
   * row. Does not consult the brain resumer.
   */
  async reopen(agentId: Id, opts: ReopenOptions = {}): Promise<ReopenResult> {
    return this.reopenOne(agentId, undefined, opts);
  }

  /**
   * `restart` (the user's action, never startup recovery): an agent whose runtime cannot resume
   * sessions (PTY, P8-08; TECHNOLOGY §3.3) starts again afresh from its first prompt, in the same
   * working directory — the "restart" its interrupted state offers. Startup leaves it interrupted.
   */
  private async recoverOne(
    agentId: Id,
    history: AgentHistory | undefined,
    how: { restart?: boolean } = {},
  ): Promise<SpawnResult> {
    const refused = this.refuseReopen(agentId);
    if (refused) return refused;
    const agent = this.opts.log.tables.agents.get(agentId)!;
    const viaBrain = this.brainResumer?.(agent);
    if (viaBrain) return viaBrain;
    const prompt = (agent.meta as { prompt?: unknown } | undefined)?.prompt;
    if (
      how.restart &&
      this.adapters.get(agent.runtime)?.resumeSession === undefined &&
      typeof prompt === 'string'
    ) {
      return this.reopenOne(agentId, history, { freshPrompt: prompt });
    }
    return this.reopenOne(agentId, history, {});
  }

  /** Why `agentId` cannot be reopened now, or `undefined`. */
  private refuseReopen(agentId: Id): { ok: false; reason: string } | undefined {
    if (this.live.has(agentId)) return { ok: false, reason: `agent ${agentId} is running` };
    const state = this.opts.statuses.get(agentId)?.state;
    if (state !== 'interrupted') {
      return { ok: false, reason: `agent ${agentId} is ${state ?? 'unknown'}, not interrupted` };
    }
    const agent = this.opts.log.tables.agents.get(agentId);
    if (!agent) return { ok: false, reason: `no agent ${agentId}` };
    const running = (same: (other: Agent) => boolean) =>
      [...this.live.values()].find(
        (l) => l.agent.id !== agentId && l.agent.role === agent.role && same(l.agent),
      )?.agent;
    if (agent.role === 'harmonizer') {
      const other = running(() => true);
      if (other) return { ok: false, reason: `the Harmonizer is already running (${other.id})` };
    }
    // One Steward per task and one Waykeeper per project (P2-16): an interrupted one is not
    // brought back beside the agent that replaced it.
    if (agent.role === 'steward' && agent.taskId) {
      const other = running((a) => a.taskId === agent.taskId);
      if (other) {
        return {
          ok: false,
          reason: `task ${agent.taskId} already has a running Steward (${other.id})`,
        };
      }
    }
    if (agent.role === 'waykeeper' && agent.projectId) {
      const other = running((a) => a.projectId === agent.projectId);
      if (other) {
        return {
          ok: false,
          reason: `project ${agent.projectId} already has a running Waykeeper (${other.id})`,
        };
      }
    }
    return undefined;
  }

  /**
   * The agent is interrupted and startup recovery is about to reopen it (P2-16). The spawn guards
   * count it as running: a supervisor resumed first must not spawn its replacement.
   */
  isReserved(agentId: Id): boolean {
    return this.reserved.has(agentId) || this.refreshing.has(agentId);
  }

  /**
   * A resumed session's first message (dev-machine run, 2026-10-02). The restart cancelled the
   * agent's open questions (decision 21) and the model is not told by its session, so with only
   * "continue" it goes idle instead of asking again. The message names what the agent was
   * waiting for — the questions cancelled in the same command as its last interruption — and asks
   * it to ask again (a clarification through its question tool, a refused tool call by running it
   * again, so the gate decides it afresh).
   */
  private resumePromptFor(agentId: Id): string {
    const { log } = this.opts;
    const [interrupted] = log.latestOf('agent.interrupted', agentId, 1);
    if (!interrupted) return RESUME_PROMPT;
    const cancelled = log
      .latestOf('question.cancelled', agentId, 20)
      .filter((e) => e.seq > interrupted.seq && e.at === interrupted.at)
      .map((e) => log.tables.questions.get((e.event as { questionId: Id }).questionId))
      .filter((q): q is NonNullable<typeof q> => q !== undefined);
    if (cancelled.length === 0) return RESUME_PROMPT;
    const lines = cancelled.map((q) =>
      q.kind === 'permission'
        ? `- you were waiting for permission to run ${q.context.toolCall?.toolName ?? 'a tool'} (${q.context.text}); run that tool call again if you still need it`
        : `- you had asked: "${q.context.text}"${q.context.options?.length ? ` (options: ${q.context.options.join(', ')})` : ''}; ask it again with your question tool`,
    );
    return (
      `${RESUME_PROMPT}\nBefore the restart you were waiting for an answer; it was cancelled by ` +
      `the restart:\n${lines.join('\n')}\nAsk it again before you continue.`
    );
  }

  private async reopenOne(
    agentId: Id,
    known: AgentHistory | undefined,
    opts: ReopenOptions,
  ): Promise<ReopenResult> {
    const refused = this.refuseReopen(agentId);
    if (refused) return refused;
    const agent = this.opts.log.tables.agents.get(agentId)!;
    const meta = (agent.meta ?? {}) as {
      cwd?: string;
      prompt?: string;
      workspace?: string;
      permissionPolicy?: PermissionPolicy;
      bare?: boolean;
    };
    if (!meta.cwd) return { ok: false, reason: 'agent has no saved working directory' };
    const base = {
      cwd: meta.cwd,
      ...(meta.workspace ? { workspace: meta.workspace } : {}),
      ...(meta.permissionPolicy ? { permissionPolicy: meta.permissionPolicy } : {}),
      ...(meta.bare ? { bare: true } : {}),
      ...(opts.tools ? { tools: opts.tools } : {}),
      ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
    };
    const mailbox = opts.mailbox ?? false;
    const folded = opts.foldedUpTo !== undefined ? { foldedUpTo: opts.foldedUpTo } : {};
    // An agent whose session never started (P8-04) starts now, from its own first prompt.
    let history = known;
    const historyOf = () => (history ??= this.histories(new Set([agentId])).get(agentId));
    const freshPrompt =
      opts.freshPrompt ??
      (!agent.sessionRef && meta.prompt && historyOf()?.spawned === false
        ? meta.prompt
        : undefined);
    const fresh =
      freshPrompt !== undefined
        ? {
            req: { ...base, role: agent.role, runtime: agent.runtime, prompt: freshPrompt },
            mailbox,
            ...folded,
          }
        : undefined;
    let mode: 'resumed' | 'fresh' = 'resumed';
    // An end before the resumed session's first turn ended is a failed resume too (P2-16): the
    // SDK returns the handle at once and a lost session only shows when the CLI exits.
    let result = await this.resume(
      agent,
      { ...base, prompt: opts.prompt ?? this.resumePromptFor(agentId) },
      {
        mailbox,
        ...folded,
        probation: {
          ...(fresh ? { fresh } : {}),
          ...(opts.onFallback ? { onFallback: opts.onFallback } : {}),
        },
      },
    );
    if (!result.ok && fresh && !this.live.has(agentId)) {
      // The session is gone (or never resumable): a fresh one on the same row, re-seeded from the
      // database by the caller's prompt. A failed resume left the agent interrupted, as it must be.
      mode = 'fresh';
      result = await this.resume(this.opts.log.tables.agents.get(agentId) ?? agent, fresh.req, {
        fresh: true,
        mailbox,
        ...folded,
      });
    }
    if (!result.ok) return result;
    if (!mailbox) {
      const live = this.live.get(agentId);
      for (const m of historyOf()?.undelivered() ?? []) {
        // A reply carries its quote again, as `send` delivered it (P8-17 review).
        const text = m.replyTo ? withQuote(m.text, m.replyTo) : m.text;
        live?.inbox.enqueue(text, { sender: m.sender, id: m.messageId, interrupt: false });
      }
    }
    return { ...result, mode };
  }

  /** How many supervisors are above the agent (the Harmonizer is 0). */
  private depth(agentId: Id): number {
    const { agents } = this.opts.log.tables;
    let depth = 0;
    const seen = new Set<Id>([agentId]);
    for (let a = agents.get(agentId); a?.supervisorId && !seen.has(a.supervisorId); depth++) {
      seen.add(a.supervisorId);
      a = agents.get(a.supervisorId);
    }
    return depth;
  }

  /**
   * What the log says about agents (one pass, paged): whether a stop was under way when the
   * server died, and which `message.sent` messages never got a `message.delivered`.
   */
  private histories(only?: ReadonlySet<Id>): Map<Id, AgentHistory> {
    const out = new Map<Id, AgentHistory>();
    const of = (id: Id) => {
      let h = out.get(id);
      if (!h) out.set(id, (h = new AgentHistory()));
      return h;
    };
    /** Stops and cancels of tasks and projects, for the agents that never started (P8-04). */
    const workStops: { kind: 'task' | 'project'; id: Id; seq: number; by: Actor }[] = [];
    const PAGE = 5_000;
    let since = 0;
    for (;;) {
      const page = this.opts.log.eventsSince(since, PAGE);
      for (const { seq, event: ev } of page) {
        since = seq;
        switch (ev.type) {
          case 'agent.created':
            if (!only || only.has(ev.agent.id)) {
              of(ev.agent.id).created = true;
              of(ev.agent.id).createdSeq = seq;
            }
            break;
          case 'control.cancel':
            if (ev.target.kind !== 'agent') {
              workStops.push({ kind: ev.target.kind, id: ev.target.id, seq, by: ev.by });
            }
            break;
          case 'agent.spawned':
            if (!only || only.has(ev.agentId)) {
              of(ev.agentId).stopRequested = undefined;
              of(ev.agentId).spawned = true;
            }
            break;
          case 'control.stop':
            if (ev.target.kind === 'agent') {
              if (!only || only.has(ev.target.id)) of(ev.target.id).stopRequested = ev.by;
            } else workStops.push({ kind: ev.target.kind, id: ev.target.id, seq, by: ev.by });
            break;
          case 'agent.stopped':
          case 'agent.finished':
          case 'agent.failed':
          case 'agent.interrupted':
            if (!only || only.has(ev.agentId)) {
              of(ev.agentId).stopRequested = undefined;
              of(ev.agentId).ended = true;
            }
            break;
          case 'message.sent':
            if (!only || only.has(ev.agentId)) of(ev.agentId).sent.push(ev);
            break;
          case 'message.delivered':
            if (!only || only.has(ev.agentId)) of(ev.agentId).delivered.add(ev.messageId);
            break;
          default:
            break;
        }
      }
      if (page.length < PAGE) break;
    }
    // An agent caught before it started whose task or project was stopped or cancelled after its
    // row was made: the stop concerned it too (its session would have been stopped).
    for (const [id, history] of out) {
      if (!history.neverStarted() || history.stopRequested) continue;
      const agent = this.opts.log.tables.agents.get(id);
      const stop = workStops.find(
        (s) =>
          s.seq > history.createdSeq &&
          ((s.kind === 'task' && s.id === agent?.taskId) ||
            (s.kind === 'project' && s.id === agent?.projectId)),
      );
      if (stop) history.stopRequested = stop.by;
    }
    return out;
  }

  /** Stops every live agent (graceful) and closes the adapters. */
  async dispose(): Promise<void> {
    this.disposed = true;
    clearTimeout(this.heldTimer);
    this.heldTimer = undefined;
    this.unhook();
    const stops = await Promise.allSettled(this.liveAgents().map((a) => this.stop(a.id, SYSTEM)));
    for (const s of stops) if (s.status === 'rejected') this.onError(s.reason, 'dispose stop');
    const disposals = await Promise.allSettled([...this.adapters.values()].map((a) => a.dispose()));
    for (const d of disposals)
      if (d.status === 'rejected') this.onError(d.reason, 'dispose adapter');
    await Promise.allSettled(this.pumps);
    this.caps.dispose();
  }

  // ---------------------------------------------------------------------------

  /**
   * Listens to every turn end of every agent (P2-11: a Steward's report to its supervisor).
   * Called synchronously after the `agent.idle` is logged and before the next queued message is
   * delivered. Returns the unsubscribe function.
   */
  onTurnEnded(listener: (turn: TurnEnd) => void): () => void {
    this.turnListeners.add(listener);
    return () => this.turnListeners.delete(listener);
  }

  /** The agent has a brain mailbox (P2-06): messages to it are folded into its turns. */
  hasMailbox(agentId: Id): boolean {
    return this.live.get(agentId)?.mailbox ?? false;
  }

  private turnEnded(live: Live, turn: Live['turn']): void {
    const resumed = live.resumedTurn;
    live.resumedTurn = false;
    if (this.turnListeners.size === 0) return;
    const end: TurnEnd = {
      agent: live.agent,
      text: turn.text === undefined ? undefined : redactSecrets(turn.text),
      interrupted:
        turn.interrupted ||
        live.paused ||
        live.stopRequested !== undefined ||
        live.capStop !== undefined ||
        live.terminal !== undefined,
      queued: live.inbox.pending().length,
      resumed,
    };
    for (const listener of this.turnListeners) {
      try {
        listener(end);
      } catch (error) {
        this.onError(error, `turn end of ${live.agent.id}`);
      }
    }
  }

  private must(agentId: Id): Live {
    const live = this.live.get(agentId);
    if (!live) throw new Error(`agent ${agentId} is not running`);
    return live;
  }

  /** The agent's project workspace now (a moved workspace applies at once), else the spawn's. */
  private workspaceOf(agentId: Id, req: SpawnRequest): string {
    const { tables } = this.opts.log;
    const projectId = this.projectIdOf(agentId, req);
    const project = projectId ? tables.projects.get(projectId) : undefined;
    return project?.workspace ?? req.workspace ?? req.cwd;
  }

  /**
   * How the gate learns where a project's deliverables folder would be before it is recorded
   * (`DeliverableCopies.placeOf`, which asks whether `deliverables/` is tracked). Looked up once
   * per spawn, without holding the spawn up: until it answers, `<workspace>/deliverables`.
   */
  setDeliverablesFolderLookup(
    lookup: (target: { projectId?: Id; taskId?: Id }) => Promise<string | undefined>,
  ): void {
    this.folderLookup = lookup;
  }

  private lookUpFolderCandidate(agentId: Id, req: SpawnRequest): void {
    const lookup = this.folderLookup;
    if (!lookup) return;
    const agent = this.opts.log.tables.agents.get(agentId);
    const projectId = agent?.projectId ?? req.projectId;
    const taskId = agent?.taskId ?? req.taskId;
    if (!projectId && !taskId) return;
    void lookup({ ...(projectId ? { projectId } : {}), ...(taskId ? { taskId } : {}) })
      .then((folder) => {
        if (folder && this.live.has(agentId)) this.folderCandidates.set(agentId, folder);
      })
      .catch(() => undefined);
  }

  private userFoldersOf(agentId: Id, req: SpawnRequest): string[] {
    const { tables } = this.opts.log;
    const agent = tables.agents.get(agentId);
    const candidate = this.folderCandidates.get(agentId);
    return userFoldersOf(
      {
        project: (id) => tables.projects.get(id),
        task: (id) => tables.tasks.get(id),
        projects: () => tables.projects.all(),
      },
      {
        projectId: agent?.projectId ?? req.projectId,
        taskId: agent?.taskId ?? req.taskId,
      },
      this.workspaceOf(agentId, req),
      candidate,
    );
  }

  /**
   * The agent's project now (a Steward's is its task's), else the spawn's: the one resolver for
   * its table, its workspace and its "Allow similar" rules (P9-17 review S7), so the table and
   * the rules always come from the same project.
   */
  private projectIdOf(agentId: Id, req: SpawnRequest): Id | undefined {
    const { tables } = this.opts.log;
    const agent = tables.agents.get(agentId);
    if (agent?.projectId) return agent.projectId;
    const taskId = agent?.taskId ?? req.taskId;
    return (taskId ? tables.tasks.get(taskId)?.projectId : undefined) ?? req.projectId;
  }

  /**
   * The "Allow similar" rules of the agent's project (P9-17, decision 138), read on every check:
   * a rule added or removed applies to the next tool call. None outside a project.
   */
  private rulesOf(agentId: Id, req: SpawnRequest): readonly PermissionRule[] {
    const projectId = this.projectIdOf(agentId, req);
    return (
      (projectId ? this.opts.log.tables.projects.get(projectId)?.permissionRules : undefined) ?? []
    );
  }

  /**
   * The policy an agent's permissions are decided under now (decision 22): its project's table
   * (the global default when the project has none), read on every check so a change applies to
   * the next tool call; an agent outside any project keeps the policy it was spawned with.
   */
  private policyOf(agentId: Id, req: SpawnRequest): PermissionPolicy {
    const { tables } = this.opts.log;
    const projectId = this.projectIdOf(agentId, req);
    const project = projectId ? tables.projects.get(projectId) : undefined;
    // No table of its own: the global default as it is now (P25-01: the settings may change it).
    if (project) return project.permissionPolicy ?? globalDefaultPolicy();
    return req.permissionPolicy ?? globalDefaultPolicy();
  }

  /**
   * Permission routing (P2-04; SPEC §2.6, decision 7): a permission request is decided by the
   * agent's gate — the same decision the adapter's hook got — before any question exists. `allow`
   * and `deny` answer the adapter at once and log `permission.decided{decidedBy: system}`; no
   * question row is opened, so nothing waits on the user and nothing reaches a brain. `ask` (and
   * a request without a tool call, which nothing can judge) returns `false`: the caller opens the
   * user-held question. Decided on the raw call — the redacted one is what the log keeps.
   */
  private rulePermission(
    live: Live,
    raw: Extract<AgentEvent, { type: 'agent.needs_input' }>,
    event: Extract<AgentEvent, { type: 'agent.needs_input' }>,
  ): boolean {
    const call = raw.question.toolCall;
    if (!call) return false;
    const { verdict, action, ruleId } = live.gate.decide(call);
    if (verdict.decision === 'ask') {
      // The card shows the category the policy asks about when the adapter did not name one.
      const asked = verdict.action ?? action;
      if (!event.question.permissionAction && asked) event.question.permissionAction = asked;
      return false;
    }
    this.permissionDecided(
      live,
      {
        toolCall: event.question.toolCall ?? call,
        decision: verdict.decision,
        action,
        ...(verdict.decision === 'deny' ? { reason: verdict.reason } : {}),
        ...(ruleId ? { ruleId } : {}),
      },
      event.questionId,
    );
    live.idle = false;
    if (!live.paused) live.inbox.working();
    const answer = verdict.decision === 'allow' ? 'allow' : `deny: ${verdict.reason}`;
    void live.adapter
      .answer(event.questionId, answer)
      .catch((error: unknown) => this.onError(error, `permission answer ${event.questionId}`));
    return true;
  }

  /** Logs a decision the policy made without the user (P2-04), with the tool input redacted. */
  private permissionDecided(
    live: Live,
    d: {
      toolCall: ToolCall;
      decision: 'allow' | 'deny';
      action: PermissionAction | undefined;
      reason?: string;
      /** The "Allow similar" rule that allowed it (P9-17). */
      ruleId?: Id;
    },
    questionId?: Id,
  ): void {
    if (live.terminal) return;
    const event: Event = {
      type: 'permission.decided',
      agentId: live.agent.id,
      ...(questionId ? { questionId } : {}),
      toolCall: {
        toolName: d.toolCall.toolName,
        ...(d.toolCall.input !== undefined ? { input: redactValue(d.toolCall.input) } : {}),
      },
      decision: d.decision,
      ...(d.action ? { action: d.action } : {}),
      ...(d.reason ? { reason: redactSecrets(d.reason) } : {}),
      decidedBy: SYSTEM,
      ...(d.ruleId ? { ruleId: d.ruleId } : {}),
    };
    if (!live.handle) live.decisions.push(event);
    else this.record(event);
  }

  /** Appends an event under the one write rule; the status store sees it as a log subscriber. */
  private record(event: Event): void {
    this.command(({ emit }) => emit(event), 'command', event);
  }

  /**
   * Records an action taken by `by` (P8-04 review; SPEC decision 99): the user's is refused whole
   * with the storage error while the disk is full — it runs only once every held agent event is
   * written, and a refused write is thrown, never held; anyone else's is held like an agent event.
   */
  private recordAs(by: Actor, event: Event): void {
    if (by.type !== 'user') {
      this.record(event);
      return;
    }
    this.ensureWritable(by);
    this.opts.log.runCommand(({ emit }) => emit(event));
  }

  /**
   * Refuses the user's action with the storage error while agent events are still held (P8-04
   * review): they are written first, and if the storage still refuses them the action is not
   * taken at all. A no-op for anyone but the user and when nothing is held.
   */
  private ensureWritable(by: Actor): void {
    if (by.type !== 'user' || this.held.length === 0) return;
    this.writeHeld();
    if (this.held.length > 0) throw this.storageRefusal();
  }

  /** The log's before-command hook: drains what is held, or refuses the command whole. */
  private beforeCommand(): void {
    if (this.draining || this.held.length === 0) return;
    this.writeHeld();
    if (this.held.length > 0) throw this.storageRefusal();
  }

  /** The storage error a refused action gets (`isStorageFailure` holds for it). */
  private storageRefusal(): Error {
    const cause = this.storage.error;
    const code = (cause as { code?: unknown } | undefined)?.code;
    const error = new Error(
      `${cause instanceof Error ? cause.message : 'database or disk is full'} ` +
        `(${this.held.length} agent events wait to be written)`,
    ) as Error & { code?: string };
    error.code = typeof code === 'string' ? code : 'SQLITE_FULL';
    return error;
  }

  /**
   * Runs a domain command; a failure is reported, never thrown into the adapter's stream. A write
   * the storage refuses (a full disk) is held and retried in order (P8-04), never dropped — unless
   * the held queue outgrows its limits, when the oldest agent output goes first.
   */
  private command(fn: (ctx: CommandContext) => unknown, context = 'command', event?: Event): void {
    try {
      this.recordOrHold(fn, event);
    } catch (error) {
      this.onError(error, context);
    }
  }

  /**
   * Runs `fn` under the one write rule, or holds it when the storage refuses it (or earlier
   * writes are still held: the order is kept). It keeps the time it happened (`at`). Any other
   * failure is thrown.
   */
  private recordOrHold(fn: (ctx: CommandContext) => unknown, event?: Event): void {
    const at = this.opts.log.clock();
    if (this.held.length > 0) {
      this.hold({ fn, at, ...this.sizeOf(event) });
      return;
    }
    try {
      this.opts.log.runCommand(fn, { at });
    } catch (error) {
      if (!isStorageFailure(error)) throw error;
      this.storage = { since: at, error, dropped: 0, warnedFull: false };
      this.hold({ fn, at, ...this.sizeOf(event) });
      if (isPermanentStorageFailure(error)) {
        this.onError(
          new Error(
            `${(error as Error).message}: the database cannot be written at all (read-only or ` +
              'missing file). Agent events are held, within limits, until it can — fix the ' +
              "file's permissions or restore it; the user's actions are refused meanwhile",
          ),
          'storage (permanent)',
        );
      } else {
        this.onError(
          new Error(
            `${(error as Error).message}: agent events are held and written as soon as the ` +
              'database accepts writes again',
          ),
          'storage',
        );
      }
      this.retryHeld();
    }
  }

  private sizeOf(event: Event | undefined): { bytes: number; droppable: boolean } {
    if (!event) return { bytes: HELD_COMMAND_BYTES, droppable: false };
    return { bytes: JSON.stringify(event).length, droppable: DROPPABLE.has(event.type) };
  }

  /**
   * Queues a refused write; past the limits the oldest agent output is dropped (logged once per
   * episode), and only when there is none left the oldest write of any kind — the queue stays
   * bounded even when the storage never comes back.
   */
  private hold(write: HeldWrite): void {
    this.held.push(write);
    this.heldBytes += write.bytes;
    const limits = { ...DEFAULT_HELD_LIMITS, ...this.opts.heldLimits };
    while (this.held.length > limits.events || this.heldBytes > limits.bytes) {
      let i = this.held.findIndex((w) => w.droppable);
      if (i < 0) {
        i = 0;
        this.onError(
          new Error('the held queue holds only state changes: the oldest one is lost'),
          'storage',
        );
      }
      const [dropped] = this.held.splice(i, 1);
      this.heldBytes -= dropped!.bytes;
      this.storage.dropped += 1;
      if (!this.storage.warnedFull) {
        this.storage.warnedFull = true;
        this.onError(
          new Error(
            `${this.held.length} agent events are held (${Math.round(this.heldBytes / 2 ** 20)} ` +
              'MiB): the oldest agent output (tool calls, progress) is dropped from now on to ' +
              'stay within the limits',
          ),
          'storage',
        );
      }
    }
  }

  private retryHeld(): void {
    if (this.heldTimer || this.disposed) return;
    this.heldTimer = setTimeout(() => {
      this.heldTimer = undefined;
      this.writeHeld();
    }, this.opts.storageRetryMs ?? 1_000);
    this.heldTimer.unref?.();
  }

  /**
   * Writes the held events in order, each with the time it happened; stops at the first one the
   * storage still refuses and tries again later. One the log now refuses (a question answered
   * meanwhile) is reported and dropped, as it would have been at the time. Returns how many are
   * still held.
   */
  writeHeld(): number {
    if (this.draining) return this.held.length;
    const before = this.held.length;
    this.draining = true;
    try {
      // Subscribers of a written event may log more: they queue behind the ones being written.
      while (this.held.length > 0) {
        const write = this.held[0]!;
        try {
          this.opts.log.runCommand(write.fn, { at: write.at });
        } catch (error) {
          if (isStorageFailure(error)) {
            this.storage.error = error;
            this.retryHeld();
            return this.held.length;
          }
          this.onError(error, 'held command');
        }
        this.held.shift();
        this.heldBytes -= write.bytes;
      }
    } finally {
      this.draining = false;
    }
    this.heldBytes = 0;
    if (before > 0) {
      const dropped = this.storage.dropped;
      this.onError(
        new Error(
          `writes work again: ${before} held agent events written` +
            (dropped > 0 ? ` (${dropped} older agent output events were dropped)` : ''),
        ),
        'storage',
      );
      this.storage = { dropped: 0, warnedFull: false };
    }
    return 0;
  }

  /** Agent events waiting for the storage (P8-04). */
  get heldWrites(): number {
    return this.held.length;
  }

  /** The storage state for the panel (P8-09): what is held, since when, and why. */
  storageState(): StorageState {
    const error = this.storage.error;
    const code = (error as { code?: unknown } | undefined)?.code;
    const held = this.held.length > 0;
    return {
      held: this.held.length,
      bytes: this.heldBytes,
      dropped: this.storage.dropped,
      ...(held && this.storage.since ? { since: this.storage.since } : {}),
      ...(held && error ? { error: error instanceof Error ? error.message : String(error) } : {}),
      ...(held && typeof code === 'string' ? { code } : {}),
      permanent: held && isPermanentStorageFailure(error),
    };
  }

  private async pump(adapter: AgentAdapter): Promise<void> {
    try {
      for await (const event of adapter.events) {
        try {
          this.route(event);
        } catch (error) {
          // One bad event must not stop the stream: the next ones still reach the log.
          this.onError(error, `routing ${event.type} of ${event.agentId}`);
        }
      }
    } catch (error) {
      this.onError(error, `events of ${adapter.runtime}`);
    }
  }

  private route(raw: AgentEvent): void {
    const live = this.live.get(raw.agentId);
    if (!live) {
      // A straggler from an agent that already ended (its `agent.stopped` after a cap failure,
      // output after a crash) is expected and dropped; a stranger is an adapter bug.
      if (!this.ended.has(raw.agentId)) {
        this.onError(
          new Error(`${raw.type} for unknown agent ${raw.agentId}`),
          `routing ${raw.type}`,
        );
      }
      return;
    }
    if (!live.handle) {
      live.early.push(raw);
      return;
    }
    if (raw.type !== 'agent.idle' && !TERMINAL.has(raw.type)) live.activity = true;
    if (raw.type === 'agent.output') {
      // Raw text: the pipeline redacts with the context of the previous chunk (P1-31), which a
      // chunk redacted on its own would have lost.
      this.opts.transcripts.append(raw.agentId, raw.kind, raw.text);
      this.opts.statuses.touch(raw.agentId);
      if (!live.paused) live.idle = false;
      if (raw.kind === 'text' && raw.text.trim() !== '') live.turn.text = raw.text;
      return;
    }
    let event = redactEvent(raw);
    if (
      event.type === 'agent.finished' &&
      live.agent.role === 'steward' &&
      !event.result?.trim() &&
      live.turn.text !== undefined
    ) {
      // A Steward that finished without a result: its last words are its report (P2-11).
      event = { ...event, result: redactSecrets(live.turn.text) };
    }
    if (TERMINAL.has(event.type)) {
      this.terminal(live, event as Extract<AgentEvent, { type: Terminal }>);
      return;
    }
    if (
      event.type === 'agent.needs_input' &&
      event.kind === 'permission' &&
      raw.type === 'agent.needs_input' &&
      this.rulePermission(live, raw, event)
    ) {
      return;
    }
    if (event.type === 'agent.needs_input') {
      // The question row and the event in one transaction: the server owns questions (§5.3),
      // routed to its holder by the question service (P2-03).
      this.command((ctx) => {
        ctx.emit(event);
        openFromNeedsInput(ctx, event, this.questions);
      });
    } else if (event.type === 'agent.idle' && live.questions.size > live.answering.size) {
      // Idle while a question is open: an interrupt withdrew it (P1-34). Cancelled with the event.
      const withdrawn = [...live.questions].filter((q) => !live.answering.has(q));
      this.command((ctx) => {
        ctx.emit(event);
        for (const q of withdrawn) {
          cancelQuestion(
            ctx,
            q,
            'withdrawn: the agent went idle without an answer',
            holdersNow(ctx, q, this.questions),
          );
        }
      });
      for (const q of withdrawn) {
        live.questions.delete(q);
        this.byQuestion.delete(q);
      }
    } else {
      this.record(event);
    }
    // Caps after the log so a tripping tool call precedes the stop it causes.
    this.caps.onEvent(event);
    switch (event.type) {
      case 'agent.idle': {
        live.idle = true;
        live.probation = undefined; // the resumed session took its first turn: it is resumed
        const turn = live.turn;
        live.turn = { text: undefined, interrupted: false };
        this.turnEnded(live, turn);
        if (!live.paused) live.inbox.idle();
        return;
      }
      case 'agent.needs_input':
        live.questions.add(event.questionId);
        this.byQuestion.set(event.questionId, event.agentId);
        live.idle = false;
        live.inbox.working();
        return;
      case 'agent.tool_call':
      case 'agent.progress':
      case 'agent.stalled':
        live.idle = false;
        if (!live.paused) live.inbox.working();
        return;
      case 'agent.resumed':
        // The adapter thawed the agent itself (an interrupt while paused): so does the runtime.
        this.unpaused(live);
        return;
      default:
        return;
    }
  }

  /** The one terminal event: the adapter's verdict, or `failed(cap)` when a cap stop is under way. */
  private terminal(live: Live, event: Extract<AgentEvent, { type: Terminal }>): void {
    if (live.terminal) return;
    if (live.capStop && event.type === 'agent.stopped') {
      this.failForCap(live);
      return;
    }
    const probation = live.probation;
    if (probation && !live.capStop && !live.stopRequested && !this.disposed) {
      live.probation = undefined;
      // A brain falls back to a fresh session; a plain agent that failed before doing anything
      // stays interrupted for the panel's resume action. Anything else is a real end.
      if (probation.fresh || (event.type === 'agent.failed' && !live.activity)) {
        this.resumeLost(live, event, probation);
        return;
      }
    }
    this.caps.onEvent(event);
    this.recordEnd(live, event, event.type);
  }

  /**
   * A session resumed from its ref ended before its first turn did (P2-16): the resume failed.
   * The agent is logged `agent.interrupted{resume failed}` — its tool-asked and held questions
   * stay, it is coming back — and a brain gets its fresh session on the same row, as a resume
   * that failed at once does. If that cannot start either, it stays interrupted and the questions
   * it held move on.
   */
  private resumeLost(live: Live, event: Event, probation: Probation): void {
    const agentId = live.agent.id;
    const why =
      event.type === 'agent.failed'
        ? event.error
        : `the session ${event.type.slice('agent.'.length)} before its first turn`;
    const reason = `resume failed: ${why}`;
    const fresh = probation.fresh;
    if (!fresh) {
      this.recordEnd(live, { type: 'agent.interrupted', agentId, reason }, 'agent.interrupted');
      this.flagNeedsAttention(agentId, reason);
      return;
    }
    let settle!: (result: SpawnResult) => void;
    const outcome = new Promise<SpawnResult>((resolve) => (settle = resolve));
    try {
      probation.onFallback?.(outcome);
    } catch (error) {
      this.onError(error, `resume fallback ${agentId}`);
    }
    this.refreshing.add(agentId); // on its way back: nothing replaces it meanwhile
    this.recordEnd(live, { type: 'agent.interrupted', agentId, reason }, 'agent.interrupted', {
      keepHeld: true,
    });
    void (async () => {
      // Stragglers of the lost session are dropped before the new one registers under its id.
      await new Promise((resolve) => setImmediate(resolve));
      let result: SpawnResult;
      try {
        const agent = this.opts.log.tables.agents.get(agentId) ?? live.agent;
        result = this.disposed
          ? { ok: false, reason: 'runtime disposed' }
          : await this.resume(agent, fresh.req, {
              fresh: true,
              mailbox: fresh.mailbox,
              ...(fresh.foldedUpTo !== undefined ? { foldedUpTo: fresh.foldedUpTo } : {}),
            });
      } catch (error) {
        result = { ok: false, reason: (error as Error).message };
      }
      this.refreshing.delete(agentId);
      if (!result.ok) {
        this.onError(new Error(result.reason), `fresh session after ${reason} (${agentId})`);
        this.releaseHeld(agentId, 'could not be resumed');
        this.flagNeedsAttention(agentId, `${reason}; a fresh session failed: ${result.reason}`);
      }
      settle(result);
    })();
  }

  /**
   * Logs `recovery.needs_attention` (P25-01; SPEC §4.5): the agent stays interrupted until the
   * user resumes it — what the "work interrupted by a restart" notification keys on. Once per
   * interruption: not again before the agent is spawned again.
   */
  private flagNeedsAttention(agentId: Id, reason: string): void {
    if (this.live.has(agentId)) return;
    const { log } = this.opts;
    const [flagged] = log.latestOf('recovery.needs_attention', agentId, 1);
    const [spawned] = log.latestOf('agent.spawned', agentId, 1);
    if (flagged && (!spawned || flagged.seq > spawned.seq)) return;
    this.command(({ emit }) => emit({ type: 'recovery.needs_attention', agentId, reason }));
  }

  /**
   * A fresh Harmonizer replaced the interrupted ones (P5-06 review: a restart, `keepHarmonizer`):
   * none of them comes back while it runs (`refuseReopen`, decision 32), so the questions they
   * still hold — a Waykeeper's, escalated — move on to the next living holder, i.e. the user
   * (P2-03, decision 45), instead of waiting on a holder that is gone. One on its way back
   * (`isReserved`) keeps them; the rows stay `interrupted` (an ended status is a sink), like the
   * Harmonizers startup recovery passes over. Returns the agents whose questions moved.
   */
  releaseInterruptedHarmonizers(why: string): Id[] {
    const { tables } = this.opts.log;
    const holders = new Set<Id>();
    for (const q of tables.questions.all()) {
      if (q.status !== 'open' || q.holder.type !== 'agent' || !q.holder.id) continue;
      const id = q.holder.id;
      if (this.live.has(id) || this.isReserved(id)) continue;
      const agent = tables.agents.get(id);
      if (agent?.role !== 'harmonizer' || isHarnessMeta(agent.meta)) continue;
      holders.add(id);
    }
    for (const id of holders) this.releaseHeld(id, why);
    return [...holders];
  }

  /**
   * The questions an interrupted agent held move to the next living supervisor or the user
   * (P2-03): it is not coming back (passed over, or its resume failed for good).
   */
  private releaseHeld(agentId: Id, why: string): void {
    if (this.live.has(agentId)) return;
    this.command((ctx) => {
      rerouteHeldBy(ctx, agentId, this.questions, `holder ${agentId} ${why}`);
    });
  }

  private failForCap(live: Live): void {
    if (live.terminal) return;
    this.recordEnd(
      live,
      { type: 'agent.failed', agentId: live.agent.id, error: live.capStop ?? 'cap', reason: 'cap' },
      'agent.failed',
    );
  }

  /**
   * Logs how the agent ended, cancels its open questions and re-routes the ones it held (P2-03)
   * in the same command, then forgets it.
   */
  private recordEnd(
    live: Live,
    event: Event,
    terminal: Terminal,
    opts: { keepHeld?: boolean } = {},
  ): void {
    if (live.terminal) return;
    this.command((ctx) => {
      ctx.emit(event);
      endAgentQuestions(ctx, live.agent.id, terminal.slice('agent.'.length), this.questions, opts);
    });
    this.end(live, terminal);
  }

  private end(live: Live, terminal: Terminal): void {
    if (live.terminal) return;
    live.terminal = terminal;
    live.inbox.ended();
    for (const q of live.questions) this.byQuestion.delete(q);
    live.questions.clear();
    this.caps.release(live.agent.id);
    // The log and the status store keep the history; the runtime forgets the session.
    this.live.delete(live.agent.id);
    this.folderCandidates.delete(live.agent.id);
    this.ended.add(live.agent.id);
    if (this.ended.size > ENDED_MEMORY) {
      const oldest = this.ended.values().next().value;
      if (oldest !== undefined) this.ended.delete(oldest);
    }
  }

  /**
   * Called by the caps enforcer: graceful stop, then `agent.failed(reason: cap)` — once,
   * whichever comes first: the adapter's `agent.stopped` (folded by `terminal()`) or the stop
   * call resolving. A verdict already on the wire (`finished`/`failed`) wins.
   */
  async onCapHit(agentId: Id, reason: string): Promise<void> {
    const live = this.live.get(agentId);
    if (!live || live.terminal) return;
    if (!live.handle) {
      live.pendingCap = reason; // acted on by start() once the session exists
      return;
    }
    if (live.capStop) return;
    live.capStop = reason;
    live.inbox.ended();
    this.record({ type: 'control.stop', target: { kind: 'agent', id: agentId }, by: SYSTEM });
    try {
      await live.adapter.stop(live.handle.sessionId);
    } catch (error) {
      this.onError(error, `cap stop ${agentId}`);
    }
    this.failForCap(live);
  }
}

/** The roles run by a brain runner (SPEC decision 115: their slash commands are an allowlist). */
function isBrainRole(role: AgentRole): boolean {
  return role === 'harmonizer' || role === 'waykeeper';
}
