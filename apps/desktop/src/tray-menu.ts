import type { Agent, Question, ToolCall, WorldState } from '@galactic/protocol';

/**
 * The menu bar's question sections (P9-15; docs/DESKTOP.md §2): the permission requests waiting
 * for the user, answered from the menu with "Allow once" / "Deny", and the clarification questions
 * waiting for the user, listed with "Open" only (an answer needs typing).
 *
 * Built here from the folded world and sent to Rust as a `menu` line; Rust renders it as is (it
 * escapes `&` and strips control characters again, `src-tauri/src/tray_menu.rs`). Every title is
 * agent-provided text made safe for a menu: redacted (the server already redacts a logged tool
 * call; this is a second, menu-local pass), one line, control and bidirectional-override
 * characters removed, and capped with an ellipsis — never the full raw input.
 */

/** How many requests (and, separately, questions) the menu lists; the rest are "N more". */
export const MENU_MAX_SHOWN = 10;
/** A menu title's length, in characters. */
export const MENU_TITLE_MAX = 80;
const AGENT_LABEL_MAX = 32;

export interface TrayPermissionItem {
  /** The question's id. */
  id: string;
  /** The question's version the menu shows: the answer carries it (409 `stale` if it changed). */
  version: number;
  /** "<agent>: <tool> <summary>", made safe. */
  title: string;
  /** An answer from the menu is on its way: the item says so and offers no second answer. */
  sending?: boolean;
}

export interface TrayQuestionItem {
  id: string;
  /** "<agent>: <question text>", made safe. */
  title: string;
}

export interface TrayMenu {
  /** The first `MENU_MAX_SHOWN` waiting permission requests, oldest first. */
  permissions: TrayPermissionItem[];
  /** How many permission requests wait for the user in all. */
  permissionCount: number;
  /** The first `MENU_MAX_SHOWN` clarification questions the user holds, oldest first. */
  questions: TrayQuestionItem[];
  questionCount: number;
}

export const emptyTrayMenu = (): TrayMenu => ({
  permissions: [],
  permissionCount: 0,
  questions: [],
  questionCount: 0,
});

// --- making agent text safe for a menu title -----------------------------------------------------

/**
 * Control characters (C0, DEL, C1) and format characters — bidirectional overrides and isolates
 * (U+202A–202E, U+2066–2069), marks (U+200E/F, U+061C), zero-width characters, the BOM — which
 * could make a title read differently from what it is. Line and paragraph separators too.
 */
const UNSAFE = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

/** One line, no control or bidi characters, at most `max` characters (an ellipsis when cut). */
export function cleanMenuText(text: string, max = MENU_TITLE_MAX): string {
  const line = text
    .replace(/[\r\n\t\v\f\u2028\u2029]+/g, ' ')
    .replace(UNSAFE, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...line];
  if (chars.length <= max) return line;
  return `${chars
    .slice(0, Math.max(1, max - 1))
    .join('')
    .trimEnd()}…`;
}

const MASK = '[redacted]';

/**
 * Secret shapes hidden from a menu title (a second pass over what the server already redacted:
 * `runtime/redact.ts`). Shape-based and conservative: a hidden harmless string costs little.
 */
const SECRET_RULES: [RegExp, string][] = [
  // A private-key block's header (anything after it is cut by the length cap anyway).
  [/-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*/g, MASK],
  // Credentials in a URL: scheme://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${MASK}@`],
  // Authorization headers.
  [/\b(authorization\s*:\s*(?:bearer|basic|token)\s+)\S+/gi, `$1${MASK}`],
  [/\b(bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, `$1${MASK}`],
  // name=value / name: value / --name value where the name says it is a secret.
  [
    /((?:--?)?[\w.-]*(?:password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth)[\w.-]*)(\s*[=:]\s*|\s+(?=[^-\s]))("[^"]*"|'[^']*'|[^\s"']+)/gi,
    `$1$2${MASK}`,
  ],
  // Well-known token prefixes.
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g, MASK],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, MASK],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\bAKIA[0-9A-Z]{16}\b/g, MASK],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, MASK],
  // JSON Web Tokens.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK],
  // Long opaque strings (hex, base64url): keys more often than words. Paths keep their slashes.
  [/[A-Za-z0-9+_-]{40,}={0,2}/g, MASK],
];

export function redactForMenu(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_RULES) out = out.replace(pattern, replacement);
  return out;
}

/** The input keys that say what a tool call does, most telling first. */
const SUMMARY_KEYS = [
  'command',
  'cmd',
  'file_path',
  'filePath',
  'notebook_path',
  'path',
  'url',
  'pattern',
  'query',
] as const;

/** A short reading of a tool call's input: the command, the path or URL, else the input's JSON. */
export function inputSummary(input: unknown): string {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return input;
  if (typeof input !== 'object') return String(input);
  const record = input as Record<string, unknown>;
  for (const key of SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
    if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value.join(' ');
  }
  try {
    return JSON.stringify(input) ?? '';
  } catch {
    return '';
  }
}

const short = (text: string, n: number) => cleanMenuText(text, n);

/** "Harmonizer", "Waykeeper · CSV tool", "Steward · write the parser" (the page's `agentLabel`). */
export function agentLabel(
  agent: Agent | undefined,
  world: Pick<WorldState, 'projects' | 'tasks'>,
): string {
  if (!agent) return 'An agent';
  switch (agent.role) {
    case 'harmonizer':
      return 'Harmonizer';
    case 'waykeeper': {
      const project = agent.projectId ? world.projects[agent.projectId] : undefined;
      return short(`Waykeeper · ${project?.name ?? agent.projectId ?? agent.id}`, AGENT_LABEL_MAX);
    }
    case 'steward': {
      const task = agent.taskId ? world.tasks[agent.taskId] : undefined;
      return short(`Steward · ${task?.description ?? agent.taskId ?? agent.id}`, AGENT_LABEL_MAX);
    }
    default:
      return 'An agent';
  }
}

/** "<tool> <summary>" for a permission request, or its text when it carries no tool call. */
function requestText(q: Question): string {
  const call: ToolCall | undefined = q.context.toolCall;
  if (!call) {
    const action = q.context.permissionAction?.replace(/_/g, ' ');
    return action ? `${action}: ${q.context.text}` : q.context.text;
  }
  const summary = inputSummary(call.input);
  return summary ? `${call.toolName} ${summary}` : call.toolName;
}

/** A menu title: "<agent>: <text>", redacted, one line, capped. */
function titleOf(q: Question, world: WorldState, text: string): string {
  const agent = agentLabel(world.agents[q.originAgentId], world);
  // Redact before cleaning and cutting, so a cut never leaves half a secret in view.
  return cleanMenuText(`${agent}: ${redactForMenu(cleanMenuText(text, 4000))}`);
}

const waitingForUser = (q: Question) => q.status === 'open' && q.holder.type === 'user';
const oldestFirst = (a: Question, b: Question) =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/**
 * The menu's sections from the folded world. `sending`: the ids of the requests answered from the
 * menu whose answer has not come back yet.
 */
export function trayMenu(
  world: WorldState,
  opts: { sending?: ReadonlySet<string>; max?: number } = {},
): TrayMenu {
  const max = opts.max ?? MENU_MAX_SHOWN;
  const open = Object.values(world.questions).filter(waitingForUser).sort(oldestFirst);
  const permissions = open.filter((q) => q.kind === 'permission');
  const questions = open.filter((q) => q.kind !== 'permission');
  return {
    permissions: permissions.slice(0, max).map((q) => ({
      id: q.id,
      version: q.version,
      title: titleOf(q, world, requestText(q)),
      ...(opts.sending?.has(q.id) ? { sending: true } : {}),
    })),
    permissionCount: permissions.length,
    questions: questions.slice(0, max).map((q) => ({
      id: q.id,
      title: titleOf(q, world, q.context.text),
    })),
    questionCount: questions.length,
  };
}
