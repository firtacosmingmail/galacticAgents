import type { Cost, ToolCall } from '@galactic/protocol';
import type {
  ContentBlock,
  ElicitationPropertySchema,
  PermissionOption,
  PermissionOptionKind,
  Plan,
  ToolCall as AcpToolCall,
  ToolCallContent,
  ToolCallUpdate,
  ToolKind,
  Usage,
} from '@agentclientprotocol/sdk';

/**
 * Pure translations between ACP's vocabulary and the server's (P8-07; TECHNOLOGY §3.2). Kept
 * apart from the adapter so each rule has a unit test of its own.
 */

/** What the adapter knows about one tool call: every `tool_call` / `tool_call_update` merged. */
export type ToolState = ToolCallUpdate & { title?: string | null };

/** Merges a `tool_call_update` (only the fields it carries) into what is known so far. */
export function mergeTool(
  known: ToolState | undefined,
  update: ToolCallUpdate | AcpToolCall,
): ToolState {
  const next: ToolState = { ...(known ?? { toolCallId: update.toolCallId }) };
  for (const [k, v] of Object.entries(update)) {
    if (v !== undefined && v !== null && k !== 'sessionUpdate') {
      (next as Record<string, unknown>)[k] = v;
    }
  }
  return next;
}

/** ACP tool kinds that do nothing outside the agent: no gate, no `agent.tool_call`. */
export const BOOKKEEPING_KINDS: ReadonlySet<ToolKind> = new Set(['think', 'switch_mode']);

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

/** The first string among `keys` of the raw input. */
function pick(raw: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = str(raw[k]);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** A shell command from an ACP agent's raw input: `command` (string or argv), `cmd`, `script`. */
function commandOf(raw: Record<string, unknown>): string | undefined {
  for (const key of ['command', 'cmd', 'script']) {
    const v = raw[key];
    if (typeof v === 'string' && v.trim()) return v;
    if (Array.isArray(v) && v.every((p) => typeof p === 'string') && v.length > 0) {
      // An argv: a wrapper like ["bash", "-lc", "<script>"] carries the script last.
      const argv = v as string[];
      if (argv.length >= 3 && /(^|\/)(ba|z|da)?sh$/.test(argv[0]!) && /^-\w*c$/.test(argv[1]!)) {
        return argv.slice(2).join(' ');
      }
      return argv.map((p) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`)).join(' ');
    }
  }
  return undefined;
}

const PATH_KEYS = ['file_path', 'path', 'filePath', 'absolute_path', 'notebook_path', 'file'];

/**
 * The gate's view of an ACP tool call. The permission engine speaks Claude Code's tool names
 * (`Read`, `Edit`, `Bash`, `WebFetch` …: `domain/permissions.ts`), so an ACP call is translated by
 * its `kind` and its raw input into the call it is equivalent to — an `execute` with a command is
 * `Bash {command}`, an `edit` on a path is `Edit {file_path}` — and anything that cannot be placed
 * keeps a name the engine does not know, so the table's `unclassified` entry decides it (`ask`
 * unless the project is trusted): a call is never made to look safer than it is. The original
 * ACP fields travel along in the input (`acp: {kind, title}`) for the permission card.
 */
export function gateCall(tool: ToolState): ToolCall {
  const raw = asRecord(tool.rawInput);
  const kind = tool.kind ?? 'other';
  const locations = (tool.locations ?? []).map((l) => l.path).filter((p) => p.length > 0);
  const path = pick(raw, PATH_KEYS) ?? locations[0];
  const title = tool.title ?? tool.name ?? undefined;
  const acp = { kind, ...(title ? { title } : {}) };
  const unclassified = (): ToolCall => ({
    toolName: `acp:${tool.name ?? kind}`,
    input: { ...raw, ...(locations.length ? { locations } : {}), acp },
  });
  switch (kind) {
    case 'execute': {
      const command = commandOf(raw);
      return command ? { toolName: 'Bash', input: { command, acp } } : unclassified();
    }
    case 'read':
      return path ? { toolName: 'Read', input: { file_path: path, acp } } : unclassified();
    case 'search':
      return {
        toolName: 'Grep',
        input: {
          ...(pick(raw, ['pattern', 'query']) ? { pattern: pick(raw, ['pattern', 'query']) } : {}),
          ...(path ? { path } : {}),
          acp,
        },
      };
    case 'edit':
    case 'delete':
      // A delete is an edit of the file it removes: inside the workspace it is the table's
      // `edit_workspace`, outside it `outside_workspace` (the engine's own Edit rules).
      return path ? { toolName: 'Edit', input: { file_path: path, acp } } : unclassified();
    case 'move': {
      const from = pick(raw, ['from', 'source', 'src', 'old_path', ...PATH_KEYS]) ?? locations[0];
      const to = pick(raw, ['to', 'destination', 'dest', 'new_path']) ?? locations[1];
      // Both ends are checked (the engine reads every path field of an edit).
      return from && to
        ? { toolName: 'Edit', input: { file_path: from, path: to, acp } }
        : unclassified();
    }
    case 'fetch': {
      const url = pick(raw, ['url', 'uri', 'query']);
      return { toolName: 'WebFetch', input: { ...(url ? { url } : {}), acp } };
    }
    default:
      return unclassified();
  }
}

/** A one-line description of a call for the permission card and the transcript. */
export function describeTool(tool: ToolState): string {
  return tool.title ?? tool.name ?? `${tool.kind ?? 'a'} tool call`;
}

/**
 * The option the adapter answers a permission request with. Never an `*_always` one when a
 * `*_once` exists: an "always" would let the agent skip asking next time, and every call must
 * reach the gate. Without a `*_once`, the `*_always` is the only way to say it.
 */
export function chooseOption(
  options: PermissionOption[],
  allow: boolean,
): PermissionOption | undefined {
  const order: PermissionOptionKind[] = allow
    ? ['allow_once', 'allow_always']
    : ['reject_once', 'reject_always'];
  for (const kind of order) {
    const found = options.find((o) => o.kind === kind);
    if (found) return found;
  }
  return undefined;
}

/** Text of a content block for the transcript; non-text blocks become a short marker. */
export function contentText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'resource_link':
      return `[${block.title ?? block.name}: ${block.uri}]`;
    case 'resource':
      return 'text' in block.resource ? block.resource.text : `[resource ${block.resource.uri}]`;
    default:
      return `[${block.type}]`;
  }
}

/** A tool call's result as a transcript excerpt (content blocks, diffs, else the raw output). */
export function toolResultText(tool: ToolState, maxChars: number): string {
  const parts: string[] = [];
  for (const c of (tool.content ?? []) as ToolCallContent[]) {
    if (c.type === 'content') parts.push(contentText(c.content));
    else if (c.type === 'diff') parts.push(`diff ${c.path}`);
    else if (c.type === 'terminal') parts.push(`[terminal ${c.terminalId}]`);
  }
  if (parts.length === 0 && tool.rawOutput !== undefined) {
    parts.push(typeof tool.rawOutput === 'string' ? tool.rawOutput : JSON.stringify(tool.rawOutput));
  }
  return parts.join('\n').slice(0, maxChars);
}

/** A plan update as progress: done / total and the entry in progress. */
export function planProgress(plan: Plan): {
  summary: string;
  progress: { done: number; total: number; items: { label: string; done: boolean }[] };
} {
  const entries = plan.entries;
  const done = entries.filter((e) => e.status === 'completed').length;
  const current = entries.find((e) => e.status === 'in_progress');
  return {
    summary: current
      ? `${current.content} (${done}/${entries.length})`
      : `plan: ${done}/${entries.length} done`,
    progress: {
      done,
      total: entries.length,
      items: entries.map((e) => ({ label: e.content, done: e.status === 'completed' })),
    },
  };
}

/**
 * The session's running cost (TECHNOLOGY §3.4: cumulative per session). ACP reports dollars as
 * the session's cumulative `usage_update.cost` (kept as the latest figure, USD only — another
 * currency is not converted and stays unreported) and tokens per turn on the prompt response
 * (added up here).
 */
export class CostMeter {
  usd: number | undefined;
  inputTokens = 0;
  outputTokens = 0;
  private tokens = false;

  /** `usage_update.cost`: the session's cumulative total. */
  sessionCost(cost: { amount: number; currency: string } | null | undefined): void {
    if (!cost || cost.currency.toUpperCase() !== 'USD' || !(cost.amount >= 0)) return;
    this.usd = Math.max(this.usd ?? 0, cost.amount);
  }

  /** `PromptResponse.usage`: one turn's tokens. */
  turn(usage: Usage | null | undefined): void {
    if (!usage) return;
    this.tokens = true;
    this.inputTokens += Math.max(
      0,
      Math.round(usage.inputTokens + (usage.cachedReadTokens ?? 0) + (usage.cachedWriteTokens ?? 0)),
    );
    this.outputTokens += Math.max(0, Math.round(usage.outputTokens + (usage.thoughtTokens ?? 0)));
  }

  /** The running total, or `undefined` when the agent reported nothing (budgets: "not reported"). */
  get cost(): Cost | undefined {
    if (this.usd === undefined && !this.tokens) return undefined;
    return {
      ...(this.usd !== undefined ? { usd: this.usd } : {}),
      ...(this.tokens ? { inputTokens: this.inputTokens, outputTokens: this.outputTokens } : {}),
    };
  }
}

/** One field of a form elicitation, as a clarification question and how its answer is read. */
export interface FormField {
  key: string;
  text: string;
  options?: string[];
  /** The answer text → the value the form wants; `undefined` when it cannot be read. */
  parse(answer: string): string | number | boolean | string[] | undefined;
}

/**
 * A form elicitation → one clarification per field (TECHNOLOGY §3.2: "the form's first field is
 * the question, its enum the options"): the message is the question, a field's title is added
 * when there are several, an enum (or `oneOf`) gives the options and the answer is matched back to
 * the value, a boolean asks yes/no, a number must parse, a multi-select takes labels separated by
 * commas.
 */
export function formFields(
  message: string,
  properties: Record<string, ElicitationPropertySchema>,
  required: readonly string[] = [],
): FormField[] {
  const keys = Object.keys(properties);
  // Required fields first, each group in the schema's order.
  keys.sort((a, b) => Number(required.includes(b)) - Number(required.includes(a)));
  return keys.map((key) => {
    const p = properties[key] as Record<string, unknown> & { type: string };
    const label = str(p['title']) ?? str(p['description']) ?? key;
    const text = keys.length > 1 ? `${message} — ${label}` : message;
    switch (p.type) {
      case 'boolean':
        return {
          key,
          text,
          options: ['yes', 'no'],
          parse: (a) =>
            /^(y|yes|true|ok|1)$/i.test(a.trim())
              ? true
              : /^(n|no|false|0)$/i.test(a.trim())
                ? false
                : undefined,
        };
      case 'number':
      case 'integer':
        return {
          key,
          text,
          parse: (a) => {
            const n = Number(a.trim());
            if (!Number.isFinite(n) || a.trim() === '') return undefined;
            return p.type === 'integer' ? (Number.isInteger(n) ? n : undefined) : n;
          },
        };
      case 'array': {
        const items = asRecord(p['items']);
        const choices = enumChoices(items['enum'], items['anyOf']);
        return {
          key,
          text: `${text} (one or more: separate them with commas)`,
          ...(choices.length ? { options: choices.map((c) => c.title) } : {}),
          parse: (a) =>
            a
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
              .map((s) => matchChoice(choices, s)),
        };
      }
      default: {
        const choices = enumChoices(p['enum'], p['oneOf']);
        return {
          key,
          text,
          ...(choices.length ? { options: choices.map((c) => c.title) } : {}),
          parse: (a) => matchChoice(choices, a.trim()),
        };
      }
    }
  });
}

interface Choice {
  value: string;
  title: string;
}

function enumChoices(plain: unknown, titled: unknown): Choice[] {
  if (Array.isArray(plain)) {
    return plain.filter((v): v is string => typeof v === 'string').map((v) => ({ value: v, title: v }));
  }
  if (Array.isArray(titled)) {
    return titled
      .map(asRecord)
      .filter((o) => typeof o['const'] === 'string')
      .map((o) => ({ value: o['const'] as string, title: str(o['title']) ?? (o['const'] as string) }));
  }
  return [];
}

/** An answer matched to a choice by title or value (any case); free text when nothing matches. */
function matchChoice(choices: Choice[], answer: string): string {
  const a = answer.toLowerCase();
  return choices.find((c) => c.title.toLowerCase() === a || c.value.toLowerCase() === a)?.value ?? answer;
}
