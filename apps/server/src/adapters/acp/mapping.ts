import type { Cost, ToolCall } from '@galactic/protocol';
import type {
  ContentBlock,
  ElicitationPropertySchema,
  PermissionOption,
  PermissionOptionKind,
  Plan,
  SessionConfigOption,
  SessionModeState,
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
      return argv
        .map((p) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`))
        .join(' ');
    }
  }
  return undefined;
}

const PATH_KEYS = ['file_path', 'path', 'filePath', 'absolute_path', 'notebook_path', 'file'];
/** Raw-input fields that carry several paths. */
const PATHS_KEYS = ['paths', 'file_paths', 'files'];
/** Raw-input fields that carry the directory a command runs in. */
const CWD_KEYS = ['cwd', 'workdir', 'working_directory', 'workingDirectory', 'dir'];
/** Raw-input fields only a content search (grep) has. */
const GREP_KEYS = ['output_mode', 'glob', '-i', '-n', '-A', '-B', '-C', 'multiline', 'type'];

/** A word quoted for the shell: always in single quotes, as in `rm -r -- '<path>'`. */
const shellQuote = (p: string): string => `'${p.replace(/'/g, `'\\''`)}'`;

/** Every distinct path a call names: its path fields, a list of paths, its locations. */
function pathsOf(raw: Record<string, unknown>, locations: string[]): string[] {
  const out: string[] = [];
  for (const k of PATH_KEYS) {
    const v = str(raw[k]);
    if (v !== undefined) out.push(v);
  }
  for (const k of PATHS_KEYS) {
    const v = raw[k];
    if (Array.isArray(v)) for (const p of v) if (str(p) !== undefined) out.push(p as string);
  }
  out.push(...locations);
  return [...new Set(out)];
}

/** The engine's path fields for a call on `paths`: the first under `key`, all as `paths`. */
function onPaths(paths: string[], key = 'file_path'): Record<string, unknown> {
  return { [key]: paths[0], ...(paths.length > 1 ? { paths } : {}) };
}

/**
 * The gate's view of an ACP tool call. The permission engine speaks Claude Code's tool names
 * (`Read`, `Edit`, `Bash`, `WebFetch` …: `domain/permissions.ts`), so an ACP call is translated by
 * its `kind` and its raw input into the call it is equivalent to — an `execute` with a command is
 * `Bash {command}` (run from its `cwd` when it names one: `cd '<dir>' && …`), an `edit` on a path
 * is `Edit {file_path}`, a `delete` is the `rm -r -- '<path>'` it amounts to (judged as the shell
 * command is: destructive, and outside the workspace when it is), a `search` is `Glob` (a
 * file-name pattern, whose location the engine checks) unless it is plainly a content search
 * (`Grep`) — and anything that cannot be placed keeps a name the engine does not know, so the
 * table's `unclassified` entry decides it (`ask` unless the project is trusted; a push mentioned
 * anywhere in it still asks): a call is never made to look safer than it is. Every distinct path
 * a call names (its path fields, a `paths` list, all its locations) is judged, the strictest
 * winning. The original ACP fields travel along in the input (`acp: {kind, title}`) for the
 * permission card.
 */
export function gateCall(tool: ToolState): ToolCall {
  const raw = asRecord(tool.rawInput);
  const kind = tool.kind ?? 'other';
  const locations = (tool.locations ?? []).map((l) => l.path).filter((p) => p.length > 0);
  const paths = pathsOf(raw, locations);
  const title = tool.title ?? tool.name ?? undefined;
  const acp = { kind, ...(title ? { title } : {}) };
  const unclassified = (): ToolCall => ({
    toolName: `acp:${tool.name ?? kind}`,
    input: { ...raw, ...(locations.length ? { locations } : {}), acp },
  });
  switch (kind) {
    case 'execute': {
      const command = commandOf(raw);
      if (!command) return unclassified();
      const dir = pick(raw, CWD_KEYS);
      return {
        toolName: 'Bash',
        input: { command: dir ? `cd ${shellQuote(dir)} && ${command}` : command, acp },
      };
    }
    case 'read':
      return paths.length
        ? { toolName: 'Read', input: { ...onPaths(paths), acp } }
        : unclassified();
    case 'search': {
      const pattern = pick(raw, ['pattern']);
      const query = pick(raw, ['query', 'regex']);
      const glob = pick(raw, ['glob', 'include', 'file_pattern']);
      const where = paths.length ? onPaths(paths, 'path') : {};
      const grep =
        GREP_KEYS.some((k) => k in raw) ||
        /\b(grep|rg|ripgrep)\b/i.test(`${tool.name ?? ''} ${title ?? ''}`) ||
        (pattern === undefined && query !== undefined);
      if (grep) {
        const regex = pattern ?? query;
        return {
          toolName: 'Grep',
          input: {
            ...(regex !== undefined ? { pattern: regex } : {}),
            ...(glob !== undefined ? { glob } : {}),
            ...where,
            acp,
          },
        };
      }
      // A file-name search: its pattern is a location the engine checks.
      return {
        toolName: 'Glob',
        input: { ...(pattern !== undefined ? { pattern } : {}), ...where, acp },
      };
    }
    case 'edit':
      // Inside the workspace the table's `edit_workspace`, outside it `outside_workspace`.
      return paths.length
        ? { toolName: 'Edit', input: { ...onPaths(paths), acp } }
        : unclassified();
    case 'delete':
      // What a delete amounts to: the shell's `rm -r` on every path it names.
      return paths.length
        ? {
            toolName: 'Bash',
            input: { command: `rm -r -- ${paths.map(shellQuote).join(' ')}`, acp },
          }
        : unclassified();
    case 'move': {
      const from = pick(raw, ['from', 'source', 'src', 'old_path', ...PATH_KEYS]) ?? locations[0];
      const to = pick(raw, ['to', 'destination', 'dest', 'new_path']) ?? locations[1];
      if (!from || !to) return unclassified();
      // Both ends are checked (the engine reads every path field of an edit), and any other path.
      const all = [...new Set([from, to, ...paths])];
      return {
        toolName: 'Edit',
        input: { file_path: from, path: to, ...(all.length > 2 ? { paths: all } : {}), acp },
      };
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
    parts.push(
      typeof tool.rawOutput === 'string' ? tool.rawOutput : JSON.stringify(tool.rawOutput),
    );
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
      Math.round(
        usage.inputTokens + (usage.cachedReadTokens ?? 0) + (usage.cachedWriteTokens ?? 0),
      ),
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
    return plain
      .filter((v): v is string => typeof v === 'string')
      .map((v) => ({ value: v, title: v }));
  }
  if (Array.isArray(titled)) {
    return titled
      .map(asRecord)
      .filter((o) => typeof o['const'] === 'string')
      .map((o) => ({
        value: o['const'] as string,
        title: str(o['title']) ?? (o['const'] as string),
      }));
  }
  return [];
}

/** An answer matched to a choice by title or value (any case); free text when nothing matches. */
function matchChoice(choices: Choice[], answer: string): string {
  const a = answer.toLowerCase();
  return (
    choices.find((c) => c.title.toLowerCase() === a || c.value.toLowerCase() === a)?.value ?? answer
  );
}

// --- session modes ---------------------------------------------------------------

/**
 * Modes known to let an ACP agent run tool calls without asking its client (decision 108):
 * Claude's `bypassPermissions`, `dontAsk` and `acceptEdits`, Gemini's `yolo` and `autoEdit`,
 * Codex's `full-access` and `auto`, and the auto/accept-all variants. Matched against a mode's id
 * and its name, case-insensitively, ignoring everything but letters and digits.
 */
export const PERMISSIVE_MODES: readonly string[] = [
  'bypassPermissions',
  'dontAsk',
  'acceptEdits',
  'yolo',
  'autoEdit',
  'full-access',
  'auto',
  'auto-approve',
  'auto-accept',
  'accept-all',
  'allow-all',
  'never-ask',
];
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const PERMISSIVE = new Set(PERMISSIVE_MODES.map(norm));

export interface ModeOption {
  id: string;
  name: string;
}

/** An agent's session modes: ACP's `modes`, or a `configOptions` select of category `mode`. */
export interface ModeState {
  current: string;
  available: ModeOption[];
  /** How the mode is set: `session/set_mode`, or `session/set_config_option` on `configId`. */
  via: { kind: 'mode' } | { kind: 'config'; configId: string };
}

/** The modes a `session/new` / `session/load` response (or a config update) carries, if any. */
export function modeState(response: {
  modes?: SessionModeState | null;
  configOptions?: SessionConfigOption[] | null;
}): ModeState | undefined {
  const modes = response.modes;
  if (modes && typeof modes.currentModeId === 'string') {
    return {
      current: modes.currentModeId,
      available: (modes.availableModes ?? []).map((m) => ({ id: m.id, name: m.name })),
      via: { kind: 'mode' },
    };
  }
  for (const option of response.configOptions ?? []) {
    if (option.category !== 'mode' || option.type !== 'select') continue;
    if (typeof option.currentValue !== 'string') continue;
    const available: ModeOption[] = [];
    for (const entry of option.options) {
      if ('group' in entry) {
        for (const o of entry.options) available.push({ id: o.value, name: o.name });
      } else available.push({ id: entry.value, name: entry.name });
    }
    return {
      current: option.currentValue,
      available,
      via: { kind: 'config', configId: option.id },
    };
  }
  return undefined;
}

/** A mode by id or name (any case), as the config names it. */
export function findMode(state: ModeState, wanted: string): ModeOption | undefined {
  return (
    state.available.find((m) => m.id === wanted) ??
    state.available.find((m) => norm(m.id) === norm(wanted) || norm(m.name) === norm(wanted))
  );
}

/** The mode's display name (its id when the agent did not list it). */
export function modeName(state: ModeState | undefined, id: string): string {
  return state?.available.find((m) => m.id === id)?.name ?? id;
}

/** Whether a mode is one of the known permissive ones (by its id or its name). */
export function isPermissiveMode(state: ModeState | undefined, id: string): boolean {
  const name = state?.available.find((m) => m.id === id)?.name;
  return PERMISSIVE.has(norm(id)) || (name !== undefined && PERMISSIVE.has(norm(name)));
}
