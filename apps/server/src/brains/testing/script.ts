import type { AgentRole, Id } from '@galactic/protocol';
import type { BrainTranscript, ToolOutcome } from './transcript.js';

/**
 * A brain script (P2-07): the scripted "LLM" of one brain, as a list of turn rules. Every turn
 * prompt the brain receives is matched against the rules; the first rule that matches and still
 * has uses left answers the turn by running its body, which calls tools through `t.call`, reads
 * their results, and says things. The turn ends when the body returns.
 *
 *   script
 *     .once(firstTurn, () => {})                       // the seed turn: nothing to do
 *     .once('export it', async (t) => {               // "when the prompt mentions …"
 *       const task = await t.call<{ id: string }>('create_task', { description: 'export' });
 *       await t.call('ask_user', { text: `Which format for ${task.id}?` });
 *     })
 *     .on(/answered/, (t) => t.say('thanks'));         // any number of times
 *
 * `once` rules are expectations: `verify()` reports one that never matched. A strict script (the
 * default) also reports every turn no rule answered (except a session's first prompt, unless
 * `allowFirst: false`), so a brain woken when it should not be fails the test.
 */

/** What a rule may look at to decide whether it answers a turn. */
export interface TurnInfo {
  agentId: Id;
  role: AgentRole;
  projectId?: Id;
  /** 1-based, across the brain's sessions. */
  index: number;
  /** 0 for a session's first prompt, then 1, 2, … */
  n: number;
  session: number;
  /** A session's first prompt (spawn or session reset). */
  first: boolean;
  prompt: string;
}

/** What a rule body gets: the turn, plus the model's actions. */
export interface TurnContext extends TurnInfo {
  /**
   * Calls one of the brain's tools and resolves to its result (the value inside a turn-ending
   * tool's envelope). A refusal (a `DomainError`, a call after the turn ended) rejects with
   * `ToolRefused`; use `try` to look at refusals instead.
   */
  call<T = unknown>(tool: string, input?: unknown): Promise<T>;
  /** Calls a tool and resolves to the full outcome, refused or not. */
  try(tool: string, input?: unknown): Promise<ToolOutcome>;
  /** Text output of the model. */
  say(text: string): void;
  /** The prompt contains `text` (or matches it). */
  mentions(text: string | RegExp): boolean;
  /** Everything this brain did so far, earlier turns included (ids returned by earlier calls). */
  transcript: BrainTranscript;
}

export type TurnMatcher = string | RegExp | ((turn: TurnInfo) => boolean);
export type TurnBody = (t: TurnContext) => void | Promise<void>;

export interface ScriptRule {
  label: string;
  matcher?: TurnMatcher;
  body: TurnBody;
  /** How many turns it may answer (`Infinity` for `on`). */
  times: number;
  /** `once`/`times` rules must be used up; `on` rules need not be used at all. */
  required: boolean;
  used: number;
}

export interface ScriptOptions {
  /** Report turns no rule answered. Default true. */
  strict?: boolean;
  /** A strict script still lets a session's first prompt go unanswered. Default true. */
  allowFirst?: boolean;
}

/** Matches a session's first prompt (the spawn, or the prompt after a session reset). */
export const firstTurn = (t: TurnInfo): boolean => t.first;

/** Matches the brain's `index`-th turn (1-based, across sessions). */
export const turnIndex =
  (index: number) =>
  (t: TurnInfo): boolean =>
    t.index === index;

export function matches(matcher: TurnMatcher | undefined, turn: TurnInfo): boolean {
  if (matcher === undefined) return true;
  if (typeof matcher === 'string') return turn.prompt.includes(matcher);
  if (matcher instanceof RegExp) return matcher.test(turn.prompt);
  return matcher(turn);
}

function describe(matcher: TurnMatcher | undefined): string {
  if (matcher === undefined) return 'any turn';
  if (typeof matcher === 'string') return `prompt mentions ${JSON.stringify(matcher)}`;
  if (matcher instanceof RegExp) return `prompt matches ${String(matcher)}`;
  if (matcher === firstTurn) return 'first prompt';
  return matcher.name ? `${matcher.name}()` : 'a custom matcher';
}

export class BrainScript {
  readonly rules: ScriptRule[] = [];
  readonly strict: boolean;
  readonly allowFirst: boolean;

  constructor(opts: ScriptOptions = {}) {
    this.strict = opts.strict ?? true;
    this.allowFirst = opts.allowFirst ?? true;
  }

  /** A rule that must answer exactly one turn: `once(body)` takes the next turn of any kind. */
  once(body: TurnBody): this;
  once(matcher: TurnMatcher, body: TurnBody, label?: string): this;
  once(a: TurnMatcher | TurnBody, b?: TurnBody, label?: string): this {
    return this.add(1, true, a, b, label);
  }

  /** A rule that must answer exactly `count` turns. */
  times(count: number, matcher: TurnMatcher, body: TurnBody, label?: string): this {
    return this.add(count, true, matcher, body, label);
  }

  /** A rule that answers every matching turn, any number of times (zero included). */
  on(body: TurnBody): this;
  on(matcher: TurnMatcher, body: TurnBody, label?: string): this;
  on(a: TurnMatcher | TurnBody, b?: TurnBody, label?: string): this {
    return this.add(Infinity, false, a, b, label);
  }

  /** The rule that answers `turn` (and uses it up), or `undefined`. */
  take(turn: TurnInfo): ScriptRule | undefined {
    const rule = this.rules.find((r) => r.used < r.times && matches(r.matcher, turn));
    if (rule) rule.used++;
    return rule;
  }

  /** Required rules that have uses left. */
  unmet(): ScriptRule[] {
    return this.rules.filter((r) => r.required && r.used < r.times);
  }

  private add(
    times: number,
    required: boolean,
    a: TurnMatcher | TurnBody,
    b: TurnBody | undefined,
    label: string | undefined,
  ): this {
    const [matcher, body] = b === undefined ? [undefined, a as TurnBody] : [a as TurnMatcher, b];
    this.rules.push({
      label: label ?? describe(matcher),
      ...(matcher !== undefined ? { matcher } : {}),
      body,
      times,
      required,
      used: 0,
    });
    return this;
  }
}

/** A `t.call` that the server refused; the message names the tool, code and reason. */
export class ToolRefused extends Error {
  constructor(readonly outcome: ToolOutcome) {
    super(
      `${outcome.tool} was refused (${outcome.error ?? 'error'})` +
        (outcome.message ? `: ${outcome.message}` : ''),
    );
    this.name = 'ToolRefused';
  }
}
