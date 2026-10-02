import type {
  Actor,
  AgentCaps,
  AgentRuntime as RuntimeName,
  DomainCommands,
  Event,
  EventEnvelope,
  Id,
  ToolDefinition,
} from '@galactic/protocol';
import type { EventLog } from '../domain/event-log.js';
import type { SpawnResult } from '../runtime/agent-runtime.js';
import type { Workspaces } from '../workspace/workspaces.js';
import {
  CARRY_SUMMARY_TOOL,
  TURN_ENDING_TOOLS,
  type BrainDefinition,
  type BrainQueries,
  type BrainTool,
  type BrainToolContext,
} from './definition.js';
import { createWakeScope, renderSeed } from './seed.js';
import { wakeLine, type WakeScope } from './wake.js';

/**
 * The brain runner (P2-06; TECHNOLOGY §5.2): one per brain. It spawns the brain through the
 * runtime (so the brain has an agent row, a status record, cost and a `sessionRef` like any
 * agent), feeds its mailbox from the event log through the wake table, and drives its turns:
 *
 *   - one turn at a time: a turn starts only when the brain is idle, and runs until the brain's
 *     `agent.idle`; whatever wakes it meanwhile waits in the mailbox;
 *   - a turn drains the whole mailbox into one prompt ("since your last turn: …") plus the
 *     DB-seeded state, so events that arrive together make one turn, not several;
 *   - the brain's own tool side effects never wake it: every event a tool's command appended is
 *     taken out of the mailbox when the command returns, mid-turn or not;
 *   - a non-blocking user-facing tool ends the turn: its result tells the model to stop, and any
 *     later tool call in the same turn is refused;
 *   - sessions are reset by policy or on demand, with a summary carried into the new session's
 *     first prompt.
 *
 * Messages to the brain (the user's chat, a subordinate's report) are logged by the runtime and
 * reach the brain only through the mailbox (`AgentRuntime.attachMailbox`); the runner marks them
 * `message.delivered` once the turn that folded them was delivered.
 *
 * Not persisted (P2-16): a restart loses the mailbox; requeueing in-flight events belongs to the
 * hierarchy resume.
 */

/** What the runner needs from the agent runtime. `AgentRuntime` provides it. */
export interface BrainRuntime {
  send(agentId: Id, text: string, opts: { sender: Actor; turn?: boolean }): { id: string };
  attachMailbox(agentId: Id): void;
  renewSession(agentId: Id, prompt: string, reason?: string): Promise<SpawnResult>;
}

/** Where the brain runs. */
export interface BrainPlacement {
  runtime: RuntimeName;
  /** A Waykeeper's project (its workspace is the working directory). */
  projectId?: Id;
  supervisorId?: Id;
  /** The Harmonizer's working directory. */
  cwd?: string;
  caps?: Partial<AgentCaps>;
}

export interface SessionResetPolicy {
  /** Reset after this many turns in one session (the first turn counts). Default: never. */
  afterTurns?: number;
  /**
   * Where the carried summary comes from: `ask` (default) gives the brain one extra turn to call
   * `carry_summary`; a function computes it without a turn.
   */
  summarize?: 'ask' | ((brain: BrainRunner) => string);
}

export interface BrainRunnerOptions {
  log: EventLog;
  runtime: BrainRuntime;
  commands: DomainCommands;
  queries: BrainQueries;
  /** How long a woken idle brain waits for more events before its turn starts. Default 0. */
  coalesceMs?: number;
  reset?: SessionResetPolicy;
  /** Handed to the brain's tools as `ctx.workspaces` (P2-10). */
  workspaces?: Workspaces;
  onError?: (error: unknown, context: string) => void;
}

export interface MailboxItem {
  seq: number;
  at: string;
  event: Event;
  /** The line the turn prompt shows. */
  line: string;
}

export interface TurnRecord {
  /** 1-based, across sessions. */
  n: number;
  session: number;
  /** `first`: a session's spawn prompt; `mailbox`: a drained mailbox; `summary`: before a reset. */
  kind: 'first' | 'mailbox' | 'summary';
  prompt: string;
  items: MailboxItem[];
  /** The turn-ending tool the brain called, if any. */
  endedBy?: string;
}

export type BrainState = 'starting' | 'in_turn' | 'idle' | 'renewing' | 'ended';

const SYSTEM: Actor = { type: 'system' };

const SUMMARY_PROMPT =
  `Your session is about to be reset. Call ${CARRY_SUMMARY_TOOL} once with everything you need ` +
  'to remember that the database does not hold (commitments, open threads, what you promised ' +
  'the user), then end your turn.';

const ENDED_NOTE =
  'Done. End your turn now: the answer arrives as a later event in your next turn.';

export class BrainRunner {
  private stateValue: BrainState = 'starting';
  private id: Id | undefined;
  private readonly mailbox: MailboxItem[] = [];
  /** Envelopes committed while the spawn was under way (the brain id is not known yet). */
  private early: EventEnvelope[] | undefined = [];
  private unsubscribe: (() => void) | undefined;
  private timer: { cancel(): void } | undefined;
  private current: TurnRecord | undefined;
  private session = 0;
  private turnsInSession = 0;
  private resetRequested = false;
  private carried: string | undefined;
  /** The turn message whose delivery also delivers the folded `message.sent` ids. */
  private turnMessage: { id: string; folded: Id[] } | undefined;
  private scope: WakeScope | undefined;
  private waiters: (() => void)[] = [];
  /** Every turn so far (tests, the ops console later). */
  readonly turns: TurnRecord[] = [];
  private readonly coalesceMs: number;
  private readonly onError: (error: unknown, context: string) => void;

  private constructor(
    readonly definition: BrainDefinition,
    readonly placement: BrainPlacement,
    private readonly opts: BrainRunnerOptions,
  ) {
    this.coalesceMs = opts.coalesceMs ?? 0;
    this.onError = opts.onError ?? (() => {});
  }

  /** Spawns the brain and starts driving it. Rejects (and leaves no runner) when the spawn is refused. */
  static async start(
    definition: BrainDefinition,
    placement: BrainPlacement,
    opts: BrainRunnerOptions,
  ): Promise<BrainRunner> {
    const runner = new BrainRunner(definition, placement, opts);
    await runner.spawn();
    return runner;
  }

  get agentId(): Id {
    if (!this.id) throw new Error('the brain has not been spawned yet');
    return this.id;
  }

  get state(): BrainState {
    return this.stateValue;
  }

  /** Events waiting for the next turn. */
  pending(): MailboxItem[] {
    return [...this.mailbox];
  }

  /** The summary the last reset carried (or the one saved for the next reset). */
  carriedSummary(): string | undefined {
    return this.carried;
  }

  /** Resolves when the brain is idle with an empty mailbox (or ended). */
  settled(): Promise<void> {
    if (this.isSettled()) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Resets the session at the next idle (now, if idle), carrying a summary. */
  requestReset(): void {
    this.resetRequested = true;
    if (this.stateValue === 'idle') this.startReset();
  }

  /** Stops driving the brain (the agent itself is stopped through the runtime). */
  dispose(): void {
    this.end();
  }

  // ---------------------------------------------------------------------------------------------

  private async spawn(): Promise<void> {
    this.unsubscribe = this.opts.log.subscribe((env) => this.onEnvelope(env));
    const prompt = this.firstPrompt([]);
    this.beginTurn('first', prompt, [], true);
    let agentId: Id;
    try {
      const { value } = await this.opts.commands.spawnAgent({
        role: this.definition.role,
        runtime: this.placement.runtime,
        prompt,
        systemPrompt: this.definition.systemPrompt,
        tools: this.toolDefinitions(),
        ...(this.placement.projectId ? { projectId: this.placement.projectId } : {}),
        ...(this.placement.supervisorId ? { supervisorId: this.placement.supervisorId } : {}),
        ...(this.placement.cwd ? { cwd: this.placement.cwd } : {}),
        ...(this.placement.caps ? { caps: this.placement.caps } : {}),
      });
      agentId = value.id;
    } catch (error) {
      this.end();
      throw error;
    }
    this.id = agentId;
    this.scope = createWakeScope(this.opts.log.tables, {
      brainId: agentId,
      role: this.definition.role,
      ...(this.placement.projectId ? { projectId: this.placement.projectId } : {}),
    });
    this.opts.runtime.attachMailbox(agentId);
    const early = this.early ?? [];
    this.early = undefined;
    for (const env of early) this.onEnvelope(env);
  }

  private onEnvelope(env: EventEnvelope): void {
    if (this.stateValue === 'ended') return;
    if (!this.id || !this.scope) {
      this.early?.push(env);
      return;
    }
    const event = env.event;
    if ('agentId' in event && event.agentId === this.id && event.type !== 'message.sent') {
      this.onOwnAgentEvent(event);
      return;
    }
    const line = wakeLine(event, this.scope, this.definition.wakeRules);
    if (line === undefined) return;
    this.mailbox.push({ seq: env.seq, at: env.at, event, line });
    this.schedule();
  }

  /** The brain's own lifecycle: turn boundaries, delivery, the end. Never a wake. */
  private onOwnAgentEvent(event: Event): void {
    switch (event.type) {
      case 'agent.spawned':
        if (this.stateValue === 'starting' || this.stateValue === 'renewing') {
          this.stateValue = 'in_turn';
        }
        return;
      case 'agent.idle':
        if (this.stateValue === 'in_turn') this.endTurn();
        return;
      case 'message.delivered':
        if (this.turnMessage && event.messageId === this.turnMessage.id) {
          const { folded } = this.turnMessage;
          this.turnMessage = undefined;
          this.markDelivered(folded);
        }
        return;
      case 'agent.interrupted':
        // A session reset interrupts the old session on purpose; anything else ends the brain.
        if (this.stateValue !== 'renewing') this.end();
        return;
      case 'agent.finished':
      case 'agent.failed':
      case 'agent.stopped':
        this.end();
        return;
      default:
        return;
    }
  }

  private beginTurn(kind: TurnRecord['kind'], prompt: string, items: MailboxItem[], fresh = false) {
    if (fresh) {
      this.session++;
      this.turnsInSession = 0;
    }
    this.turnsInSession++;
    const turn: TurnRecord = {
      n: this.turns.length + 1,
      session: this.session,
      kind,
      prompt,
      items,
    };
    this.turns.push(turn);
    this.current = turn;
    return turn;
  }

  private endTurn(): void {
    const ended = this.current;
    this.current = undefined;
    this.stateValue = 'idle';
    if (ended?.kind === 'summary') {
      void this.renew();
    } else if (this.shouldReset()) {
      this.startReset();
    } else {
      this.schedule();
    }
    this.notify();
  }

  private schedule(): void {
    if (this.stateValue !== 'idle' || this.mailbox.length === 0 || this.timer) return;
    const fire = () => {
      this.timer = undefined;
      this.drain();
    };
    if (this.coalesceMs > 0) {
      const t = setTimeout(fire, this.coalesceMs);
      this.timer = { cancel: () => clearTimeout(t) };
    } else {
      const t = setImmediate(fire);
      this.timer = { cancel: () => clearImmediate(t) };
    }
  }

  private drain(): void {
    if (this.stateValue !== 'idle' || this.mailbox.length === 0) {
      this.notify();
      return;
    }
    const items = this.mailbox.splice(0);
    this.deliver('mailbox', this.turnPrompt(items), items);
  }

  /** Sends one turn to the brain. The runtime's inbox delivers it at once: the brain is idle. */
  private deliver(kind: 'mailbox' | 'summary', prompt: string, items: MailboxItem[]): void {
    const turn = this.beginTurn(kind, prompt, items);
    this.stateValue = 'in_turn';
    try {
      const message = this.opts.runtime.send(this.agentId, prompt, { sender: SYSTEM, turn: true });
      this.turnMessage = { id: message.id, folded: foldedMessages(items) };
    } catch (error) {
      // Refused (the brain is stopping): the events go back and wait for the brain's fate.
      this.onError(error, `brain ${this.id} turn`);
      this.turns.splice(this.turns.indexOf(turn), 1);
      this.turnsInSession--;
      this.current = undefined;
      this.mailbox.unshift(...items);
      this.stateValue = 'idle';
      this.notify();
    }
  }

  private shouldReset(): boolean {
    const after = this.opts.reset?.afterTurns;
    return (
      this.resetRequested || (after !== undefined && after > 0 && this.turnsInSession >= after)
    );
  }

  private startReset(): void {
    const summarize = this.opts.reset?.summarize ?? 'ask';
    if (summarize === 'ask') {
      this.deliver('summary', SUMMARY_PROMPT, []);
      return;
    }
    try {
      this.carried = summarize(this);
    } catch (error) {
      this.onError(error, `brain ${this.id} summary`);
    }
    void this.renew();
  }

  /** A fresh session on the same agent row; its first prompt carries the summary and the mailbox. */
  private async renew(): Promise<void> {
    this.resetRequested = false;
    this.stateValue = 'renewing';
    const items = this.mailbox.splice(0);
    const prompt = this.firstPrompt(items);
    const turn = this.beginTurn('first', prompt, items, true);
    let result: SpawnResult;
    try {
      result = await this.opts.runtime.renewSession(this.agentId, prompt, 'session reset');
    } catch (error) {
      result = { ok: false, reason: (error as Error).message };
    }
    if (result.ok) {
      this.markDelivered(foldedMessages(items));
      return;
    }
    this.onError(new Error(result.reason), `brain ${this.id} session reset`);
    if (this.stateValue !== 'renewing') return; // the brain ended meanwhile
    this.turns.splice(this.turns.indexOf(turn), 1);
    this.current = undefined;
    this.mailbox.unshift(...items);
    this.stateValue = 'idle';
    this.schedule();
    this.notify();
  }

  private end(): void {
    if (this.stateValue === 'ended') return;
    this.stateValue = 'ended';
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.timer?.cancel();
    this.timer = undefined;
    this.notify();
  }

  private isSettled(): boolean {
    return (
      this.stateValue === 'ended' ||
      (this.stateValue === 'idle' && this.mailbox.length === 0 && !this.timer)
    );
  }

  private notify(): void {
    if (!this.isSettled()) return;
    for (const w of this.waiters.splice(0)) w();
  }

  /** The folded messages reached the brain inside a turn: a restart must not redeliver them. */
  private markDelivered(messageIds: Id[]): void {
    if (messageIds.length === 0 || !this.id) return;
    const agentId = this.id;
    try {
      this.opts.log.runCommand((ctx) => {
        for (const messageId of messageIds)
          ctx.emit({ type: 'message.delivered', messageId, agentId });
      });
    } catch (error) {
      this.onError(error, `brain ${agentId} delivered`);
    }
  }

  // -- prompts ---------------------------------------------------------------------------------

  private seed(): string {
    return renderSeed(this.opts.queries, {
      ...(this.id ? { brainId: this.id } : {}),
      ...(this.placement.projectId ? { projectId: this.placement.projectId } : {}),
    });
  }

  private firstPrompt(items: MailboxItem[]): string {
    const parts = [`You are the ${this.definition.role}. A new session starts here.`];
    if (this.carried) {
      parts.push(`Summary carried from your previous session:\n${this.carried}`);
    }
    if (items.length > 0) parts.push(renderItems('Waiting for you:', items));
    parts.push(this.seed());
    return parts.join('\n\n');
  }

  private turnPrompt(items: MailboxItem[]): string {
    return [renderItems('Since your last turn:', items), this.seed()].join('\n\n');
  }

  // -- tools -----------------------------------------------------------------------------------

  private toolDefinitions(): ToolDefinition[] {
    const carry: BrainTool = {
      name: CARRY_SUMMARY_TOOL,
      description:
        'Saves the summary carried into your next session when your session is reset. Call it ' +
        'only when asked to.',
      inputSchema: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
      },
      endsTurn: true,
      handler: async (input) => {
        const summary = (input as { summary?: unknown }).summary;
        if (typeof summary !== 'string' || summary.trim() === '') {
          throw new Error('summary must be a non-empty string');
        }
        this.carried = summary;
        return 'saved';
      },
    };
    const tools = [...this.definition.tools.filter((t) => t.name !== CARRY_SUMMARY_TOOL), carry];
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      handler: (input: unknown) => this.runTool(tool, input),
    }));
  }

  private async runTool(tool: BrainTool, input: unknown): Promise<unknown> {
    const turn = this.current;
    if (turn?.endedBy) {
      return {
        error: 'turn_ended',
        message: `This turn ended with ${turn.endedBy}; stop now. What you are waiting for arrives as a later event.`,
      };
    }
    let out: unknown;
    try {
      out = await tool.handler(input, this.toolContext());
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      return {
        error: typeof code === 'string' ? code : 'error',
        message: (error as Error).message,
      };
    }
    if (tool.endsTurn || TURN_ENDING_TOOLS.has(tool.name)) {
      if (turn) turn.endedBy = tool.name;
      return { result: out ?? null, turnEnded: true, note: ENDED_NOTE };
    }
    return out;
  }

  private toolContext(): BrainToolContext {
    const brainId = this.agentId;
    const actor: Actor = { type: 'agent', id: brainId };
    return {
      brainId,
      role: this.definition.role,
      ...(this.placement.projectId ? { projectId: this.placement.projectId } : {}),
      actor,
      commands: this.ownCommands(),
      queries: this.opts.queries,
      // A line to another agent never wakes the brain: `message.sent` wakes only its addressee.
      send: (agentId, text) => ({
        messageId: this.opts.runtime.send(agentId, text, { sender: actor }).id,
      }),
      ...(this.opts.workspaces ? { workspaces: this.opts.workspaces } : {}),
    };
  }

  /**
   * `DomainCommands` whose events are the brain's own: when a call returns, every event it
   * appended is taken out of the mailbox (domain commands publish before they return; an agent
   * command returns the events it caused). Nothing the brain did itself ever wakes it.
   */
  private ownCommands(): DomainCommands {
    const target = this.opts.commands;
    return new Proxy(target, {
      get: (obj, prop, receiver) => {
        const value: unknown = Reflect.get(obj, prop, receiver);
        if (typeof value !== 'function') return value;
        return async (...args: unknown[]) => {
          const since = this.opts.log.currentSeq();
          const result = (await (value as (...a: unknown[]) => Promise<unknown>).apply(
            obj,
            args,
          )) as { events?: Event[] } | undefined;
          this.dropOwn(since, result?.events ?? []);
          return result;
        };
      },
    });
  }

  private dropOwn(since: number, events: Event[]): void {
    if (events.length === 0) return;
    const keys = new Map<string, number>();
    for (const e of events) {
      const k = JSON.stringify(e);
      keys.set(k, (keys.get(k) ?? 0) + 1);
    }
    for (let i = 0; i < this.mailbox.length;) {
      const item = this.mailbox[i]!;
      const k = JSON.stringify(item.event);
      const left = keys.get(k) ?? 0;
      if (item.seq > since && left > 0) {
        keys.set(k, left - 1);
        this.mailbox.splice(i, 1);
      } else i++;
    }
  }
}

function renderItems(title: string, items: MailboxItem[]): string {
  return [title, ...items.map((item, i) => `${i + 1}. ${item.line}`)].join('\n');
}

/** The `message.sent` ids a turn folds in. */
function foldedMessages(items: MailboxItem[]): Id[] {
  return items.flatMap((item) =>
    item.event.type === 'message.sent' ? [item.event.messageId] : [],
  );
}
