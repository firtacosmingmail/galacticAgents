import { homedir } from 'node:os';
import type { CommandPart, ToolCall } from '@galactic/protocol';
import { redactSecrets, redactValue } from '../runtime/redact.js';
import {
  ASSIGNMENT_WORD,
  INTERPRETER,
  MAX_NESTING,
  SHELLS,
  classifyCommand,
  classifyToolCall,
  commandHead,
  cwdOf,
  isInsideWorkspace,
  lexCommand,
  pathsInCommand,
  resolvePath,
  withVars,
  type PolicyContext,
  type SimpleCommand,
} from './permissions.js';

/**
 * The command splitter for the request judge (P13-02; design 2026-11-09-waykeeper-approvals §5.4).
 *
 * The gate (`classifyCommand`) reads a shell line as one whole and treats `sh -c` bodies, heredocs
 * fed to a shell and `xargs` targets as opaque. The judge needs more: every part of the line on
 * its own, so that a harmful command hidden late in a long chain, inside `sh -c`, a heredoc, a
 * `$(…)` or behind `xargs` comes out as a part it must pass. Each part is classified with the
 * gate's own `classifyCommand`; the gate's verdicts are not changed by anything here.
 *
 * What still cannot be seen into is marked `opaque`: inline code for another interpreter
 * (`inline_code`, the code kept in the text), a script file the command runs (`script_file`), and
 * anything the lexer cannot read or that nests too deep (`unreadable`). Never throws: whatever
 * goes wrong, the whole command becomes one `unreadable` part.
 */

/** Thrown inside the splitter when shells nest deeper than `MAX_NESTING`. */
class TooDeep extends Error {}

/** What the splitter knows of the Steward besides its policy context. */
export interface SplitOptions {
  /**
   * The Steward's scratch folder (P13-09): a destructive part whose targets are all inside it or
   * the worktree, run from either, is not `outsideCwd`. Compared like the worktree (its spelling
   * in `ctx.workspace`, `ctx.aliases` for the resolved one).
   */
  scratch?: string;
}

/** The parts of a shell command, in the order the lexer meets them. Never empty, never throws. */
export function commandParts(
  command: string,
  ctx: PolicyContext,
  opts: SplitOptions = {},
): CommandPart[] {
  try {
    const parts = new Splitter(ctx, opts).split(command, 0);
    return parts.length > 0 ? parts : [unreadablePart(command, ctx, opts)];
  } catch {
    return [unreadablePart(command, ctx, opts)];
  }
}

/** Longest text of a non-shell tool's part. */
export const MAX_CALL_PART_CHARS = 300;

/**
 * The parts of any tool call: a `Bash` call's command split by `commandParts`; any other tool one
 * part, its name and a one-line summary of its redacted input (at most `MAX_CALL_PART_CHARS`),
 * classified with `classifyToolCall`.
 */
export function partsOfCall(
  call: ToolCall,
  ctx: PolicyContext,
  opts: SplitOptions = {},
): CommandPart[] {
  const input =
    typeof call.input === 'object' && call.input !== null && !Array.isArray(call.input)
      ? (call.input as Record<string, unknown>)
      : {};
  if (call.toolName === 'Bash') {
    const command = typeof input['command'] === 'string' ? input['command'] : '';
    return commandParts(command, ctx, opts);
  }
  let summary: string;
  try {
    summary = redactSecrets(JSON.stringify(redactValue(call.input)) ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    summary = '';
  }
  const line = summary ? `${call.toolName} ${summary}` : call.toolName;
  const text =
    line.length <= MAX_CALL_PART_CHARS ? line : `${line.slice(0, MAX_CALL_PART_CHARS - 1)}…`;
  const c = classifyToolCall(call, ctx);
  return [{ text, categories: c.actions, ...(c.guarded ? { guarded: true as const } : {}) }];
}

// ---------------------------------------------------------------------------

function unreadablePart(text: string, ctx: PolicyContext, opts: SplitOptions): CommandPart {
  try {
    return new Splitter(ctx, opts).part(text, 'unreadable');
  } catch {
    return { text, categories: [], opaque: 'unreadable' };
  }
}

/** Places a binary lives in: a command named by such a path is a program, not a script. */
const SYSTEM_BIN =
  /^\/(?:bin|sbin|usr\/bin|usr\/sbin|usr\/local\/bin|usr\/local\/sbin|usr\/libexec|opt\/homebrew\/bin|opt\/homebrew\/sbin)\//;
const HEREDOC_OPS = new Set(['<<', '<<-', '<<<']);

class Splitter {
  /** Where relative paths resolve from; a `cd` moves it for the parts after it, as in the gate. */
  private cwd: string;
  /**
   * Every cwd the line has been at. The lexer flattens `$(…)` and `( … )`, so a `cd` there looks
   * like it moves the cwd for what follows; `outside` judges paths from all of them.
   */
  private readonly seen = new Set<string>();
  /**
   * Set by a `cd`/`pushd` the splitter cannot place (`cd "$HOME"`, `` cd `x` ``, `cd ~bob`,
   * `cd -`): from then on the cwd is unknown and every destructive part is `outsideCwd` (fail
   * closed). Never cleared — not by a later `cd`, nor at the end of a nested body, as `seen`.
   */
  private unknownCwd = false;
  /**
   * The variables the line sets (P13-09), used only to place targets (`outside`, a `cd`); what the
   * judge is shown is unchanged. A string: set to that literal value by `NAME=value` run on its
   * own in the reading shell (`ownShell`), the only place the line sets that name, the value with
   * no whitespace, `$`, backtick, glob or `~`. `null`: set in any other way, set more than once,
   * read into or unset — a destructive part that uses it cannot be placed.
   * A body a shell runs keeps its own (`nested`).
   */
  private vars = new Map<string, string | null>();
  /** Set by `eval`, `source` and the like: any variable may have been set to anything. */
  private anyVar = false;

  constructor(
    private readonly ctx: PolicyContext,
    private readonly opts: SplitOptions = {},
  ) {
    this.cwd = cwdOf(ctx);
    this.seen.add(this.cwd);
  }

  split(src: string, depth: number): CommandPart[] {
    if (depth > MAX_NESTING) throw new TooDeep();
    const lexed = lexCommand(src);
    if (lexed.opaque.length > 0) return [this.part(src, 'unreadable')];
    // A function the line defines may set any variable when it is called: nothing is remembered.
    const defines = DEFINES_FUNCTION.test(src);
    // The whole line is read first (P13-09 review): a loop may run an assignment before a part
    // that comes earlier in the text, and `IFS`, `trap` or a nameref may change any name. Only a
    // name the line sets exactly once can keep a literal value.
    const { all, once } = this.assignedOnce(lexed.commands);
    if (all) {
      this.anyVar = true;
      for (const v of this.vars.keys()) this.vars.set(v, null);
    }
    const out: CommandPart[] = [];
    for (const command of lexed.commands) {
      this.forget(command);
      out.push(...this.simple(command, depth));
      if (!defines && !all) this.remember(command, once);
    }
    return out;
  }

  /**
   * Whether any of `commands` may set every name (`all`), and the names exactly one of them sets
   * (`once`), counted over the whole line, loop and `$(…)` bodies included.
   */
  private assignedOnce(commands: SimpleCommand[]): { all: boolean; once: Set<string> } {
    const count = new Map<string, number>();
    for (const command of commands) {
      const names = assignedBy(command);
      if (names === 'all') return { all: true, once: new Set() };
      for (const n of names) count.set(n, (count.get(n) ?? 0) + 1);
    }
    return { all: false, once: new Set([...count].filter(([, c]) => c === 1).map(([n]) => n)) };
  }

  /** Marks unknown every name `command` may set (`assignedBy`). */
  private forget(command: SimpleCommand): void {
    const names = assignedBy(command);
    if (names === 'all') {
      this.anyVar = true;
      for (const v of this.vars.keys()) this.vars.set(v, null);
      return;
    }
    for (const n of names) this.vars.set(n, null);
  }

  /**
   * Remembers the literal values a bare assignment sets, for a name the line sets only there
   * (`once`); any other value — one with whitespace (word splitting), `$`, a backtick, a glob or
   * `~` — is unknown.
   */
  private remember(command: SimpleCommand, once: ReadonlySet<string>): void {
    if (!command.ownShell || command.redirects.length > 0 || command.heredoc) return;
    const pairs = command.words.map((w) => /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(w));
    if (pairs.length === 0 || pairs.some((p) => p === null)) return;
    for (const p of pairs) {
      const [, name, value] = p!;
      this.vars.set(name!, !once.has(name!) || /[$`*?[\]{}~\s]/.test(value!) ? null : value!);
    }
  }

  /** The variables with a known literal value. */
  private known(): Map<string, string> {
    const out = new Map<string, string>();
    for (const [k, v] of this.vars) if (v !== null) out.set(k, v);
    return out;
  }

  /** Whether `text` uses a variable the line set to something it cannot read. */
  private usesUnknown(text: string): boolean {
    for (const c of lexCommand(text).commands) {
      for (const w of [...c.words, ...c.redirects.map((r) => r.target)]) {
        for (const m of w.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) {
          const v = this.vars.get(m[1]!);
          if (v === null || (v === undefined && this.anyVar)) return true;
        }
      }
    }
    return false;
  }

  private simple(command: SimpleCommand, depth: number): CommandPart[] {
    const { words } = command;
    const h = commandHead(words);
    if (h >= words.length) return [this.plain(command)];

    const name = baseName(words[h]!);
    if (h > 0) {
      // A wrapper (`sudo`, `env X=1`, `timeout 30`, `xargs -0`) in front of a command the
      // splitter looks into, or `xargs`'s target: the target is split on its own, and the
      // wrapper is a part when it adds something (`sudo`) or sets a variable.
      const prefix = words.slice(0, h);
      const xargsAt = prefix.findIndex((w) => baseName(w) === 'xargs');
      if (xargsAt >= 0 || lookedInto(words[h]!)) {
        const out: CommandPart[] = [];
        const assigns = prefix.some(isAssignment);
        const wrapper = this.part(prefix.map(quoteWord).join(' '));
        const plain =
          wrapper.categories.length === 1 &&
          wrapper.categories[0] === 'run_workspace' &&
          !wrapper.opaque &&
          !wrapper.guarded;
        if (!plain || assigns) out.push(wrapper);
        const target: SimpleCommand = { ...command, words: words.slice(h) };
        const runsCode = SHELLS.test(name) || INTERPRETER.test(name);
        // A variable can change what a shell or interpreter runs (`BASH_ENV`, `PAGER`,
        // `PYTHONSTARTUP`); `xargs` can hand one its code (`-I{} sh -c '{}'`, `xargs bash`).
        if (
          runsCode &&
          (assigns || (xargsAt >= 0 && xargsFeedsCode(prefix.slice(xargsAt), target.words)))
        ) {
          out.push(this.part(commandText(target), 'unreadable'));
        } else out.push(...this.simple(target, depth));
        return out;
      }
    }

    const args = words.slice(h + 1);
    if (SHELLS.test(name)) return this.shell(command, args, depth);
    if (INTERPRETER.test(name)) return [this.interpreter(command, name, args)];
    if (name === 'source' || name === '.') {
      return [this.part(commandText(command), args.length > 0 ? 'script_file' : undefined)];
    }
    if (words[h]!.includes('/') && !SYSTEM_BIN.test(words[h]!)) {
      return [this.part(commandText(command), 'script_file')];
    }
    return [this.plain(command)];
  }

  /** A shell: its `-c` body or the heredoc it reads is split; a script file it runs is opaque. */
  private shell(command: SimpleCommand, args: string[], depth: number): CommandPart[] {
    const script = shellScript(args);
    const redirects = command.redirects.filter((r) => !HEREDOC_OPS.has(r.op));
    const redirectPart = () =>
      redirects.length > 0 ? [this.part(redirects.map(redirectText).join(' '))] : [];
    if (script.kind === 'c') {
      if (script.body === undefined) return [this.part(commandText(command), 'unreadable')];
      const body = this.nested(script.body, depth);
      if (!script.positional) return [...body, ...redirectPart()];
      // `sh -c 'rm -rf "$1"' _ /`: the body runs on arguments the parts cannot show. Every part
      // is unreadable and carries what the gate sees in the whole command.
      const whole = this.part(commandText(command), 'unreadable');
      return [
        ...body.map((p) => {
          const categories = [...new Set([...p.categories, ...whole.categories])];
          const outside =
            p.outsideCwd || (categories.includes('destructive') && this.outside(whole.text));
          return {
            text: p.text,
            categories,
            opaque: 'unreadable' as const,
            ...(p.guarded || whole.guarded ? { guarded: true as const } : {}),
            ...(outside ? { outsideCwd: true as const } : {}),
          };
        }),
        ...redirectPart(),
      ];
    }
    if (script.kind === 'file') return [this.part(commandText(command), 'script_file')];
    const body = stdinCode(command);
    if (body !== undefined) return [...this.nested(body, depth), ...redirectPart()];
    if (command.redirects.some((r) => r.op === '<')) {
      return [this.part(commandText(command), 'script_file')];
    }
    return [this.plain(command)];
  }

  /**
   * A body a shell runs: split one level deeper; a `cd` or a variable it sets does not reach the
   * line outside it.
   */
  private nested(body: string, depth: number): CommandPart[] {
    const saved = this.cwd;
    const savedVars = new Map(this.vars);
    const savedAny = this.anyVar;
    try {
      return this.split(body, depth + 1);
    } finally {
      this.cwd = saved;
      this.vars = savedVars;
      this.anyVar = savedAny;
    }
  }

  /** Another interpreter: inline code and heredoc input are `inline_code`, a script file opaque. */
  private interpreter(command: SimpleCommand, name: string, args: string[]): CommandPart {
    const text = commandText(command);
    if (args.some((a) => inlineFlag(name, a)) || (name === 'deno' && args[0] === 'eval')) {
      return this.part(text, 'inline_code');
    }
    const script = interpreterScript(name, args);
    if (script !== undefined && script !== '-') return this.part(text, 'script_file');
    if (stdinCode(command) !== undefined) return this.part(text, 'inline_code');
    if (command.redirects.some((r) => r.op === '<')) return this.part(text, 'script_file');
    return this.plain(command);
  }

  /** A command the splitter does not look into: one part; a `cd` moves the cwd after it. */
  private plain(command: SimpleCommand): CommandPart {
    const part = this.part(commandText(command));
    const h = commandHead(command.words);
    const name = command.words[h]?.toLowerCase();
    if (name === 'cd' || name === 'pushd') {
      const words = withVars(command, this.known()).words;
      const target = words.slice(h + 1).find((w) => w === '-' || !w.startsWith('-'));
      if (target === undefined || target === '' || target === '~') {
        this.cwd = this.ctx.home ?? homedir();
        this.seen.add(this.cwd);
      } else if (target !== '-' && !/[$`]/.test(target) && !/^~[^/]/.test(target)) {
        this.cwd = resolvePath(target, this.ctx, this.cwd);
        this.seen.add(this.cwd);
      } else {
        this.unknownCwd = true;
      }
    }
    return part;
  }

  /** `text` classified by the gate from the current cwd; anything it cannot read is unreadable. */
  part(text: string, opaque?: CommandPart['opaque']): CommandPart {
    const c = classifyCommand(text, { ...this.ctx, cwd: this.cwd });
    const marked = opaque ?? (c.unclassified ? 'unreadable' : undefined);
    const outside = c.actions.includes('destructive') && (this.unknownCwd || this.outside(text));
    return {
      text,
      categories: c.actions,
      ...(marked ? { opaque: marked } : {}),
      ...(c.guarded ? { guarded: true as const } : {}),
      ...(outside ? { outsideCwd: true as const } : {}),
    };
  }

  /**
   * Whether `text` reaches outside the Steward's worktree (`ctx.cwd`; design §5.4a) and its
   * scratch folder (`opts.scratch`, P13-09): it runs from a cwd outside both, names a path outside
   * both, names a path that cannot be placed, or uses a variable the line set to something it
   * cannot read — judged from every cwd the line has been at (`seen`), so it may flag a delete
   * one time too many. The gate's own path reading (`pathsInCommand`, `isInsideWorkspace`) with
   * each folder as the root, `$NAME` replaced by the literal value the line gave it.
   */
  outside(text: string): boolean {
    const roots = [cwdOf(this.ctx)];
    if (this.opts.scratch) roots.push(resolvePath(this.opts.scratch, this.ctx, roots[0]!));
    if (this.usesUnknown(text)) return true;
    const { paths, unresolvable } = pathsInCommand(text, this.known());
    if (unresolvable.length > 0) return true;
    return [...this.seen, this.cwd].some((cwd) => {
      const own = (p: string) =>
        roots.some((root) => isInsideWorkspace(p, { ...this.ctx, workspace: root, cwd }));
      return !own(cwd) || paths.some((p) => !own(p));
    });
  }
}

/**
 * The names `command` may set: `'all'` after `eval`, `source`, `let`, `trap` and the like, a
 * nameref (`declare -n`, `local -n`, `typeset -n`) or any assignment to `IFS`; else each name it
 * assigns (`x=…`, `${x:=…}`), and each name a builtin that sets variables is given (`read x`,
 * `for x in`, `unset x`, `printf -v x`, `export x=…`).
 */
function assignedBy(command: SimpleCommand): Set<string> | 'all' {
  const h = commandHead(command.words);
  const head = command.words[h];
  const name = head === undefined ? undefined : baseName(head);
  if (name !== undefined && FORGETS_ALL.has(name)) return 'all';
  const args = command.words.slice(h + 1);
  if (name !== undefined && NAMEREF.has(name) && args.some((w) => /^-[A-Za-z]*n/.test(w))) {
    return 'all';
  }
  const out = new Set<string>();
  const names = name !== undefined && SETS_NAMED.has(name);
  const words = [...command.words, ...command.redirects.map((r) => r.target)];
  for (const [k, w] of words.entries()) {
    for (const m of w.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*):?=/g)) out.add(m[1]!);
    // An assignment before the command (`x=1 cmd`, `then x=1`) or given to `export` and the
    // like; not an argument of another program (`sh -c 'x=1'` sets nothing here).
    if (k > h && !names) continue;
    const leading = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[|\+?=)/.exec(w)?.[1];
    if (leading !== undefined) out.add(leading);
    if (!names || k <= h) continue;
    const named = /^-[A-Za-z]*?([A-Za-z_][A-Za-z0-9_]*)$|^([A-Za-z_][A-Za-z0-9_]*)$/.exec(w);
    if (named) for (const n of [named[1], named[2]]) if (n) out.add(n);
    // An option cluster may end in a name glued to it (`-vx`): any suffix of it.
    if (/^-[A-Za-z0-9_]+$/.test(w)) {
      for (let k = 2; k < w.length; k++) {
        if (/^[A-Za-z_]/.test(w.slice(k))) out.add(w.slice(k));
      }
    }
  }
  return out.has('IFS') ? 'all' : out;
}

/** A line that defines a shell function (`f() {`, `function f`). */
const DEFINES_FUNCTION = /(?:^|[\s;&|(){}])function\s|[A-Za-z0-9_.:-]\s*\(\s*\)/;
/** Commands that may set any variable, named in a way the splitter cannot read: forget all. */
const FORGETS_ALL: ReadonlySet<string> = new Set(['eval', 'source', '.', 'let', 'alias', 'trap']);
/** Builtins whose `-n` makes a nameref: an assignment to it sets the name it refers to. */
const NAMEREF: ReadonlySet<string> = new Set(['declare', 'typeset', 'local']);
/** Builtins that set the variables they are given by name (`read x`, `for x in …`). */
const SETS_NAMED: ReadonlySet<string> = new Set([
  'read',
  'mapfile',
  'readarray',
  'getopts',
  'unset',
  'printf',
  'wait',
  'for',
  'select',
  'declare',
  'typeset',
  'local',
  'export',
  'readonly',
]);

function isAssignment(word: string): boolean {
  return ASSIGNMENT_WORD.test(word);
}

/** `xargs` options that take a separate value (besides the replace-string ones). */
const XARGS_VALUE_OPTS = /^-[dEsLnPa]$/;

/**
 * Whether `xargs` (its words from `xargs` on) hands the shell or interpreter `target` its code:
 * the target's arguments use the replace-string (`-I R`, `-J R`, `-i[R]`, `--replace[=R]`; `{}`
 * by default), or the target reads its code from what `xargs` appends (`xargs sh`, `xargs bash
 * -c`, `xargs python3`).
 */
function xargsFeedsCode(xargs: string[], target: string[]): boolean {
  let replace: string | undefined;
  for (let k = 1; k < xargs.length; k++) {
    const a = xargs[k]!;
    if (a === '-I' || a === '-J') replace = xargs[++k];
    else if (/^-[IJ]./.test(a)) replace = a.slice(2);
    else if (a === '-i' || a === '--replace') replace = '{}';
    else if (/^-i./.test(a)) replace = a.slice(2);
    else if (a.startsWith('--replace=')) replace = a.slice('--replace='.length) || '{}';
    else if (XARGS_VALUE_OPTS.test(a)) k++;
  }
  const args = target.slice(1);
  if (replace && args.some((w) => w.includes(replace))) return true;
  const name = baseName(target[0] ?? '');
  if (SHELLS.test(name)) {
    const script = shellScript(args);
    return script.kind === 'stdin' || (script.kind === 'c' && script.body === undefined);
  }
  if (args.some((a) => inlineFlag(name, a)) || (name === 'deno' && args[0] === 'eval')) {
    return false;
  }
  const script = interpreterScript(name, args);
  return script === undefined || script === '-';
}

/** Whether the splitter looks into a command named `word` (or marks it opaque). */
function lookedInto(word: string): boolean {
  const name = baseName(word);
  return (
    SHELLS.test(name) ||
    INTERPRETER.test(name) ||
    name === 'source' ||
    name === '.' ||
    (word.includes('/') && !SYSTEM_BIN.test(word))
  );
}

type ShellScript =
  | { kind: 'c'; body: string | undefined; positional: boolean }
  | { kind: 'file' }
  | { kind: 'stdin' };

/** What a shell runs, from its arguments: a `-c` body, a script file, or its stdin. */
function shellScript(args: string[]): ShellScript {
  let c = false;
  let s = false;
  let k = 0;
  for (; k < args.length; k++) {
    const a = args[k]!;
    if (a === '--') {
      k++;
      break;
    }
    if (a.startsWith('--')) {
      if (a === '--rcfile' || a === '--init-file') k++;
      continue;
    }
    if (/^[-+][a-zA-Z]+$/.test(a)) {
      if (a.startsWith('-') && a.includes('c')) c = true;
      if (a.startsWith('-') && a.includes('s')) s = true;
      if (/[oO]$/.test(a)) k++; // `-o pipefail`, `-O extglob`
      continue;
    }
    break;
  }
  const first = args[k];
  if (c) return { kind: 'c', body: first, positional: args.length > k + 1 };
  if (first !== undefined && first !== '-' && !s) return { kind: 'file' };
  return { kind: 'stdin' };
}

/** Whether `arg` gives interpreter `name` code inline (`python -c`, `node -e`, `perl -ne`, …). */
function inlineFlag(name: string, arg: string): boolean {
  if (/^(?:python|pypy)/.test(name)) return /^-[a-zA-Z]*c$/.test(arg);
  if (name === 'php') return /^-[a-zA-Z]*r$/.test(arg);
  return /^(?:-[a-zA-Z]*[eE]|-p|--eval|--print)$/.test(arg);
}

/** Options of interpreters that take a separate value. */
const INTERPRETER_VALUE_OPTS =
  /^(?:-W|-X|-r|-C|--require|--import|--loader|--experimental-loader)$/;

/**
 * The script file an interpreter runs, if its first argument looks like one (`node build.js`,
 * `python tools/x.py`, `deno run x.ts`); `-` is stdin. `python -m mod` and subcommands
 * (`bun test`) run no file of their own.
 */
function interpreterScript(name: string, args: string[]): string | undefined {
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (a === '-') return a;
    if (a === '-m') return undefined;
    if (a.startsWith('-')) {
      if (INTERPRETER_VALUE_OPTS.test(a)) k++;
      continue;
    }
    if ((name === 'deno' || name === 'bun') && a === 'run') continue;
    return a.includes('/') || /\.[A-Za-z0-9]+$/.test(a) ? a : undefined;
  }
  return undefined;
}

/** The code a command reads on stdin from a heredoc or a here-string, if any. */
function stdinCode(command: SimpleCommand): string | undefined {
  if (command.heredocBody !== undefined) return command.heredocBody;
  const herestring = command.redirects.find((r) => r.op === '<<<');
  return herestring?.target;
}

function baseName(word: string): string {
  return (word.split('/').pop() ?? word).toLowerCase();
}

/** The marker the lexer leaves where a command substitution was. */
const SUBSTITUTION = '$()';
const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./~^-]+$/;

/**
 * A dequoted word quoted back so that lexing it again gives the same word: plain words as they
 * are, words with variables in double quotes, anything else in single quotes.
 */
function quoteWord(w: string): string {
  if (w === '') return "''";
  const bare = w.split(SUBSTITUTION).join('');
  if (bare === '' || SAFE_WORD.test(bare)) return w;
  // `X=a b` as `X='a b'`: still an assignment when lexed again.
  const assignment = /^([A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=)([\s\S]*)$/.exec(w);
  if (assignment) return assignment[1]! + quoteWord(assignment[2]!);
  if (!/['"\\`]/.test(w) && w.includes('$') && !/\$\((?!\))/.test(w)) return `"${w}"`;
  if (!w.includes("'")) return `'${w}'`;
  return `"${w.replace(/[\\"`$]/g, '\\$&')}"`;
}

function redirectText(r: { op: string; target: string }): string {
  if (r.op === '<<' || r.op === '<<-') {
    return `${r.op}${r.target.includes("'") ? quoteWord(r.target) : `'${r.target}'`}`;
  }
  if ((r.op === '>&' || r.op === '<&') && /^(?:\d+-?|-)$/.test(r.target)) {
    return `${r.op}${r.target}`;
  }
  return `${r.op} ${quoteWord(r.target)}`;
}

/** A simple command as text the gate reads the same way, its heredoc body after it. */
function commandText(command: SimpleCommand): string {
  const line = [...command.words.map(quoteWord), ...command.redirects.map(redirectText)].join(' ');
  if (command.heredocBody === undefined) return line;
  const delim = [...command.redirects].reverse().find((r) => r.op === '<<' || r.op === '<<-');
  return `${line}\n${command.heredocBody}${delim?.target ?? ''}`;
}
