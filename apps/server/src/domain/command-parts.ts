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

/** The parts of a shell command, in the order the lexer meets them. Never empty, never throws. */
export function commandParts(command: string, ctx: PolicyContext): CommandPart[] {
  try {
    const parts = new Splitter(ctx).split(command, 0);
    return parts.length > 0 ? parts : [unreadablePart(command, ctx)];
  } catch {
    return [unreadablePart(command, ctx)];
  }
}

/** Longest text of a non-shell tool's part. */
export const MAX_CALL_PART_CHARS = 300;

/**
 * The parts of any tool call: a `Bash` call's command split by `commandParts`; any other tool one
 * part, its name and a one-line summary of its redacted input (at most `MAX_CALL_PART_CHARS`),
 * classified with `classifyToolCall`.
 */
export function partsOfCall(call: ToolCall, ctx: PolicyContext): CommandPart[] {
  const input =
    typeof call.input === 'object' && call.input !== null && !Array.isArray(call.input)
      ? (call.input as Record<string, unknown>)
      : {};
  if (call.toolName === 'Bash') {
    const command = typeof input['command'] === 'string' ? input['command'] : '';
    return commandParts(command, ctx);
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

function unreadablePart(text: string, ctx: PolicyContext): CommandPart {
  try {
    return new Splitter(ctx).part(text, 'unreadable');
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

  constructor(private readonly ctx: PolicyContext) {
    this.cwd = cwdOf(ctx);
    this.seen.add(this.cwd);
  }

  split(src: string, depth: number): CommandPart[] {
    if (depth > MAX_NESTING) throw new TooDeep();
    const lexed = lexCommand(src);
    if (lexed.opaque.length > 0) return [this.part(src, 'unreadable')];
    const out: CommandPart[] = [];
    for (const command of lexed.commands) out.push(...this.simple(command, depth));
    return out;
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

  /** A body a shell runs: split one level deeper; a `cd` in it does not move the cwd outside. */
  private nested(body: string, depth: number): CommandPart[] {
    const saved = this.cwd;
    try {
      return this.split(body, depth + 1);
    } finally {
      this.cwd = saved;
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
      const target = command.words.slice(h + 1).find((w) => w === '-' || !w.startsWith('-'));
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
   * Whether `text` reaches outside the Steward's worktree (`ctx.cwd`; design §5.4a): it runs from
   * a cwd outside it, names a path outside it, or names a path that cannot be placed — judged
   * from every cwd the line has been at (`seen`), so it may flag a delete one time too many. The gate's
   * own path reading (`pathsInCommand`, `isInsideWorkspace`) with the worktree as the root.
   */
  outside(text: string): boolean {
    const root = cwdOf(this.ctx);
    const { paths, unresolvable } = pathsInCommand(text);
    if (unresolvable.length > 0) return true;
    return [...this.seen, this.cwd].some((cwd) => {
      const worktree: PolicyContext = { ...this.ctx, workspace: root, cwd };
      return (
        !isInsideWorkspace(cwd, worktree) || paths.some((p) => !isInsideWorkspace(p, worktree))
      );
    });
  }
}

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
