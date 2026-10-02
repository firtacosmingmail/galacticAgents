import type { Actor, AgentRole, Id, SpawnOptions } from '@galactic/protocol';
import { FakeAdapter, type FakeAdapterOptions } from '../../adapters/fake/fake-adapter.js';
import {
  FakeTurnCancelled,
  type FakeScenario,
  type FakeStep,
  type FakeTurnIO,
} from '../../adapters/fake/scenario.js';
import { openDatabase, type Database } from '../../db/database.js';
import type { RecoveryReport } from '../../runtime/agent-runtime.js';
import {
  composeRuntime,
  type ComposedRuntime,
  type ComposeOptions,
} from '../../runtime/compose.js';
import type { BrainDefinition } from '../definition.js';
import type { BrainPlacement, BrainRunner, BrainRunnerOptions } from '../runner.js';
import { harmonizerDefinition } from './canned.js';
import {
  BrainScript,
  ToolRefused,
  type ScriptOptions,
  type TurnContext,
  type TurnInfo,
} from './script.js';
import {
  BrainTranscript,
  json,
  toOutcome,
  type ToolOutcome,
  type TranscriptTurn,
} from './transcript.js';

/**
 * The scripted fake-LLM harness for brains (P2-07). It boots a composed runtime (real event log,
 * commands, runtime, status store) over an in-memory database and a fake adapter whose brains —
 * every spawn that carries server tools — are driven by `BrainScript`s instead of a model:
 *
 *   const h = brainHarness();
 *   const hq = await h.startHarmonizer();
 *   const wk = await h.startBrain(waykeeper, { runtime: 'fake', projectId, supervisorId: hq.agentId }, {
 *     script: (s) => s.once('plan it', async (t) => { … await t.call('create_task', {…}) … }),
 *   });
 *   wk.tell('plan it');
 *   await h.settle();
 *   h.verify();                 // unmet expectations, unexpected turns, refused calls, errors
 *   expect(wk.calls('create_task')).toHaveLength(1);
 *
 * Tool handlers run for real (through the runner, the gate and `DomainCommands`); the harness only
 * decides which calls the "model" makes and records what it saw. Agents spawned without tools
 * (Stewards) run the fake adapter's usual `scenario:<name>` prompts. Test-only; no SDK imports.
 */

const USER: Actor = { type: 'user' };

/** Which brains a script drives: every field given must match; the most specific script wins. */
export interface BrainSelector {
  role?: AgentRole;
  projectId?: Id;
  agentId?: Id;
}

export interface HarnessOptions {
  /** Default: a fresh in-memory database (migrations seed the body catalogue). */
  db?: Database;
  compose?: Omit<ComposeOptions, 'adapters' | 'onError'>;
  adapter?: Omit<FakeAdapterOptions, 'scenarioFor'>;
  /** Default `coalesceMs` of `startBrain`. */
  coalesceMs?: number;
  /** Errors the runtime reports (`onError`) fail `verify()`. Default true. */
  failOnErrors?: boolean;
  /** Default options of every new script. */
  script?: ScriptOptions;
}

export interface StartBrainOptions extends Pick<BrainRunnerOptions, 'coalesceMs' | 'reset'> {
  /** The brain's script, or a function filling a new one (selector: its role and project). */
  script?: BrainScript | ((script: BrainScript) => void);
  scriptOptions?: ScriptOptions;
}

export interface WaitOptions {
  /** Wall-clock safety net; the wait itself polls on `setImmediate`. Default 2000. */
  timeoutMs?: number;
  /** What is awaited, for the failure message. */
  what?: string;
}

interface Scripted {
  agentId: Id;
  role: AgentRole;
  toolNames: Set<string>;
  transcript: BrainTranscript;
}

interface RegisteredScript {
  selector: BrainSelector;
  script: BrainScript;
}

/** Thrown by `verify`, `settle` and `until`: every problem plus every brain's transcript. */
export class HarnessFailure extends Error {
  constructor(
    readonly problems: string[],
    report: string,
  ) {
    super(
      [
        `brain harness: ${problems.length} problem${problems.length === 1 ? '' : 's'}`,
        ...problems.map((p) => `  - ${p}`),
        '',
        report,
      ].join('\n'),
    );
    this.name = 'HarnessFailure';
  }
}

const nextTick = () => new Promise<void>((r) => setImmediate(r));

export class BrainHarness {
  readonly composed: ComposedRuntime;
  readonly adapter: FakeAdapter;
  /** Everything the runtime reported through `onError`. */
  readonly errors: string[] = [];
  /** The brains started through `startBrain`, in order. */
  readonly brains: HarnessBrain[] = [];
  private readonly scripts: RegisteredScript[] = [];
  private readonly scripted = new Map<Id, Scripted>();
  private sessions = 0;

  constructor(private readonly opts: HarnessOptions = {}) {
    this.adapter = new FakeAdapter({
      speed: 0,
      ...(opts.adapter ?? {}),
      scenarioFor: (spawn) => this.scenarioFor(spawn),
    });
    this.composed = composeRuntime(opts.db ?? openDatabase(':memory:'), {
      flushMs: 10,
      ...(opts.compose ?? {}),
      adapters: [this.adapter],
      onError: (e, ctx) => this.errors.push(`${ctx}: ${(e as Error).message}`),
    });
  }

  get log() {
    return this.composed.log;
  }
  get commands() {
    return this.composed.commands;
  }
  get runtime() {
    return this.composed.runtime;
  }
  get statuses() {
    return this.composed.statuses;
  }
  get queries() {
    return this.composed.queries;
  }

  /** The script for brains matching `selector` (a role, or role/project/agent); created on first use. */
  script(selector: AgentRole | BrainSelector, opts?: ScriptOptions): BrainScript {
    const sel = typeof selector === 'string' ? { role: selector } : selector;
    const existing = this.scripts.find((s) => sameSelector(s.selector, sel));
    if (existing) return existing.script;
    const script = new BrainScript({ ...(this.opts.script ?? {}), ...(opts ?? {}) });
    this.scripts.push({ selector: sel, script });
    return script;
  }

  /** Spawns a brain through the composed runtime (`startBrain`) with its script bound. */
  async startBrain(
    definition: BrainDefinition,
    placement: BrainPlacement,
    opts: StartBrainOptions = {},
  ): Promise<HarnessBrain> {
    const selector: BrainSelector = {
      role: definition.role,
      ...(placement.projectId ? { projectId: placement.projectId } : {}),
    };
    if (opts.script instanceof BrainScript) {
      const i = this.scripts.findIndex((s) => sameSelector(s.selector, selector));
      if (i >= 0) this.scripts.splice(i, 1);
      this.scripts.push({ selector, script: opts.script });
    } else if (opts.script) {
      opts.script(this.script(selector, opts.scriptOptions));
    }
    // Without a script, the brain follows whatever `script()` registered for it (by role, say).
    const coalesceMs = opts.coalesceMs ?? this.opts.coalesceMs;
    const runner = await this.composed.startBrain(definition, placement, {
      ...(coalesceMs !== undefined ? { coalesceMs } : {}),
      ...(opts.reset ? { reset: opts.reset } : {}),
    });
    const brain = new HarnessBrain(this, runner, this.transcript(runner.agentId)!);
    this.brains.push(brain);
    return brain;
  }

  /**
   * A Harmonizer at the top of the hierarchy, so Waykeepers and Stewards have a supervisor.
   * Without a script it is lenient (it may be woken by what its subordinates do); with one it is
   * strict like any other brain.
   */
  startHarmonizer(
    opts: StartBrainOptions & { definition?: BrainDefinition; cwd?: string } = {},
  ): Promise<HarnessBrain> {
    const { definition, cwd, ...rest } = opts;
    return this.startBrain(
      definition ?? harmonizerDefinition(),
      { runtime: 'fake', cwd: cwd ?? '/w/hq' },
      { ...(rest.script ? {} : { scriptOptions: { strict: false } }), ...rest },
    );
  }

  /** The transcript of a scripted brain (any brain spawned with tools, started here or not). */
  transcript(agentId: Id): BrainTranscript | undefined {
    return this.scripted.get(agentId)?.transcript;
  }

  /** Every scripted brain's transcript, in spawn order. */
  transcripts(): BrainTranscript[] {
    return [...this.scripted.values()].map((s) => s.transcript);
  }

  /** A chat line to an agent, as the panel sends it (the user by default). */
  tell(agentId: Id, text: string, sender: Actor = USER): { id: string } {
    return this.runtime.send(agentId, text, { sender });
  }

  /**
   * Resolves when every brain started here is idle with an empty mailbox (or ended), and stays so
   * for a few ticks: one brain's turn may wake another. It does not wait for Stewards' scenarios;
   * use `until` for those.
   */
  async settle(opts: WaitOptions = {}): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 2000;
    const deadline = Date.now() + timeoutMs;
    let calm = 0;
    while (calm < 3) {
      if (Date.now() > deadline) {
        const busy = this.brains.filter((b) => !b.isSettled());
        throw this.failure([
          `timed out after ${timeoutMs} ms waiting for ${opts.what ?? 'the brains to settle'}` +
            (busy.length > 0
              ? `; still busy: ${busy.map((b) => `${b.transcript.label} (${b.runner.state}, ${b.runner.pending().length} waiting)`).join(', ')}`
              : ''),
        ]);
      }
      calm = this.brains.every((b) => b.isSettled()) ? calm + 1 : 0;
      await nextTick();
    }
  }

  /** Polls `check` on every tick until it holds; fails with the transcripts after `timeoutMs`. */
  async until(check: () => boolean, opts: WaitOptions = {}): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 2000;
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) {
        throw this.failure([
          `timed out after ${timeoutMs} ms waiting for ${opts.what ?? 'a condition'}`,
        ]);
      }
      await nextTick();
    }
  }

  /** Problems so far: unmet expectations, unexpected turns, script errors, runtime errors. */
  problems(): string[] {
    const problems: string[] = [];
    for (const { selector, script } of this.scripts) {
      for (const rule of script.unmet()) {
        const want = rule.times === 1 ? 'a turn' : `${rule.times} turns`;
        problems.push(
          `${selectorLabel(selector)}: expected ${want} answered by the rule "${rule.label}", ` +
            `but ${rule.used === 0 ? 'none came' : `only ${rule.used} came`}`,
        );
      }
    }
    for (const s of this.scripted.values()) {
      const script = this.scriptOf(s.agentId, s.role);
      for (const turn of s.transcript.turns) {
        if (turn.rule === undefined && script?.strict && !(turn.n === 0 && script.allowFirst)) {
          problems.push(
            `${s.transcript.label}: unexpected turn ${turn.index}, no rule matched; ` +
              `it said: ${JSON.stringify(firstLines(turn.prompt))}`,
          );
        }
      }
      for (const e of s.transcript.errors()) {
        problems.push(`${s.transcript.label}, turn ${e.turn}: ${e.message}`);
      }
    }
    if (this.opts.failOnErrors ?? true) {
      for (const e of this.errors) problems.push(`runtime error: ${e}`);
    }
    return problems;
  }

  /** Throws a `HarnessFailure` listing every problem and every transcript, if there is any. */
  verify(): void {
    const problems = this.problems();
    if (problems.length > 0) throw new HarnessFailure(problems, this.report());
  }

  /** `settle()` then `verify()`. */
  async done(opts: WaitOptions = {}): Promise<void> {
    await this.settle(opts);
    this.verify();
  }

  /** Every scripted brain's transcript, rendered. */
  report(): string {
    const all = this.transcripts();
    if (all.length === 0) return '(no scripted brain was spawned)';
    return all.map((t) => t.render()).join('\n\n');
  }

  failure(problems: string[]): HarnessFailure {
    return new HarnessFailure(problems, this.report());
  }

  /**
   * A kill -9 (P2-16): the brains' in-memory mailboxes are lost and nothing this server life does
   * afterwards reaches the log — the adapter's event stream is cut and the reports and timers
   * stop. The agents' last states stay as the log has them. Boot a new harness over the same
   * `db` (and the adapter's `sessionStore`) and call `recover()` there. `dispose()` still works.
   */
  crash(): void {
    for (const b of this.brains) b.runner.dispose();
    this.adapter.events.close();
    this.composed.reports.dispose();
    this.composed.archival.stop();
  }

  /**
   * Startup recovery on this harness (P2-16): `composed.recover()`, then every brain it resumed is
   * added to `brains` (so `settle()` waits for it) with its runner and transcript. Register the
   * brain definitions (`composed.defineBrains`) and the scripts first.
   */
  async recover(): Promise<{ report: RecoveryReport; resumed: HarnessBrain[] }> {
    const report = await this.composed.recover();
    const resumed: HarnessBrain[] = [];
    for (const id of report.resumed) {
      const runner = this.composed.runnerOf(id);
      if (!runner || this.brains.some((b) => b.agentId === id)) continue;
      const transcript = this.transcript(id) ?? new BrainTranscript(id, runner.definition.role);
      const brain = new HarnessBrain(this, runner, transcript);
      this.brains.push(brain);
      resumed.push(brain);
    }
    return { report, resumed };
  }

  async dispose(): Promise<void> {
    for (const b of this.brains) b.runner.dispose();
    await this.composed.dispose();
  }

  // -- the fake LLM ------------------------------------------------------------------------------

  /** A brain is a spawn with server tools (a Steward has none): it gets a scripted scenario. */
  private scenarioFor(spawn: SpawnOptions): { name: string; scenario: FakeScenario } | undefined {
    if (!spawn.tools || spawn.tools.length === 0) return undefined;
    let s = this.scripted.get(spawn.agentId);
    if (!s) {
      s = {
        agentId: spawn.agentId,
        role: spawn.role,
        toolNames: new Set(spawn.tools.map((t) => t.name)),
        transcript: new BrainTranscript(spawn.agentId, spawn.role),
      };
      this.scripted.set(spawn.agentId, s);
    }
    const brain = s;
    brain.transcript.session++;
    const session = brain.transcript.session;
    const step = (n: number, prompt: string): FakeStep[] => [
      { kind: 'script', run: (io) => this.runTurn(brain, session, n, prompt, io) },
    ];
    return {
      name: `scripted-${++this.sessions}`,
      scenario: { steps: step(0, spawn.prompt), onMessage: (message, n) => step(n, message) },
    };
  }

  private scriptOf(agentId: Id, role: AgentRole): BrainScript | undefined {
    const projectId = this.log.tables.agents.get(agentId)?.projectId;
    let best: { score: number; script: BrainScript } | undefined;
    for (const { selector, script } of this.scripts) {
      if (selector.agentId !== undefined && selector.agentId !== agentId) continue;
      if (selector.role !== undefined && selector.role !== role) continue;
      if (selector.projectId !== undefined && selector.projectId !== projectId) continue;
      const score =
        (selector.agentId ? 4 : 0) + (selector.projectId ? 2 : 0) + (selector.role ? 1 : 0);
      if (!best || score >= best.score) best = { score, script };
    }
    return best?.script;
  }

  private async runTurn(
    brain: Scripted,
    session: number,
    n: number,
    prompt: string,
    io: FakeTurnIO,
  ): Promise<void> {
    // A session's first turn starts before the runtime has recorded `agent.spawned`; wait for the
    // row so the script sees the brain's project (a model takes longer than this to answer).
    for (let i = 0; i < 50 && !this.log.tables.agents.get(brain.agentId); i++) await nextTick();
    const projectId = this.log.tables.agents.get(brain.agentId)?.projectId;
    const t = brain.transcript;
    if (projectId && !t.projectId) t.projectId = projectId;
    const turn: TranscriptTurn = {
      index: t.turns.length + 1,
      n,
      session,
      prompt,
      entries: [],
      done: false,
    };
    t.turns.push(turn);
    const info: TurnInfo = {
      agentId: brain.agentId,
      role: brain.role,
      ...(projectId ? { projectId } : {}),
      index: turn.index,
      n,
      session,
      first: n === 0,
      prompt,
    };
    const rule = this.scriptOf(brain.agentId, brain.role)?.take(info);
    if (!rule) {
      turn.done = true;
      return;
    }
    turn.rule = rule.label;
    const attempt = async (tool: string, input: unknown): Promise<ToolOutcome> => {
      if (!brain.toolNames.has(tool)) {
        throw new Error(
          `the script called ${tool}, which is not one of the brain's tools ` +
            `(${[...brain.toolNames].join(', ')})`,
        );
      }
      const result = await io.toolCall(tool, input);
      const outcome = toOutcome(tool, input, result);
      turn.entries.push({ kind: 'call', outcome });
      return outcome;
    };
    const ctx: TurnContext = {
      ...info,
      transcript: t,
      try: (tool, input = {}) => attempt(tool, input),
      call: async <T>(tool: string, input: unknown = {}) => {
        const outcome = await attempt(tool, input);
        if (!outcome.ok) throw new ToolRefused(outcome);
        return outcome.value as T;
      },
      say: (text) => {
        io.output(text);
        turn.entries.push({ kind: 'say', text });
      },
      mentions: (text) => (typeof text === 'string' ? prompt.includes(text) : text.test(prompt)),
    };
    try {
      await rule.body(ctx);
    } catch (error) {
      if (error instanceof FakeTurnCancelled) {
        turn.entries.push({ kind: 'cancelled' });
        throw error;
      }
      turn.entries.push({ kind: 'error', message: (error as Error).message ?? json(error) });
    } finally {
      turn.done = true;
    }
  }
}

/** One brain started through the harness: its runner, its transcript and test conveniences. */
export class HarnessBrain {
  constructor(
    private readonly harness: BrainHarness,
    readonly runner: BrainRunner,
    readonly transcript: BrainTranscript,
  ) {}

  get agentId(): Id {
    return this.runner.agentId;
  }

  get role(): AgentRole {
    return this.runner.definition.role;
  }

  /** The turns the scripted model received. */
  get turns(): TranscriptTurn[] {
    return this.transcript.turns;
  }

  prompts(): string[] {
    return this.transcript.prompts();
  }

  calls(tool?: string): ToolOutcome[] {
    return this.transcript.calls(tool);
  }

  /** A chat line to this brain (from the user by default). */
  tell(text: string, sender: Actor = USER): { id: string } {
    return this.harness.tell(this.agentId, text, sender);
  }

  isSettled(): boolean {
    const state = this.runner.state;
    return state === 'ended' || (state === 'idle' && this.runner.pending().length === 0);
  }

  /** This brain alone is idle with an empty mailbox (or ended). */
  settled(): Promise<void> {
    return this.runner.settled();
  }

  /** Waits until the brain has had `count` turns and is settled. */
  async waitForTurns(count: number, opts: WaitOptions = {}): Promise<void> {
    await this.harness.until(() => this.transcript.turns.length >= count && this.isSettled(), {
      ...opts,
      what: opts.what ?? `${this.transcript.label} to have ${count} turns`,
    });
  }

  /** The tool names called so far must be exactly `names`, in order; fails with the transcript. */
  assertCalls(names: string[]): void {
    const got = this.calls().map((c) => c.tool);
    if (json(got) !== json(names)) {
      throw this.harness.failure([
        `${this.transcript.label}: expected the calls ${json(names)}, got ${json(got)}`,
      ]);
    }
  }
}

/** A harness with a fresh composed runtime; `dispose()` it after the test. */
export function brainHarness(opts: HarnessOptions = {}): BrainHarness {
  return new BrainHarness(opts);
}

function sameSelector(a: BrainSelector, b: BrainSelector): boolean {
  return a.role === b.role && a.projectId === b.projectId && a.agentId === b.agentId;
}

function selectorLabel(s: BrainSelector): string {
  const parts = [s.role ?? 'any brain'];
  if (s.projectId) parts.push(`of project ${s.projectId}`);
  if (s.agentId) parts.push(`agent ${s.agentId}`);
  return parts.join(' ');
}

function firstLines(prompt: string): string {
  const lines = prompt.split('\n').slice(0, 3).join(' / ');
  return lines.length > 200 ? `${lines.slice(0, 199)}…` : lines;
}
