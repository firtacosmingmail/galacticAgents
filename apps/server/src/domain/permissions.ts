import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  DEFAULT_PERMISSION_POLICY,
  type PermissionAction,
  type PermissionDecision,
  type PermissionPolicy,
  type ToolCall,
} from '@galactic/protocol';

/**
 * The permission policy engine (SPEC §3.6, decision 7; P1-10).
 *
 * Pure functions, no I/O: a tool call an agent wants to make is classified into the action
 * categories of `PermissionAction`, and the project's policy (merged over the global default)
 * turns those into one decision. The strictest category wins (`deny` > `ask` > `allow`), so a
 * command that both installs a package and deletes files asks as long as either category asks.
 *
 * Anything the engine cannot classify — an unknown tool, a path it cannot resolve — is `ask`:
 * the conservative behaviour the working agreements call for. An LLM never takes part in this.
 */

export interface PolicyContext {
  /** The project's workspace root; everything under it is "inside" (SPEC §3.5). */
  workspace: string;
  /** Where relative paths resolve from: the agent's cwd (its worktree). Defaults to `workspace`. */
  cwd?: string;
  /** `~` expands to this; defaults to the real home directory. */
  home?: string;
}

export interface Classification {
  actions: PermissionAction[];
  /** One human-readable line per finding, for the permission card. */
  reasons: string[];
  /** Set for tools that only touch the agent's own bookkeeping: allowed whatever the policy. */
  alwaysAllow?: true;
}

export interface PolicyVerdict extends Classification {
  decision: PermissionDecision;
  /** The category that produced `decision` (the strictest one); absent when nothing was recognised. */
  dominant?: PermissionAction;
}

// ---------------------------------------------------------------------------
// Policy merge and decision
// ---------------------------------------------------------------------------

/** The per-project policy over the global default: missing actions fall back to the default. */
export function resolvePolicy(override?: PermissionPolicy | null): PermissionPolicy {
  return { rules: { ...DEFAULT_PERMISSION_POLICY.rules, ...(override?.rules ?? {}) } };
}

const STRICTNESS: Record<PermissionDecision, number> = { allow: 0, ask: 1, deny: 2 };

/**
 * A policy value as a decision: anything that is not `allow`/`ask`/`deny` (a value restored from
 * an older or corrupted row, a typo) counts as `ask` — the engine fails closed.
 */
function asDecision(value: unknown): PermissionDecision {
  return value === 'allow' || value === 'ask' || value === 'deny' ? value : 'ask';
}

/** The strictest of `decisions` (`deny` > `ask` > `allow`); an unknown value counts as `ask`. */
export function strictest(decisions: readonly unknown[]): PermissionDecision {
  let result: PermissionDecision = 'allow';
  for (const raw of decisions) {
    const d = asDecision(raw);
    if (STRICTNESS[d] > STRICTNESS[result]) result = d;
  }
  return result;
}

/** The decision a policy gives one action; a missing or unknown value is `ask`. */
function ruleFor(policy: PermissionPolicy, action: PermissionAction): PermissionDecision {
  return asDecision(policy.rules[action]);
}

/**
 * The decision for a set of action categories under a policy. An empty set (nothing recognised)
 * is `ask`, never `allow`.
 */
export function decide(policy: PermissionPolicy, actions: PermissionAction[]): PermissionDecision {
  if (actions.length === 0) return 'ask';
  const merged = resolvePolicy(policy);
  return strictest(actions.map((a) => ruleFor(merged, a)));
}

/** Classifies the call and decides it under `policy` in one go. */
export function evaluate(
  policy: PermissionPolicy,
  call: ToolCall,
  ctx: PolicyContext,
): PolicyVerdict {
  const classification = classifyToolCall(call, ctx);
  if (classification.alwaysAllow) return { ...classification, decision: 'allow' };
  const decision = decide(policy, classification.actions);
  const merged = resolvePolicy(policy);
  const dominant = classification.actions.find((a) => ruleFor(merged, a) === decision);
  return { ...classification, decision, ...(dominant ? { dominant } : {}) };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Tools that only read the file system; their `path`-like inputs decide inside vs. outside. */
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);
/** Tools that write files. */
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
/** Tools that reach the network by definition. */
const NETWORK_TOOLS = new Set(['WebFetch', 'WebSearch']);
/** Tools with no effect outside the agent's own bookkeeping. */
const HARMLESS_TOOLS = new Set([
  'TodoWrite',
  'TodoRead',
  'Task',
  'Agent',
  'Skill',
  'EnterPlanMode',
  'ExitPlanMode',
  'BashOutput',
  'KillShell',
  'KillBash',
  'TaskOutput',
  'ToolSearch',
]);
/** Input fields that carry a path, in the order the Claude Code tools use them. */
const PATH_FIELDS = ['file_path', 'notebook_path', 'path', 'directory', 'cwd'];
/**
 * Fields that carry a glob, per tool (resolved from the tool's `path`, else the cwd). Grep's
 * `pattern` is a regular expression, not a location.
 */
const GLOB_FIELDS: Record<string, string[]> = {
  Glob: ['pattern'],
  Grep: ['glob'],
};
const DEFAULT_GLOB_FIELDS = ['pattern', 'glob'];

export function classifyToolCall(call: ToolCall, ctx: PolicyContext): Classification {
  const input = isRecord(call.input) ? call.input : {};
  const name = call.toolName;

  if (HARMLESS_TOOLS.has(name)) return { actions: [], reasons: [], alwaysAllow: true };
  if (NETWORK_TOOLS.has(name)) {
    return { actions: ['network'], reasons: [`${name} reaches the network`] };
  }
  if (READ_TOOLS.has(name)) return classifyPaths(name, input, 'read_workspace', ctx);
  if (EDIT_TOOLS.has(name)) return classifyPaths(name, input, 'edit_workspace', ctx);
  if (name === 'Bash') {
    const command = typeof input['command'] === 'string' ? input['command'] : '';
    return classifyCommand(command, ctx);
  }
  return { actions: [], reasons: [`unknown tool ${name}`] };
}

function classifyPaths(
  tool: string,
  input: Record<string, unknown>,
  inside: PermissionAction,
  ctx: PolicyContext,
): Classification {
  const paths = PATH_FIELDS.map((f) => input[f]).filter((v): v is string => typeof v === 'string');
  const edit = inside === 'edit_workspace';
  // An edit tool that names no file cannot be placed: ask.
  if (edit && paths.length === 0) return { actions: [], reasons: [`${tool} names no file path`] };

  const reasons: string[] = [];
  for (const p of paths) {
    if (!isInsideWorkspace(p, ctx)) reasons.push(`${tool} on ${p}: outside the workspace`);
    else if (edit && isAgentConfigPath(p, ctx)) {
      reasons.push(`${tool} on ${p}: agent or git configuration, which runs outside the gate`);
    }
  }
  const base = typeof input['path'] === 'string' ? input['path'] : undefined;
  const from = base !== undefined ? resolvePath(base, ctx, cwdOf(ctx)) : cwdOf(ctx);
  for (const f of GLOB_FIELDS[tool] ?? DEFAULT_GLOB_FIELDS) {
    const g = input[f];
    if (typeof g !== 'string') continue;
    const locations = globLocations(g);
    if (locations === null) {
      reasons.push(`${tool} on ${g}: cannot tell where the pattern points`);
      continue;
    }
    if (locations.some((l) => !isInsideWorkspace(l, { ...ctx, cwd: from }))) {
      reasons.push(`${tool} on ${g}: outside the workspace`);
    }
  }
  if (reasons.length === 0) return { actions: [inside], reasons: [] };
  return { actions: ['outside_workspace'], reasons };
}

function looksLikeLocation(p: string): boolean {
  return (
    p.startsWith('/') ||
    p.startsWith('~') ||
    p === '..' ||
    p.startsWith('../') ||
    p.includes('/../') ||
    p.endsWith('/..')
  );
}

// --- globs and brace expansion ----------------------------------------------

const MAX_BRACE_ALTERNATIVES = 64;

/**
 * Shell/glob brace expansion (`{a,b}` → `a`, `b`, nested too). A brace group without a top-level
 * comma (`${HOME}`, `{1..3}`) stays literal. `null` when the expansion is unbalanced inside a
 * group or would produce more than a handful of alternatives.
 */
export function expandBraces(s: string): string[] | null {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let depth = 0;
    const commas: number[] = [];
    let end = -1;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      } else if (c === ',' && depth === 1) commas.push(j);
    }
    if (end < 0) return commas.length > 0 ? null : [s];
    if (commas.length === 0) continue; // literal braces; look further on
    const prefix = s.slice(0, i);
    const suffix = s.slice(end + 1);
    const bounds = [i, ...commas, end];
    const out: string[] = [];
    for (let k = 0; k < bounds.length - 1; k++) {
      const alt = s.slice(bounds[k]! + 1, bounds[k + 1]);
      const expanded = expandBraces(prefix + alt + suffix);
      if (expanded === null) return null;
      out.push(...expanded);
      if (out.length > MAX_BRACE_ALTERNATIVES) return null;
    }
    return out;
  }
  return [s];
}

const GLOB_META = /[*?[]/;

/**
 * The locations a glob pattern can reach, as paths `isInsideWorkspace` can judge: braces are
 * expanded; a glob segment that starts with `..` and can match `..` (`..*`) counts as `..`; `**`
 * counts as no segment (it may match none); any other glob segment matches one child. `null`
 * when the braces cannot be expanded.
 */
export function globLocations(pattern: string): string[] | null {
  const alternatives = expandBraces(pattern);
  if (alternatives === null) return null;
  return alternatives.map((alt) => {
    const absolute = alt.startsWith('/');
    const segments = alt.split('/').flatMap((seg) => {
      if (!GLOB_META.test(seg)) return [seg];
      if (seg === '**') return [];
      if (seg.startsWith('..') && globSegmentMatches(seg, '..')) return ['..'];
      return ['_'];
    });
    const joined = segments.join('/');
    return absolute && !joined.startsWith('/') ? `/${joined}` : joined || '.';
  });
}

function globSegmentMatches(seg: string, name: string): boolean {
  let rx = '';
  for (let k = 0; k < seg.length; k++) {
    const c = seg[k]!;
    if (c === '*') rx += '.*';
    else if (c === '?') rx += '.';
    else if (c === '[') {
      const close = seg.indexOf(']', k + 2);
      if (close < 0) rx += '\\[';
      else {
        rx += '.'; // any class may match the character: conservative
        k = close;
      }
    } else rx += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${rx}$`).test(name);
}

// --- shell lexing -----------------------------------------------------------

/** A redirection of one simple command. */
export interface Redirect {
  /** The operator without its fd: `>`, `>>`, `>|`, `<`, `<>`, `>&`, `<&`, `&>`, `&>>`, `<<`, `<<-`, `<<<`. */
  op: string;
  /** The dequoted word after it: a file, an fd (`>&2`), a heredoc delimiter or a here-string. */
  target: string;
}

/** One simple command of a shell line, its words dequoted the way the shell would. */
export interface SimpleCommand {
  words: string[];
  redirects: Redirect[];
  /** Its stdin is the previous command of a pipeline (`a | b`). */
  piped: boolean;
  /** It reads a heredoc or a here-string. */
  heredoc: boolean;
}

export interface LexedLine {
  /** Every simple command, including those inside `$(…)`, backticks and `<(…)`. */
  commands: SimpleCommand[];
  /** Why the line cannot be read safely; non-empty means the line is opaque. */
  opaque: string[];
}

/** What a word holds where a command substitution was; it reads as an unexpandable variable. */
const SUBSTITUTION = '$()';
const MAX_NESTING = 16;
const REDIRECT_OPS = ['<<<', '<<-', '<<', '<>', '<&', '<', '>>', '>&', '>|', '>'];

/**
 * A small lexer for the subset of POSIX/bash syntax the engine needs: quotes and backslashes
 * are removed as the shell removes them (so `r""m`, `r'm'` and `r\m` all read `rm`), commands
 * are split on `;`, `&`, `&&`, `|`, `||`, newlines and subshell/group delimiters, redirections
 * are recognised glued (`x>/f`) or fd-prefixed (`2>/f`), command substitutions are lexed as
 * commands of their own, heredoc bodies are skipped as data. Anything it cannot read the way
 * the shell would — `$'…'` quoting, an unterminated quote — marks the line opaque.
 */
class ShellLexer {
  readonly commands: SimpleCommand[] = [];
  readonly opaque: string[] = [];
  private heredocs: { delim: string; strip: boolean; expand: boolean }[] = [];

  constructor(
    private readonly src: string,
    private readonly nesting = 0,
  ) {}

  /** Lexes from `start` until the end, or until the `)` closing a `$(` when `nested`. */
  run(start: number, nested: boolean): number {
    const src = this.src;
    if (this.nesting > MAX_NESTING) {
      this.opaque.push('command substitutions nested too deep');
      return src.length;
    }
    let cmd = newCommand(false);
    let word: string | null = null;
    let quoted = false;
    let pendingOp: string | null = null;
    let depth = 0;
    let i = start;

    const append = (text: string) => {
      word = (word ?? '') + text;
    };
    const flushWord = () => {
      if (word === null) return;
      if (pendingOp !== null) {
        cmd.redirects.push({ op: pendingOp, target: word });
        if (pendingOp === '<<' || pendingOp === '<<-') {
          this.heredocs.push({ delim: word, strip: pendingOp === '<<-', expand: !quoted });
          cmd.heredoc = true;
        } else if (pendingOp === '<<<') cmd.heredoc = true;
        pendingOp = null;
      } else cmd.words.push(word);
      word = null;
      quoted = false;
    };
    const flushCommand = (nextPiped: boolean) => {
      flushWord();
      if (pendingOp !== null) {
        this.opaque.push(`redirection ${pendingOp} without a target`);
        pendingOp = null;
      }
      if (cmd.words.length > 0 || cmd.redirects.length > 0) this.commands.push(cmd);
      cmd = newCommand(nextPiped);
    };
    const substitute = (from: number): number => {
      const child = new ShellLexer(src, this.nesting + 1);
      child.heredocs = this.heredocs;
      const end = child.run(from, true);
      this.commands.push(...child.commands);
      this.opaque.push(...child.opaque);
      return end;
    };

    while (i < src.length) {
      const c = src[i]!;
      const next = src[i + 1];
      if (c === ' ' || c === '\t' || c === '\r') {
        flushWord();
        i++;
      } else if (c === '\n') {
        flushCommand(false);
        i = this.skipHeredocBodies(i + 1);
      } else if (c === '\\') {
        if (next === '\n') {
          i += 2;
          continue;
        }
        append(next ?? '');
        quoted = true;
        i += 2;
      } else if (c === "'") {
        const end = src.indexOf("'", i + 1);
        if (end < 0) return this.fail('unterminated single quote');
        append(src.slice(i + 1, end));
        quoted = true;
        i = end + 1;
      } else if (c === '"') {
        const r = this.doubleQuoted(i + 1, substitute);
        if (r === null) return this.fail('unterminated double quote');
        append(r.text);
        quoted = true;
        i = r.end;
      } else if (c === '$') {
        if (next === "'" || next === '"')
          return this.fail(`${next === "'" ? "$'…'" : '$"…"'} quoting`);
        if (next === '(') {
          i = substitute(i + 2);
          append(SUBSTITUTION);
        } else if (next === '{') {
          const end = src.indexOf('}', i + 2);
          if (end < 0) return this.fail('unterminated ${');
          const body = src.slice(i, end + 1);
          if (/`|\$\(/.test(body)) return this.fail('command substitution inside ${…}');
          append(body);
          i = end + 1;
        } else {
          append('$');
          i++;
        }
      } else if (c === '`') {
        const end = this.backtick(i + 1);
        if (end < 0) return this.fail('unterminated backtick');
        append(SUBSTITUTION);
        i = end;
      } else if (c === '#' && word === null) {
        const nl = src.indexOf('\n', i);
        i = nl < 0 ? src.length : nl;
      } else if ((c === '<' || c === '>') && next === '(') {
        i = substitute(i + 2); // process substitution
        append(SUBSTITUTION);
      } else if (c === '<' || c === '>') {
        if (word !== null && !quoted && /^\d+$/.test(word))
          word = null; // the fd: `2>`
        else flushWord();
        const op = REDIRECT_OPS.find((o) => src.startsWith(o, i))!;
        pendingOp = op;
        i += op.length;
      } else if (c === '&') {
        if (next === '>') {
          flushWord();
          pendingOp = src[i + 2] === '>' ? '&>>' : '&>';
          i += pendingOp.length;
        } else {
          flushCommand(false);
          i += next === '&' ? 2 : 1;
        }
      } else if (c === '|') {
        if (next === '|') {
          flushCommand(false);
          i += 2;
        } else {
          flushCommand(true);
          i += next === '&' ? 2 : 1;
        }
      } else if (c === ';') {
        flushCommand(false);
        i++;
      } else if (c === '(') {
        flushCommand(false);
        depth++;
        i++;
      } else if (c === ')') {
        flushCommand(false);
        i++;
        if (depth === 0 && nested) return i;
        if (depth > 0) depth--;
      } else if ((c === '{' || c === '}') && word === null && isWordEnd(next)) {
        flushCommand(false);
        i++;
      } else {
        append(c);
        i++;
      }
    }
    flushCommand(false);
    if (nested) this.opaque.push('unterminated $(');
    return i;
  }

  private fail(reason: string): number {
    this.opaque.push(reason);
    return this.src.length;
  }

  private doubleQuoted(
    start: number,
    substitute: (from: number) => number,
  ): { text: string; end: number } | null {
    const src = this.src;
    let text = '';
    let i = start;
    while (i < src.length) {
      const c = src[i]!;
      if (c === '"') return { text, end: i + 1 };
      if (c === '\\') {
        const n = src[i + 1];
        if (n === undefined) return null;
        if (n !== '\n') text += '$`"\\'.includes(n) ? n : `\\${n}`;
        i += 2;
      } else if (c === '$' && src[i + 1] === '(') {
        i = substitute(i + 2);
        text += SUBSTITUTION;
      } else if (c === '`') {
        const end = this.backtick(i + 1);
        if (end < 0) return null;
        text += SUBSTITUTION;
        i = end;
      } else {
        text += c;
        i++;
      }
    }
    return null;
  }

  /** Lexes a backtick substitution starting after the opening backtick; the index after it, or -1. */
  private backtick(start: number): number {
    const src = this.src;
    let j = start;
    while (j < src.length && src[j] !== '`') j += src[j] === '\\' ? 2 : 1;
    if (j >= src.length) return -1;
    const inner = src.slice(start, j).replace(/\\([`$\\])/g, '$1');
    const child = new ShellLexer(inner, this.nesting + 1);
    child.run(0, false);
    this.commands.push(...child.commands);
    this.opaque.push(...child.opaque);
    return j + 1;
  }

  /** Skips the bodies of the heredocs opened on the line that just ended. */
  private skipHeredocBodies(start: number): number {
    const src = this.src;
    let i = start;
    for (const h of this.heredocs.splice(0)) {
      let body = '';
      while (i < src.length) {
        const nl = src.indexOf('\n', i);
        const lineEnd = nl < 0 ? src.length : nl;
        const line = src.slice(i, lineEnd);
        i = nl < 0 ? src.length : nl + 1;
        if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
        body += `${line}\n`;
      }
      // An unquoted delimiter expands the body: a substitution there would run.
      if (h.expand && /`|\$\(/.test(body)) this.opaque.push('heredoc body runs a substitution');
    }
    return i;
  }
}

function newCommand(piped: boolean): SimpleCommand {
  return { words: [], redirects: [], piped, heredoc: false };
}

function isWordEnd(c: string | undefined): boolean {
  return (
    c === undefined || c === ' ' || c === '\t' || c === '\n' || c === ';' || c === '&' || c === '|'
  );
}

/** Lexes a shell line into simple commands (see `ShellLexer`). */
export function lexCommand(command: string): LexedLine {
  const lexer = new ShellLexer(command);
  lexer.run(0, false);
  return { commands: lexer.commands, opaque: lexer.opaque };
}

/** The simple commands of a shell line, each as its dequoted words joined by spaces. */
export function splitCommand(command: string): string[] {
  return lexCommand(command)
    .commands.map((c) => c.words.join(' '))
    .filter(Boolean);
}

/**
 * Wrappers that run the next word as the command (`sudo rm`, `env X=1 rm`, `timeout 30 rm`);
 * skipped, with their options, to find the command's real name.
 */
const WRAPPERS = new Set([
  'sudo',
  'doas',
  'env',
  'nohup',
  'time',
  'nice',
  'ionice',
  'timeout',
  'command',
  'builtin',
  'exec',
  'xargs',
  'stdbuf',
  'caffeinate',
]);
/** Options of the wrappers above that take a separate value. */
const WRAPPER_VALUE_OPTS: Record<string, RegExp> = {
  sudo: /^-[ugCDhpRrT]$/,
  nice: /^-n$/,
  ionice: /^-[cnp]$/,
  timeout: /^-[sk]$/,
  xargs: /^-[IdEsLnPa]$/,
  env: /^-[uCS]$/,
};

/** Index of the command's real name in `words`, past assignments and wrappers. */
function commandHead(words: string[]): number {
  let k = 0;
  while (k < words.length) {
    const w = words[k]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      k++;
      continue;
    }
    const name = baseName(w);
    if (!WRAPPERS.has(name)) return k;
    k++;
    while (k < words.length) {
      const opt = words[k]!;
      if (opt.startsWith('-')) {
        k += WRAPPER_VALUE_OPTS[name]?.test(opt) ? 2 : 1;
      } else if (name === 'timeout' && /^\d/.test(opt)) {
        k++;
      } else if (name === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(opt)) {
        k++;
      } else break;
    }
  }
  return k;
}

function baseName(word: string): string {
  return (word.split('/').pop() ?? word).toLowerCase();
}

// --- shell rules ------------------------------------------------------------

interface CommandRule {
  action: PermissionAction;
  pattern: RegExp;
  reason: string;
}

/** Case-insensitive: the dev machine's file system is, so `RM` runs `rm`. */
const re = (src: string) => new RegExp(src, 'i');

/**
 * Word-boundary helper for command names: start of segment or after whitespace, with the usual
 * transparent prefixes (`sudo`, `env X=1`, `nohup`, `time`, `nice`, `timeout 30`, `xargs`,
 * `exec`) skipped so the real command is still seen.
 */
const PREFIX =
  '(?:sudo\\s+(?:-\\S+\\s+)*|env\\s+(?:\\S+=\\S+\\s+)*|nohup\\s+|time\\s+|nice\\s+(?:-n\\s*\\d+\\s+)?|timeout\\s+(?:-\\S+\\s+)*\\d+\\S*\\s+|xargs\\s+(?:-\\S+\\s+)*|exec\\s+|command\\s+|builtin\\s+)*';
const cmd = (name: string) => `(?:^|\\s)${PREFIX}(?:\\S*/)?${name}(?=\\s|$)`;
/** git's global options (`-c k=v`, `-C dir`, `--no-pager`, …) sit between `git` and the subcommand. */
const GIT_OPTS = '(?:\\s+(?:-[cC]\\s+\\S+|--[\\w-]+(?:=\\S+)?|-\\S+))*';
const git = (sub: string) => cmd('git') + GIT_OPTS + '\\s+' + sub;
const PYTHON = 'python[0-9.]*';

/**
 * Commands whose real payload is a string the engine cannot see (a shell `-c`, an interpreter
 * one-liner, `eval`, a git alias). Unclassifiable → `ask`.
 */
const OPAQUE_RULES: { pattern: RegExp; reason: string }[] = [
  {
    pattern: re(cmd('(?:sh|bash|zsh|dash|fish|ksh|csh|tcsh|ash)') + '(?:\\s+-\\S+)*\\s+-\\S*c'),
    reason: 'shell -c hides the command it runs',
  },
  {
    pattern: re(cmd('(?:node|bun|deno)') + '(?:\\s+-\\S+)*\\s+(?:-e|-p|--eval|--print|eval)'),
    reason: 'inline script hides what it does',
  },
  {
    pattern: re(
      cmd(`(?:${PYTHON}|perl|ruby|php|osascript|lua|Rscript)`) + '(?:\\s+-\\S+)*\\s+-[cer]',
    ),
    reason: 'inline script hides what it does',
  },
  { pattern: re(cmd('eval')), reason: 'eval hides the command it runs' },
  {
    pattern: re(cmd('git') + '(?:\\s+\\S+)*?\\s+(?:-c\\s*|--config-env[=\\s]+)alias\\.'),
    reason: 'git -c alias.* runs a command the engine cannot see',
  },
  {
    // Configuration keys whose value git runs as a command; `core.pager=cat` and friends are fine.
    pattern: re(
      cmd('git') +
        '(?:\\s+\\S+)*?\\s+-c\\s*(?:core\\.(?:fsmonitor|pager|editor|sshcommand|hookspath|askpass)|sequence\\.editor|gpg\\.program|diff\\.external|(?:diff|filter|credential|merge|uploadpack)\\.\\S*)=(?!(?:cat|less|more|true|false)?(?:\\s|$))',
    ),
    reason: 'git -c sets a command git will run',
  },
  {
    pattern: re('(?:^|\\s)GIT_CONFIG_(?:PARAMETERS|COUNT|KEY_\\d+|VALUE_\\d+)='),
    reason: 'git configuration from the environment',
  },
  {
    pattern: re(
      git('config\\b') +
        '.*(?:\\salias\\.|\\s--(?:global|system|file)\\b|\\s-f(?=\\s|$)|\\sinclude(?:if)?\\.|\\score\\.)',
    ),
    reason: 'git config sets aliases or global configuration',
  },
];

const DESTRUCTIVE_RULES: CommandRule[] = [
  { action: 'destructive', pattern: re(cmd('rm')), reason: 'rm deletes files' },
  { action: 'destructive', pattern: re(cmd('rmdir')), reason: 'rmdir deletes directories' },
  { action: 'destructive', pattern: re(cmd('unlink')), reason: 'unlink deletes files' },
  { action: 'destructive', pattern: re(cmd('shred')), reason: 'shred destroys files' },
  {
    action: 'destructive',
    pattern: re(cmd('find') + '.*\\s-delete(?=\\s|$)'),
    reason: 'find -delete deletes files',
  },
  {
    action: 'destructive',
    pattern: re(git('branch\\s+(?:.*\\s)?(?:-[a-zA-Z]*[dD]|--delete)(?=\\s|$)')),
    reason: 'git branch delete',
  },
  {
    action: 'destructive',
    pattern: re(git('push\\s+(?:.*\\s)?(?:--delete|-d)(?=\\s|$)')),
    reason: 'git push --delete removes a remote branch',
  },
  {
    action: 'destructive',
    pattern: re(git('push(?:\\s+\\S+)*\\s+(?:--force(?:-with-lease)?|-f|\\+\\S+)(?=\\s|$)')),
    reason: 'git push --force',
  },
  {
    action: 'destructive',
    pattern: re(git('reset\\s+(?:.*\\s)?--(?:hard|merge)')),
    reason: 'git reset --hard discards changes',
  },
  {
    action: 'destructive',
    pattern: re(git('clean\\b')),
    reason: 'git clean deletes untracked files',
  },
  {
    // `git checkout <branch>` / `-b` only switch; `--`, `-f`, `.`, `-p`, `--ours/--theirs` discard.
    action: 'destructive',
    pattern: re(
      git(
        'checkout\\s+(?:.*\\s)?(?:--|-f|--force|-[a-zA-Z]*f|\\.|\\./\\S*|-p|--patch|--ours|--theirs|--overwrite-ignore)(?=\\s|$)',
      ),
    ),
    reason: 'git checkout overwrites working-tree files',
  },
  {
    action: 'destructive',
    pattern: re(git('switch\\s+(?:.*\\s)?(?:-f|--force|--discard-changes)(?=\\s|$)')),
    reason: 'git switch --discard-changes overwrites working-tree files',
  },
  {
    action: 'destructive',
    pattern: re(
      git('restore(?![^|]*--staged)\\b') + '|' + git('restore[^|]*(?:--worktree|\\s-[a-zA-Z]*W)'),
    ),
    reason: 'git restore discards working-tree changes',
  },
  {
    action: 'destructive',
    pattern: re(git('(?:stash\\s+(?:drop|clear)|worktree\\s+(?:remove|prune))\\b')),
    reason: 'git stash drop / worktree remove',
  },
  {
    action: 'destructive',
    pattern: re(git('(?:tag|remote)\\s+(?:.*\\s)?(?:-d|--delete|rm|remove)(?=\\s|$)')),
    reason: 'git tag/remote delete',
  },
  {
    action: 'destructive',
    pattern: re(
      git(
        '(?:update-ref|filter-branch|filter-repo|replace|prune|reflog\\s+(?:expire|delete)|gc\\s+(?:.*\\s)?--prune(?:=\\S*)?)(?=\\s|$)',
      ),
    ),
    reason: 'git rewrites or drops history',
  },
  {
    action: 'destructive',
    pattern: re('(?:^|\\s)--force(?:-with-lease)?(?=\\s|$)'),
    reason: '--force operation',
  },
  { action: 'destructive', pattern: re(cmd('dd')), reason: 'dd overwrites devices/files' },
  { action: 'destructive', pattern: re(cmd('mkfs(?:\\.\\w+)?')), reason: 'mkfs' },
  { action: 'destructive', pattern: re(cmd('truncate')), reason: 'truncate empties files' },
  {
    action: 'destructive',
    pattern: re('\\bDROP\\s+(?:TABLE|DATABASE|SCHEMA)\\b'),
    reason: 'SQL DROP',
  },
];

const PUSH_RULES: CommandRule[] = [
  { action: 'push', pattern: re(git('push\\b')), reason: 'git push leaves the machine' },
  { action: 'push', pattern: re(git('send-email\\b')), reason: 'git send-email' },
  {
    action: 'push',
    pattern: re(cmd('(?:npm|pnpm|yarn|cargo|twine|gem)') + '\\s+publish\\b'),
    reason: 'package publish leaves the machine',
  },
  {
    action: 'push',
    pattern: re(
      cmd('gh') +
        '\\s+(?:pr|release|repo|issue)\\s+(?:create|merge|delete|edit|close|comment|push)\\b',
    ),
    reason: 'gh writes to GitHub',
  },
  {
    action: 'push',
    pattern: re(
      cmd('(?:scp|rsync|sftp)') + '.*\\S+@\\S+:|' + cmd('(?:scp|rsync)') + '.*\\s\\S+:\\S+',
    ),
    reason: 'copy to a remote host',
  },
  {
    action: 'push',
    pattern: re(cmd('docker') + '\\s+push\\b'),
    reason: 'docker push leaves the machine',
  },
];

const NETWORK_RULES: CommandRule[] = [
  {
    action: 'network',
    pattern: re(cmd('(?:curl|wget|http|https|xh|aria2c)')),
    reason: 'HTTP client',
  },
  { action: 'network', pattern: re('https?://'), reason: 'URL in command' },
  { action: 'network', pattern: re('/dev/(?:tcp|udp)/'), reason: 'bash network redirection' },
  {
    action: 'network',
    pattern: re(
      cmd('(?:npm|pnpm|yarn|bun)') +
        '\\s+(?:i|install|ci|add|update|up|upgrade|dlx|create|exec|x|link)\\b',
    ),
    reason: 'package install',
  },
  {
    action: 'network',
    pattern: re(cmd('(?:npx|pnpx|bunx|uvx|corepack)')),
    reason: 'package runner may download packages',
  },
  {
    action: 'network',
    pattern: re(
      cmd('(?:pip[0-9.]*|pipx|uv|poetry|conda|pipenv)') +
        '\\s+(?:pip\\s+)?(?:install|add|sync|download|run|tool)\\b',
    ),
    reason: 'python package install',
  },
  {
    action: 'network',
    pattern: re(
      cmd(PYTHON) + '(?:\\s+-\\S+)*\\s+-m\\s*(?:pip\\s+(?:install|download)|http\\.server)\\b',
    ),
    reason: 'python -m pip install / http.server',
  },
  {
    action: 'network',
    pattern: re(cmd('cargo') + '\\s+(?:install|add|fetch|update|search)\\b'),
    reason: 'cargo fetch/install',
  },
  {
    action: 'network',
    pattern: re(cmd('go') + '\\s+(?:get|install|mod\\s+download)\\b'),
    reason: 'go get',
  },
  {
    action: 'network',
    pattern: re(cmd('deno') + '\\s+(?:install|cache|add)\\b'),
    reason: 'deno fetches modules',
  },
  {
    action: 'network',
    pattern: re(
      cmd('(?:brew|apt|apt-get|dnf|yum|pacman|apk|snap|port|choco|winget)') +
        '\\s+(?:install|upgrade|update|add|remove|uninstall|purge)\\b',
    ),
    reason: 'system package manager',
  },
  {
    action: 'network',
    pattern: re(git('(?:clone|fetch|pull|ls-remote|submodule\\s+update|remote\\s+update)\\b')),
    reason: 'git talks to a remote',
  },
  {
    action: 'network',
    pattern: re(cmd('(?:ssh|telnet|nc|ncat|netcat|socat|nmap|ftp|sftp|scp|rsync)')),
    reason: 'remote connection',
  },
  {
    action: 'network',
    pattern: re(cmd('docker') + '\\s+(?:pull|login|build)\\b'),
    reason: 'docker pulls images',
  },
  { action: 'network', pattern: re(cmd('gh')), reason: 'gh talks to GitHub' },
  {
    action: 'network',
    pattern: re(cmd('(?:mail|sendmail|mutt)')),
    reason: 'mail leaves the machine',
  },
];

const ESCAPE_RULES: CommandRule[] = [
  {
    action: 'outside_workspace',
    pattern: re('(?:^|\\s)sudo(?=\\s|$)'),
    reason: 'sudo escapes the workspace sandbox',
  },
  {
    action: 'outside_workspace',
    pattern: re('(?:^|\\s)(?:su|doas)(?=\\s|$)'),
    reason: 'privilege change',
  },
  {
    action: 'outside_workspace',
    pattern: re(cmd('(?:chmod|chown|chgrp)') + '.*\\s-[a-zA-Z]*R'),
    reason: 'recursive ownership/mode change',
  },
  {
    action: 'outside_workspace',
    pattern: re(cmd('(?:crontab|launchctl|systemctl|reboot|shutdown|halt|poweroff)')),
    reason: 'system service or power control',
  },
  {
    action: 'outside_workspace',
    pattern: re(cmd('(?:kill|killall|pkill)')),
    reason: 'signals to other processes',
  },
  {
    // Reads (`--get`, `--list`, `get`, `list`) are fine; anything else writes `.git/config`.
    action: 'outside_workspace',
    pattern: re(
      git('config\\b(?!.*\\s(?:--get(?:-all|-regexp|-urlmatch)?|--list|-l|get|list)(?=\\s|$))'),
    ),
    reason: 'git config changes repository configuration',
  },
];

const ALL_RULES = [...DESTRUCTIVE_RULES, ...PUSH_RULES, ...NETWORK_RULES, ...ESCAPE_RULES];

/** Interpreters that run a program read from stdin when given none (or `-`). */
const INTERPRETER = new RegExp(
  `^(?:sh|bash|zsh|dash|fish|ksh|csh|tcsh|ash|${PYTHON}|pypy[0-9.]*|node|nodejs|bun|deno|perl|ruby|irb|php|lua|luajit|rscript|osascript|tclsh|groovy|jshell)$`,
);
const SHELLS = /^(?:sh|bash|zsh|dash|fish|ksh|csh|tcsh|ash)$/;
const EDITORS = /^(?:vi|vim|nvim|gvim|view|ex|vimdiff)$/;
const INFO_FLAG = /^(?:--version|-version|-v|-V|--help|-h|--test)$/;

/** Why `command` runs code the engine cannot see (a script on stdin, an editor command), if it does. */
function hiddenProgram(command: SimpleCommand): string | undefined {
  const { words } = command;
  const h = commandHead(words);
  if (h >= words.length) return undefined;
  // A computed command name (`$CMD x`, `r$()m x`) or git subcommand (`git $(echo push)`).
  if (words[h]!.includes('$')) return 'the command name is computed at run time';
  const name = baseName(words[h]!);
  const args = words.slice(h + 1);
  if (name === 'git') {
    for (let k = 0; k < args.length; k++) {
      const a = args[k]!;
      if (/^-[cC]$/.test(a)) k++;
      else if (!a.startsWith('-')) {
        if (a.includes('$')) return 'the git subcommand is computed at run time';
        break;
      }
    }
  }
  if (INTERPRETER.test(name)) {
    const dash = args.includes('-');
    const shellStdin = SHELLS.test(name) && args.some((a) => /^-[a-z]*s[a-z]*$/i.test(a));
    // With no script argument an interpreter reads its program from stdin — fed by a pipe, a
    // heredoc or a redirection on this command or on an enclosing group (`(bash) <<EOF`), which
    // the lexer does not track. Only `--version`-style queries are exempt.
    const noScript = !args.some((a) => !a.startsWith('-'));
    const query = args.length > 0 && args.every((a) => INFO_FLAG.test(a));
    if (dash || shellStdin || (noScript && !query)) return `${name} runs a script from stdin`;
  }
  if (EDITORS.test(name) && args.some((a) => /^(?:-c|--cmd|-S|-s|\+.*)$/.test(a))) {
    return `${name} runs editor commands`;
  }
  return undefined;
}

/** Commands that only read their arguments: an agent-config path among them is fine. */
const READ_ONLY_COMMANDS = new Set([
  'cat',
  'less',
  'more',
  'head',
  'tail',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'ls',
  'wc',
  'diff',
  'file',
  'stat',
  'bat',
  'du',
  'tree',
  'md5sum',
  'sha1sum',
  'sha256sum',
  'shasum',
  'readlink',
  'realpath',
  'basename',
  'dirname',
  'test',
  '[',
  'echo',
  'printf',
  'jq',
]);
const WRITE_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>', '<>']);
/** Devices a redirection or argument may name without leaving the workspace. */
const HARMLESS_DEVICES = new Set([
  '/dev/null',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/stdin',
  '/dev/tty',
]);
const CONFIG_WORD = /(?:^|\/)(?:\.claude|\.husky|\.git)(?:\/|$)|(?:^|\/)\.mcp\.json$/;

export function classifyCommand(command: string, ctx: PolicyContext): Classification {
  const actions = new Set<PermissionAction>();
  const reasons: string[] = [];
  const trimmed = command.trim();
  if (trimmed === '') return { actions: [], reasons: ['empty command'] };

  const lexed = lexCommand(trimmed);
  let opaque = lexed.opaque.length > 0;
  for (const why of lexed.opaque) reasons.push(`cannot read the command safely: ${why}`);

  // `cd` changes where the later segments resolve relative paths from.
  let cwd = cwdOf(ctx);

  for (const simple of lexed.commands) {
    const here: PolicyContext = { ...ctx, cwd };
    const text = simple.words.join(' ');
    const shown = text || simple.redirects.map((r) => `${r.op}${r.target}`).join(' ');
    for (const rule of OPAQUE_RULES) {
      if (rule.pattern.test(text)) {
        opaque = true;
        reasons.push(`${rule.reason}: ${shown}`);
      }
    }
    const hidden = hiddenProgram(simple);
    if (hidden) {
      opaque = true;
      reasons.push(`${hidden}: ${shown}`);
    }
    const scanned = [text, ...simple.redirects.map((r) => r.target)].join(' ');
    for (const rule of ALL_RULES) {
      if (rule.pattern.test(scanned)) {
        actions.add(rule.action);
        reasons.push(`${rule.reason}: ${shown}`);
      }
    }
    const { paths, unresolvable } = pathsOf(simple);
    for (const p of paths) {
      if (!isInsideWorkspace(p, here)) {
        actions.add('outside_workspace');
        reasons.push(`${p}: outside the workspace`);
      }
    }
    for (const p of unresolvable) {
      actions.add('outside_workspace');
      reasons.push(`${p}: cannot tell where it points`);
    }
    for (const p of configTargets(simple, here)) {
      actions.add('outside_workspace');
      reasons.push(`${p}: agent or git configuration, which runs outside the gate`);
    }

    const h = commandHead(simple.words);
    const name = simple.words[h]?.toLowerCase();
    if (name === 'cd' || name === 'pushd') {
      const target = simple.words.slice(h + 1).find((w) => w === '-' || !w.startsWith('-'));
      if (target === undefined || target === '' || target === '~') {
        cwd = ctx.home ?? homedir();
      } else if (target === '-' || unresolvable.length > 0 || /[$`]/.test(target)) {
        actions.add('outside_workspace');
        reasons.push(`cd ${target}: cannot tell where it leads`);
      } else {
        cwd = resolvePath(target, ctx, cwd);
      }
      if (!isInsideWorkspace(cwd, ctx)) {
        actions.add('outside_workspace');
        reasons.push(`${shown}: leaves the workspace`);
      }
    }
  }
  if (opaque) return { actions: [], reasons };
  if (actions.size === 0) actions.add('run_workspace');
  return { actions: [...actions], reasons };
}

/** Agent/git configuration paths `command` may write: write redirections, or any argument of a non-read-only command. */
function configTargets(command: SimpleCommand, ctx: PolicyContext): string[] {
  const out: string[] = [];
  const candidates = command.redirects
    .filter((r) => WRITE_REDIRECTS.has(r.op))
    .map((r) => r.target);
  const h = commandHead(command.words);
  const name = command.words[h] !== undefined ? baseName(command.words[h]) : undefined;
  if (name !== undefined && !READ_ONLY_COMMANDS.has(name)) {
    for (const w of command.words.slice(h + 1)) {
      const eq = w.indexOf('=');
      candidates.push(eq > 0 && w.startsWith('-') ? w.slice(eq + 1) : w);
    }
  }
  for (const c of candidates) {
    for (const alt of expandBraces(c) ?? [c]) {
      if (CONFIG_WORD.test(alt) && isInsideWorkspace(alt, ctx) && isAgentConfigPath(alt, ctx)) {
        out.push(alt);
        break;
      }
    }
  }
  return out;
}

export interface CommandPaths {
  /** Path-looking tokens: absolute, `~`, `$HOME`/`$PWD`-based, or relative with a `..`. */
  paths: string[];
  /** Tokens with a shell variable, substitution or `~user` the engine cannot expand lexically. */
  unresolvable: string[];
}

/**
 * Path-looking tokens of a shell line. Option values (`--out=/tmp/x`) and redirection targets
 * count too; braces are expanded. Plain words are not paths, so `ls foo` never escapes; `ls
 * ../foo` is checked. `$HOME` and `$PWD` are expanded; any other `$VAR` or substitution inside
 * a path-like token makes it unresolvable, and so does `~user`.
 */
export function pathsInCommand(command: string): CommandPaths {
  const out: CommandPaths = { paths: [], unresolvable: [] };
  for (const c of lexCommand(command).commands) {
    const p = pathsOf(c);
    out.paths.push(...p.paths);
    out.unresolvable.push(...p.unresolvable);
  }
  return out;
}

function pathsOf(command: SimpleCommand): CommandPaths {
  const out: CommandPaths = { paths: [], unresolvable: [] };
  const add = (word: string, isTarget: boolean) => {
    for (const alt of expandBraces(word) ?? [word]) pathToken(alt, isTarget, out, word);
  };
  for (const w of command.words) add(w, false);
  for (const r of command.redirects) {
    if (r.op === '<<' || r.op === '<<-' || r.op === '<<<') continue; // delimiter / string, not a file
    if ((r.op === '>&' || r.op === '<&') && /^(?:\d+-?|-)$/.test(r.target)) continue; // fd dup
    add(r.target, true);
  }
  return out;
}

function pathToken(raw: string, isTarget: boolean, out: CommandPaths, shown: string): void {
  let token = raw;
  if (!isTarget) {
    const eq = token.indexOf('=');
    if (eq > 0 && token.startsWith('-')) token = token.slice(eq + 1);
    if (token.startsWith('-')) return;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return; // URLs are the network rules' business
  token = token.replace(/^\$\{?HOME\}?(?=\/|$)/, '~').replace(/^\$\{?PWD\}?(?=\/|$)/, '.');
  if (HARMLESS_DEVICES.has(token) || /^\/dev\/(?:tcp|udp)\//.test(token)) return;
  if (/^~[^/]/.test(token)) {
    out.unresolvable.push(shown); // `~user`: someone else's home
    return;
  }
  if (/[$`]/.test(token)) {
    if (isTarget || token.includes('/') || /^\$\{?(?:HOME|PWD|TMPDIR|TMP|TEMP)\}?/.test(token)) {
      out.unresolvable.push(shown);
    }
    return;
  }
  const located = globLocations(token)?.[0] ?? token;
  if (isTarget || looksLikeLocation(token) || looksLikeLocation(located)) {
    out.paths.push(looksLikeLocation(located) && !looksLikeLocation(token) ? located : token);
  }
}

// --- paths ------------------------------------------------------------------

function cwdOf(ctx: PolicyContext): string {
  return resolvePath(ctx.cwd ?? ctx.workspace, ctx, ctx.workspace);
}

/** `p` made absolute: `~` expanded, relative paths resolved from `from`. */
function resolvePath(p: string, ctx: PolicyContext, from: string): string {
  return resolve(expandHome(from, ctx), expandHome(p, ctx));
}

/**
 * Whether `p` (absolute, `~`-prefixed or relative to `ctx.cwd`) resolves inside `ctx.workspace`.
 * Purely lexical — `..` segments are resolved, symlinks are not (the engine has no file system).
 * `~user` is someone else's home: never inside.
 */
export function isInsideWorkspace(p: string, ctx: PolicyContext): boolean {
  if (/^~[^/]/.test(p)) return false;
  const workspace = resolve(expandHome(ctx.workspace, ctx));
  const cwd = ctx.cwd ? resolve(expandHome(ctx.cwd, ctx)) : workspace;
  return within(workspace, resolvePath(p, ctx, cwd));
}

function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Whether `p` names agent or git configuration that runs outside the gate on a later spawn or
 * git command: anything under `.claude/`, `.git/` or `.husky/`, or a `.mcp.json`. Measured from
 * the agent's cwd when `p` is under it (its worktree), else from the workspace root, so a
 * workspace that itself lives under such a directory is not flagged wholesale.
 */
export function isAgentConfigPath(p: string, ctx: PolicyContext): boolean {
  const workspace = resolve(expandHome(ctx.workspace, ctx));
  const cwd = ctx.cwd ? resolve(expandHome(ctx.cwd, ctx)) : workspace;
  const target = resolvePath(p, ctx, cwd);
  const root = within(cwd, target) ? cwd : workspace;
  const segments = relative(root, target).split(sep);
  return (
    segments.some((s) => s === '.claude' || s === '.git' || s === '.husky') ||
    segments[segments.length - 1] === '.mcp.json'
  );
}

function expandHome(p: string, ctx: PolicyContext): string {
  if (p === '~') return ctx.home ?? homedir();
  if (p.startsWith('~/')) return (ctx.home ?? homedir()) + p.slice(1);
  return p;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
