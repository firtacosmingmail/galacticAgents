import type { AgentRole, Id } from '@galactic/protocol';
import type { FakeToolResult } from '../../adapters/fake/scenario.js';

/**
 * What a scripted brain saw and did, turn by turn (P2-07): the model-side view of a brain. The
 * runner's own `TurnRecord`s say why a turn happened (which mailbox items); this says what the
 * "model" was shown and which tools it called with which results.
 */

/** One tool call as the model saw it. */
export interface ToolOutcome {
  tool: string;
  input: unknown;
  /** False for a refused command (`{error, message}`), a call after the turn ended, a denial. */
  ok: boolean;
  /** The tool's result; for a turn-ending tool, the `result` inside its envelope. */
  value?: unknown;
  /** The refusal code (`not_found`, `turn_ended`, `denied`, …). */
  error?: string;
  message?: string;
  /** The tool ended the turn (`ask_user`, `propose`, …, or `endsTurn`). */
  turnEnded: boolean;
  /** Exactly what the handler returned. */
  raw: unknown;
}

export type TranscriptEntry =
  | { kind: 'call'; outcome: ToolOutcome }
  | { kind: 'say'; text: string }
  /** The script threw (a refused `t.call`, a failed assertion, a bug in the script). */
  | { kind: 'error'; message: string }
  /** The turn was interrupted or the brain stopped while the script ran. */
  | { kind: 'cancelled' };

export interface TranscriptTurn {
  /** 1-based, across the brain's sessions. */
  index: number;
  /** 0 for a session's first prompt, then 1, 2, … for each later turn of that session. */
  n: number;
  /** 1-based; a session reset starts the next one. */
  session: number;
  prompt: string;
  /** The label of the rule that answered the turn; absent when no rule matched. */
  rule?: string;
  entries: TranscriptEntry[];
  /** The script body has returned (or there was none). */
  done: boolean;
}

export class BrainTranscript {
  readonly turns: TranscriptTurn[] = [];
  /** Sessions started so far (the spawn is 1; every session reset adds one). */
  session = 0;

  constructor(
    readonly agentId: Id,
    readonly role: AgentRole,
    public projectId?: Id,
  ) {}

  get label(): string {
    return `${this.role} ${this.agentId}${this.projectId ? ` (project ${this.projectId})` : ''}`;
  }

  /** Every tool call, or the calls of one tool, in order. */
  calls(tool?: string): ToolOutcome[] {
    return this.turns.flatMap((t) =>
      t.entries.flatMap((e) =>
        e.kind === 'call' && (tool === undefined || e.outcome.tool === tool) ? [e.outcome] : [],
      ),
    );
  }

  /** The latest call of `tool`, if any. */
  last(tool: string): ToolOutcome | undefined {
    return this.calls(tool).at(-1);
  }

  prompts(): string[] {
    return this.turns.map((t) => t.prompt);
  }

  /** Errors the script raised, with their turn. */
  errors(): { turn: number; message: string }[] {
    return this.turns.flatMap((t) =>
      t.entries.flatMap((e) => (e.kind === 'error' ? [{ turn: t.index, message: e.message }] : [])),
    );
  }

  /** A readable dump for failure messages. */
  render(): string {
    const lines = [`${this.label}: ${plural(this.turns.length, 'turn')}`];
    for (const turn of this.turns) {
      const tags = [`session ${turn.session}`];
      if (turn.n === 0) tags.push('first prompt');
      const rule = turn.rule ? `rule: ${turn.rule}` : 'unscripted';
      lines.push(`  turn ${turn.index} (${tags.join(', ')}) [${rule}]${turn.done ? '' : ' …'}`);
      lines.push(...promptLines(turn.prompt));
      for (const entry of turn.entries) lines.push(...entryLines(entry));
    }
    return lines.join('\n');
  }
}

/** The model-side reading of a fake adapter tool result (what the runner's `runTool` returned). */
export function toOutcome(tool: string, input: unknown, result: FakeToolResult): ToolOutcome {
  if (result.status === 'denied') {
    return { tool, input, ok: false, error: 'denied', message: result.reason, turnEnded: false, raw: undefined };
  }
  const raw = result.output;
  if (isObject(raw) && typeof raw.error === 'string') {
    return {
      tool,
      input,
      ok: false,
      error: raw.error,
      ...(typeof raw.message === 'string' ? { message: raw.message } : {}),
      turnEnded: false,
      raw,
    };
  }
  if (isObject(raw) && raw.turnEnded === true) {
    return { tool, input, ok: true, value: raw.result, turnEnded: true, raw };
  }
  return { tool, input, ok: true, value: raw, turnEnded: false, raw };
}

const MAX_PROMPT_LINES = 8;
const MAX_LINE = 160;

function promptLines(prompt: string): string[] {
  const all = prompt.split('\n');
  const shown = all.slice(0, MAX_PROMPT_LINES).map((l) => `    │ ${clip(l)}`);
  if (all.length > MAX_PROMPT_LINES) shown.push(`    │ … (${all.length - MAX_PROMPT_LINES} more lines)`);
  return shown;
}

function entryLines(entry: TranscriptEntry): string[] {
  switch (entry.kind) {
    case 'call': {
      const o = entry.outcome;
      const head = `    → ${o.tool} ${clip(json(o.input))}`;
      const tail = o.ok
        ? `      ← ${o.turnEnded ? '(turn ended) ' : ''}${clip(json(o.value))}`
        : `      ✗ ${o.error}${o.message ? `: ${clip(o.message)}` : ''}`;
      return [head, tail];
    }
    case 'say':
      return [`    says: ${clip(JSON.stringify(entry.text))}`];
    case 'error':
      return [`    ! error: ${clip(entry.message)}`];
    case 'cancelled':
      return ['    (turn cancelled)'];
  }
}

export function json(value: unknown): string {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function clip(text: string, max = MAX_LINE): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
