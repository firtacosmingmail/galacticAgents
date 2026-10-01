import { spawn, type ChildProcess } from 'node:child_process';
import type {
  SdkCanUseTool,
  SdkHook,
  SdkMessage,
  SdkPermissionResult,
  SdkQuery,
  SdkQueryOptions,
  SdkRateLimitEvent,
  SdkStreamingPrompt,
  SdkSurface,
  SdkUsage,
  SdkUserMessage,
} from './sdk-surface.js';

/**
 * A scripted stand-in for the Claude Agent SDK (tests only). It behaves the way the spike found
 * the real one to: a streaming prompt drives turns, every tool call goes through the
 * `PreToolUse` hook and then `canUseTool` when the hook said `ask`, `AskUserQuestion` lands in
 * `canUseTool`, each turn ends in a `result`, `interrupt()` ends the turn with an error result,
 * and the CLI is a child spawned through `spawnClaudeCodeProcess` that lives until the prompt
 * closes (then stdin EOF + the abort signal, like the real transport).
 */

export type FakeAction =
  | { text: string }
  | { thinking: string }
  | { tool: string; input: Record<string, unknown>; result?: string; isError?: boolean }
  | { askUser: FakeQuestion }
  /** One `AskUserQuestion` call carrying several questions. */
  | { askUsers: FakeQuestion[] }
  | { delayMs: number }
  | { resultError: 'error_max_turns' | 'error_during_execution'; errors?: string[] }
  /** A `result` with `subtype: 'success'` but `is_error: true` (API, auth, prompt too long). */
  | { resultIsError: string }
  /** A subscription `rate_limit_event`. */
  | { rateLimit: SdkRateLimitEvent['rate_limit_info'] }
  /** The message iterator throws (the CLI keeps running). */
  | { throwStream: string };

export interface FakeQuestion {
  question: string;
  options?: string[];
  multiSelect?: boolean;
}

export type FakeScript = (message: string, turn: number) => FakeAction[];

export interface FakeSdkOptions {
  script: FakeScript;
  /** Cost reported per turn; cumulative like the real SDK. */
  costPerTurn?: number;
  /** Usage reported on each result (default 10 in / 5 out). */
  usage?: SdkUsage;
  /** When false, no child is spawned (a pure in-process SDK). Default true. */
  spawnChild?: boolean;
  /** Also call `canUseTool` after the hook said `allow` (the real CLI may). */
  canUseToolAfterAllow?: boolean;
  /** `interrupt()` never settles and the turn goes on (a wedged CLI). */
  wedgeOnInterrupt?: boolean;
  /** After `interrupt()` the message iterator throws instead of ending the turn (the CLI keeps running). */
  throwOnInterrupt?: boolean;
  /** `system/init` reports this session id instead of the requested one. */
  initSessionId?: string;
}

export interface FakeSdkCall {
  options: SdkQueryOptions;
  prompt: string | SdkStreamingPrompt;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class FakeSdk implements SdkSurface {
  readonly calls: FakeSdkCall[] = [];
  readonly servers: { name: string; tools: unknown[] }[] = [];
  readonly tools: {
    name: string;
    description: string;
    shape: unknown;
    handler: (i: Record<string, unknown>) => Promise<unknown>;
  }[] = [];
  readonly children: ChildProcess[] = [];
  /** How many times `query.interrupt()` was called, over all queries. */
  interrupts = 0;
  /** How many prompts were closed by the adapter (the CLI then sees stdin EOF). */
  inputClosed = 0;

  constructor(private readonly opts: FakeSdkOptions) {}

  createSdkMcpServer(config: { name: string; version?: string; tools: unknown[] }): unknown {
    this.servers.push({ name: config.name, tools: config.tools });
    return { type: 'sdk', name: config.name };
  }

  tool(
    name: string,
    description: string,
    inputShape: unknown,
    handler: (i: Record<string, unknown>) => Promise<unknown>,
  ): unknown {
    const def = { name, description, shape: inputShape, handler };
    this.tools.push(def);
    return def;
  }

  query(params: { prompt: string | SdkStreamingPrompt; options?: SdkQueryOptions }): SdkQuery {
    const options = params.options ?? {};
    this.calls.push({ options, prompt: params.prompt });
    const sessionId = options.resume ?? options.sessionId ?? 'fake-session';
    const out = new Queue<SdkMessage>();
    let interrupted = false;
    let turn = 0;
    let cost = 0;
    const hook: SdkHook | undefined = options.hooks?.PreToolUse?.[0]?.hooks[0];
    const canUseTool: SdkCanUseTool | undefined = options.canUseTool;
    const abort = new AbortController();

    // The "CLI": a child that lives until the prompt closes.
    let child: ChildProcess | undefined;
    if (this.opts.spawnChild !== false) {
      const spawnOpts = {
        command: process.execPath,
        args: [
          '-e',
          'process.stdin.resume(); process.stdin.on("end", () => process.exit(0)); setInterval(() => {}, 1000)',
        ],
        cwd: options.cwd ?? process.cwd(),
        env: { ...process.env, FAKE_SDK: '1' },
        signal: abort.signal,
      };
      child = options.spawnClaudeCodeProcess
        ? options.spawnClaudeCodeProcess(spawnOpts)
        : spawn(spawnOpts.command, spawnOpts.args, {
            cwd: spawnOpts.cwd,
            env: spawnOpts.env,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
      this.children.push(child);
      child.once('exit', () => out.close());
    }

    out.push({
      type: 'system',
      subtype: 'init',
      session_id: this.opts.initSessionId ?? sessionId,
      model: options.model ?? 'fake',
      tools: [],
    });

    const usage = this.opts.usage ?? { input_tokens: 10, output_tokens: 5 };
    /** Waits until the turn is interrupted, forever when the fake is wedged. */
    let onInterrupt: (() => void) | undefined;

    const askUser = async (id: string, questions: FakeQuestion[]): Promise<boolean> => {
      const input = {
        questions: questions.map((q) => ({
          question: q.question,
          header: 'Q',
          options: (q.options ?? []).map((label) => ({ label, description: '' })),
          multiSelect: q.multiSelect ?? false,
        })),
      };
      out.push({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input }] },
        parent_tool_use_id: null,
        session_id: sessionId,
      });
      await out.drained(); // the real SDK reads its stream in order: the message lands before the request
      const verdict: SdkPermissionResult = canUseTool
        ? await canUseTool('AskUserQuestion', input, { signal: abort.signal, toolUseID: id })
        : { behavior: 'allow', updatedInput: input };
      if (interrupted) return false;
      const answers =
        verdict.behavior === 'allow'
          ? (verdict.updatedInput['answers'] as Record<string, string> | undefined)
          : undefined;
      out.push({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: id,
              content: answers ? `The user answered: ${JSON.stringify(answers)}` : 'denied',
              is_error: !answers,
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: sessionId,
      });
      return true;
    };

    const runTurn = async (text: string) => {
      turn++;
      interrupted = false;
      const actions = this.opts.script(text, turn);
      const seen = new Map<string, number>();
      /** Unique per call, like the real ids: `toolu_<turn>_<tool>` and `_2`, `_3`… for repeats. */
      const toolUseId = (name: string) => {
        const n = (seen.get(name) ?? 0) + 1;
        seen.set(name, n);
        return `toolu_${turn}_${name}${n > 1 ? `_${n}` : ''}`;
      };
      let errored:
        { subtype: 'error_max_turns' | 'error_during_execution'; errors?: string[] } | undefined;
      let isError: string | undefined;
      for (const action of actions) {
        if (interrupted) break;
        if ('text' in action) {
          out.push({
            type: 'assistant',
            message: { content: [{ type: 'text', text: action.text }] },
            parent_tool_use_id: null,
            session_id: sessionId,
          });
        } else if ('thinking' in action) {
          out.push({
            type: 'assistant',
            message: { content: [{ type: 'thinking', thinking: action.thinking }] },
            parent_tool_use_id: null,
            session_id: sessionId,
          });
        } else if ('delayMs' in action) {
          await Promise.race([sleep(action.delayMs), new Promise<void>((r) => (onInterrupt = r))]);
          onInterrupt = undefined;
        } else if ('resultError' in action) {
          errored = {
            subtype: action.resultError,
            ...(action.errors ? { errors: action.errors } : {}),
          };
          break;
        } else if ('resultIsError' in action) {
          isError = action.resultIsError;
          break;
        } else if ('rateLimit' in action) {
          out.push({
            type: 'rate_limit_event',
            rate_limit_info: action.rateLimit,
            session_id: sessionId,
          });
        } else if ('throwStream' in action) {
          out.fail(new Error(action.throwStream));
          return;
        } else if ('askUser' in action) {
          if (!(await askUser(toolUseId('AskUserQuestion'), [action.askUser]))) break;
        } else if ('askUsers' in action) {
          if (!(await askUser(toolUseId('AskUserQuestion'), action.askUsers))) break;
        } else if ('tool' in action) {
          const id = toolUseId(action.tool);
          out.push({
            type: 'assistant',
            message: {
              content: [{ type: 'tool_use', id, name: action.tool, input: action.input }],
            },
            parent_tool_use_id: null,
            session_id: sessionId,
          });
          let decision: 'allow' | 'deny' | 'ask' = 'allow';
          let reason = '';
          await out.drained();
          if (hook) {
            const h = await hook(
              {
                hook_event_name: 'PreToolUse',
                tool_name: action.tool,
                tool_input: action.input,
                tool_use_id: id,
                session_id: sessionId,
              },
              id,
              { signal: abort.signal },
            );
            decision = h.hookSpecificOutput?.permissionDecision ?? 'allow';
            reason = h.hookSpecificOutput?.permissionDecisionReason ?? '';
          }
          if (
            canUseTool &&
            (decision === 'ask' || (decision === 'allow' && this.opts.canUseToolAfterAllow))
          ) {
            const v = await canUseTool(action.tool, action.input, {
              signal: abort.signal,
              toolUseID: id,
              decisionReason: reason,
              title: `Claude wants to run ${action.tool}`,
            });
            if (interrupted) break;
            decision = v.behavior;
            if (v.behavior === 'deny') reason = v.message;
          }
          const content =
            decision === 'allow'
              ? (action.result ?? 'ok')
              : `The user doesn't want to proceed: ${reason}`;
          out.push({
            type: 'user',
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: id,
                  content,
                  is_error: decision !== 'allow' || action.isError === true,
                },
              ],
            },
            parent_tool_use_id: null,
            session_id: sessionId,
          });
        }
      }
      cost += this.opts.costPerTurn ?? 0.01;
      if (interrupted) {
        if (this.opts.throwOnInterrupt) {
          out.fail(new Error('Claude Code returned an error result: interrupted'));
          return;
        }
        out.push({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          session_id: sessionId,
          total_cost_usd: cost,
          usage,
          errors: ['interrupted'],
        });
      } else if (errored) {
        out.push({
          type: 'result',
          subtype: errored.subtype,
          is_error: true,
          session_id: sessionId,
          total_cost_usd: cost,
          ...(errored.errors ? { errors: errored.errors } : {}),
        });
      } else if (isError !== undefined) {
        out.push({
          type: 'result',
          subtype: 'success',
          is_error: true,
          session_id: sessionId,
          total_cost_usd: cost,
          usage,
          num_turns: 1,
          result: isError,
        });
      } else {
        const lastText = [...actions]
          .reverse()
          .find((a): a is { text: string } => 'text' in a)?.text;
        out.push({
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: sessionId,
          total_cost_usd: cost,
          usage,
          num_turns: 1,
          ...(lastText !== undefined ? { result: lastText } : {}),
        });
      }
    };

    // Drive turns from the prompt.
    void (async () => {
      try {
        if (typeof params.prompt === 'string') {
          await runTurn(params.prompt);
        } else {
          for await (const m of params.prompt)
            await runTurn(typeof m.message.content === 'string' ? m.message.content : '');
        }
      } finally {
        // Prompt closed: stdin EOF, then the abort signal, like the real transport.
        this.inputClosed++;
        if (child) {
          child.stdin?.end();
          // Give the CLI a moment to exit on EOF (more than a loaded test machine needs).
          if (child.exitCode === null && child.signalCode === null) {
            const c = child;
            await Promise.race([sleep(500), new Promise((r) => c.once('exit', r))]);
          }
          abort.abort();
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        } else {
          out.close();
        }
      }
    })();

    const iterable = out[Symbol.asyncIterator].bind(out);
    return {
      [Symbol.asyncIterator]: iterable,
      interrupt: async () => {
        this.interrupts++;
        if (this.opts.wedgeOnInterrupt) return new Promise<never>(() => {});
        interrupted = true;
        onInterrupt?.();
        return { still_queued: [] };
      },
    };
  }
}

/** Minimal push queue for the fake's message stream. */
class Queue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiting:
    { resolve: (r: IteratorResult<T>) => void; reject: (e: Error) => void } | undefined;
  private closed = false;
  private error: Error | undefined;
  private drainWaiters: (() => void)[] = [];
  /** Resolves once the consumer has pulled everything pushed so far. */
  drained(): Promise<void> {
    if (this.items.length === 0) return Promise.resolve();
    return new Promise((r) => this.drainWaiters.push(r));
  }
  push(item: T): void {
    if (this.closed) return;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = undefined;
      w.resolve({ value: item, done: false });
    } else this.items.push(item);
  }
  close(): void {
    this.closed = true;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = undefined;
      w.resolve({ value: undefined, done: true });
    }
  }
  /** The consumer's next read (after what is queued) throws `error`. */
  fail(error: Error): void {
    if (this.closed) return;
    this.error = error;
    this.closed = true;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = undefined;
      w.reject(error);
    }
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length > 0) {
          const value = this.items.shift()!;
          if (this.items.length === 0) for (const w of this.drainWaiters.splice(0)) w();
          return Promise.resolve({ value, done: false });
        }
        if (this.error) return Promise.reject(this.error);
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => {
          this.waiting = { resolve, reject };
        });
      },
    };
  }
}

export type { SdkUserMessage };
