import type { Cost, PermissionAction, Progress } from '@galactic/protocol';

/**
 * A scripted fake agent (P1-03). A scenario is the list of steps the agent performs in its
 * first turn (the prompt) and a rule for every later message. Every normalised event of
 * TECHNOLOGY §3.4 except `agent.spawned` (emitted by the runtime layer, not by adapters) can be
 * produced by a step; questions block the turn until `answer()` is called, exactly like a real
 * agent waiting on the user.
 */
export type FakeStep =
  | { kind: 'output'; text: string; output?: 'text' | 'tool' | 'thinking'; delayMs?: number }
  /** A tool call, through the runtime's permission gate like every other (allow runs it at once). */
  | { kind: 'tool_call'; toolName: string; input?: unknown; delayMs?: number }
  | { kind: 'progress'; summary: string; progress?: Progress; delayMs?: number }
  /** A clarification question; the answer is echoed as output and the turn continues. */
  | { kind: 'ask'; text: string; options?: string[] }
  /**
   * Several clarifications as one question set (P8-20): every row opens at once and the turn
   * waits for all; the answers are echoed as one output line (`answers: <text> <answer>; …`).
   */
  | {
      kind: 'ask_set';
      title?: string;
      questions: { text: string; options?: string[]; multiSelect?: boolean }[];
    }
  /**
   * A tool call the scenario expects the gate to question (a destructive command, a push, …).
   * Same path as `tool_call` — the gate decides — with the question text and the action the
   * permission card shows when the gate has no better ones. An answer of `allow`/`yes`/`y`
   * performs the call (an `agent.tool_call` follows); anything else skips it with an output line.
   */
  | {
      kind: 'permission';
      toolName: string;
      input?: unknown;
      permissionAction: PermissionAction;
      text?: string;
    }
  /** No events at all for `ms` (lets the status store's silence threshold fire). */
  | { kind: 'silence'; ms: number }
  /** The runtime itself reports a stall (a PTY adapter's heuristic would). */
  | { kind: 'stall'; silentForMs: number }
  /** Ends the turn early: `agent.idle`, then wait for the next message. */
  | { kind: 'idle' }
  /**
   * The session's running cost from now on (P8-01): cumulative, like the SDK's `total_cost_usd`;
   * every later `agent.idle` of the session reports it. Emits nothing itself.
   */
  | { kind: 'cost'; cost: Cost }
  | { kind: 'finish'; result?: string; cost?: Cost; delayMs?: number }
  | { kind: 'fail'; error: string; reason: 'cap' | 'crash' | 'runtime' | 'unknown'; cost?: Cost }
  /**
   * A scripted stretch of the turn (P2-07): `run` performs tool calls and output through `io`,
   * in order, and reads each tool's result before deciding the next call — what a model does
   * between two tool results. The step ends when `run` settles. When the turn is cancelled
   * (interrupt, stop) the next `io` call rejects with `FakeTurnCancelled` and the turn ends.
   */
  | { kind: 'script'; run: (io: FakeTurnIO) => Promise<void> };

/** What a `script` step may do inside the turn. */
export interface FakeTurnIO {
  /** One tool call through the runtime's gate, exactly as a `tool_call` step; resolves to what happened. */
  toolCall(toolName: string, input?: unknown): Promise<FakeToolResult>;
  output(text: string, kind?: 'text' | 'tool' | 'thinking'): void;
}

export type FakeToolResult =
  /** The call ran. A server tool's handler value is `output` (its text form is `text`). */
  | { status: 'ran'; output?: unknown; text?: string }
  /** The gate denied it, or a permission question was answered no. */
  | { status: 'denied'; reason: string };

/** Rejects an `io` call made after the turn was cancelled. */
export class FakeTurnCancelled extends Error {
  constructor() {
    super('the fake turn was cancelled');
    this.name = 'FakeTurnCancelled';
  }
}

export interface FakeScenario {
  /** Steps of the first turn, driven by the prompt. */
  steps: FakeStep[];
  /**
   * Steps for the n-th later message (1-based). Default: echo the message and go idle. Return
   * `[]` to just go idle.
   */
  onMessage?: (message: string, n: number) => FakeStep[];
  /** Delay before every step that does not set its own; scaled by the adapter's `speed`. */
  stepDelayMs?: number;
  /** The slash commands a session of this scenario reports (P8-13); default the adapter's. */
  commands?: readonly unknown[];
}

/**
 * The slash commands the development server's fake runtime reports (P8-13), so the composer's
 * list can be tried without Claude: a built-in, a skill with an argument hint, a plugin command.
 */
export const DEV_FAKE_COMMANDS = [
  { name: 'compact', description: 'Clear the conversation but keep a summary', builtin: true },
  { name: 'review', description: 'Review a pull request', argumentHint: '<pr number>' },
  { name: 'docs:explain', description: 'Explain a file in plain words', argumentHint: '<path>' },
] as const;

export const echo = (message: string): FakeStep[] => [
  { kind: 'output', text: `received: ${message}` },
];

const COST: Cost = { usd: 0.0042, inputTokens: 1200, outputTokens: 340 };

/**
 * Named scenarios. A prompt of the form `scenario:<name>` picks one; anything else runs `echo`.
 * The ops console lists these names in dev mode.
 */
export const SCENARIOS: Record<string, FakeScenario> = {
  /** Prints the prompt back, then waits for messages and echoes each. */
  echo: { steps: [{ kind: 'output', text: 'hello from the fake agent' }] },

  /** A small job that succeeds: output, a tool call, progress, a result with cost. */
  happy: {
    steps: [
      { kind: 'output', text: 'Looking at the task.', output: 'thinking' },
      { kind: 'tool_call', toolName: 'Read', input: { file_path: 'README.md' } },
      { kind: 'output', text: 'Read README.md (42 lines)', output: 'tool' },
      { kind: 'progress', summary: 'Editing src/index.ts', progress: { done: 1, total: 3 } },
      { kind: 'tool_call', toolName: 'Edit', input: { file_path: 'src/index.ts' } },
      { kind: 'progress', summary: 'Running tests', progress: { done: 2, total: 3 } },
      { kind: 'tool_call', toolName: 'Bash', input: { command: 'pnpm test' } },
      { kind: 'output', text: 'All 12 tests pass.' },
      { kind: 'finish', result: 'Done: fixed the flaky date test.', cost: COST },
    ],
  },

  /** Stops to ask a clarification question, then finishes. */
  asks: {
    steps: [
      { kind: 'output', text: 'I need one detail before I start.' },
      {
        kind: 'ask',
        text: 'Which date format should the export use?',
        options: ['ISO 8601', 'US', 'EU'],
      },
      { kind: 'output', text: 'Thanks, going with that.' },
      { kind: 'finish', result: 'Export format applied.', cost: COST },
    ],
  },

  /** Asks three related clarifications as one question set, then finishes (P8-20). */
  'asks-set': {
    steps: [
      { kind: 'output', text: 'A few details before I start.' },
      {
        kind: 'ask_set',
        questions: [
          { text: 'Which date format should the export use?', options: ['ISO 8601', 'US', 'EU'] },
          { text: 'Which columns?', options: ['date', 'amount', 'note'], multiSelect: true },
          { text: 'Anything else I should know?' },
        ],
      },
      { kind: 'output', text: 'Thanks, going with that.' },
      { kind: 'finish', result: 'Export configured.', cost: COST },
    ],
  },

  /** Requests permission for a destructive command, then finishes either way. */
  permission: {
    steps: [
      { kind: 'output', text: 'The build directory is stale.' },
      {
        kind: 'permission',
        toolName: 'Bash',
        input: { command: 'rm -rf dist' },
        permissionAction: 'destructive',
      },
      { kind: 'output', text: 'Rebuilding.' },
      { kind: 'tool_call', toolName: 'Bash', input: { command: 'pnpm build' } },
      { kind: 'finish', result: 'Rebuilt.', cost: COST },
    ],
  },

  /** Goes silent for a while (status store → stalled), then reports a stall itself, then idles. */
  stalls: {
    steps: [
      { kind: 'output', text: 'Starting a long test run…' },
      { kind: 'silence', ms: 400 },
      { kind: 'stall', silentForMs: 400 },
      { kind: 'output', text: 'Tests done.' },
    ],
  },

  /** Fails with a runtime error. */
  fails: {
    steps: [
      { kind: 'output', text: 'Trying…' },
      { kind: 'fail', error: 'runtime exploded', reason: 'runtime', cost: COST },
    ],
  },

  /** Keeps working for a while with periodic progress: good for pause/resume and stop. */
  long: {
    stepDelayMs: 50,
    steps: [
      ...Array.from({ length: 20 }, (_, i): FakeStep => ({
        kind: 'progress',
        summary: `step ${i + 1} of 20`,
        progress: { done: i + 1, total: 20 },
      })),
      { kind: 'finish', result: 'long job done', cost: COST },
    ],
  },

  /** Everything in one run: the conformance walk. */
  full: {
    steps: [
      { kind: 'output', text: 'thinking about it', output: 'thinking' },
      { kind: 'tool_call', toolName: 'Grep', input: { pattern: 'TODO' } },
      { kind: 'output', text: '3 matches', output: 'tool' },
      { kind: 'ask', text: 'Fix all three?', options: ['yes', 'no'] },
      {
        kind: 'permission',
        toolName: 'Bash',
        input: { command: 'git push' },
        permissionAction: 'push',
      },
      { kind: 'progress', summary: 'wrapping up', progress: { done: 3, total: 3 } },
      { kind: 'idle' },
    ],
    onMessage: (message, n) =>
      n === 1
        ? [
            { kind: 'output', text: `received: ${message}` },
            { kind: 'finish', result: 'finished after the follow-up', cost: COST },
          ]
        : echo(message),
  },
};

export const DEFAULT_SCENARIO = 'echo';

/** `scenario:<name>` → name; anything else → the default. Unknown names fall back too. */
export function scenarioFromPrompt(
  prompt: string,
  scenarios: Record<string, FakeScenario> = SCENARIOS,
): { name: string; scenario: FakeScenario } {
  const m = /^\s*scenario:([a-z0-9_-]+)/i.exec(prompt);
  const wanted = m?.[1]?.toLowerCase();
  const name = wanted && scenarios[wanted] ? wanted : DEFAULT_SCENARIO;
  return { name, scenario: scenarios[name] ?? { steps: [] } };
}
