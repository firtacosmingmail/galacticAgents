import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  DEFAULT_PERMISSION_POLICY,
  type PermissionAction,
  type PermissionDecision,
  type PermissionPolicy,
  type RequestOrigin,
  type ToolCall,
} from '@galactic/protocol';
import { hostOfUrl, hostsOfCommand } from './hosts.js';

/**
 * The permission policy engine (SPEC §3.6, decision 7; P1-10).
 *
 * Pure functions, no I/O: a tool call an agent wants to make is classified into the action
 * categories of `PermissionAction`, and the project's policy (merged over the global default)
 * turns those into one decision. The strictest category wins (`deny` > `ask` > `allow`), so a
 * command that both installs a package and deletes files asks as long as either category asks.
 *
 * Anything the engine cannot classify — an unknown tool, a command it cannot read — gets the
 * policy's `unclassified` decision, `ask` unless the project says otherwise (a `trusted` project,
 * decision 49): the conservative behaviour the working agreements call for. A push stays visible
 * even inside an unreadable command (`mentionsPush`). An LLM never takes part in this.
 */

export interface PolicyContext {
  /** The project's workspace root; everything under it is "inside" (SPEC §3.5). */
  workspace: string;
  /** Where relative paths resolve from: the agent's cwd (its worktree). Defaults to `workspace`. */
  cwd?: string;
  /** `~` expands to this; defaults to the real home directory. */
  home?: string;
  /**
   * Other spellings of the workspace or cwd (dev-machine run, 2026-10-02): a path under `from` is
   * judged as the same path under `to`. The gate fills it with the resolved form of a symlinked
   * workspace (macOS `/var` → `/private/var`, a symlinked projects folder), because Claude Code
   * resolves its cwd and asks about resolved paths. The engine itself stays lexical.
   */
  aliases?: readonly { from: string; to: string }[];
  /**
   * Folders inside the workspace that belong to the user (P9-06; SPEC decisions 22, 122): the
   * project's `deliverables/` folder. A write or edit under one counts as outside the workspace,
   * like agent configuration, so an agent's own write there asks; reading it is a workspace read.
   * Absolute (or `~/`), compared lexically like everything here.
   */
  userFolders?: readonly string[];
}

/**
 * One reason the engine found, with the structure "Allow similar" needs (P14-02). Engine-internal:
 * not a wire type. Every action in `Classification.actions` has at least one finding; a finding
 * for a plain run or workspace read/edit has an empty `reason`/`part` (nothing to show).
 */
export interface Finding {
  action: PermissionAction;
  /** The shown part (the simple command's text, or `<tool> <path>`), as in today's reason lines. */
  part: string;
  /** The reason line, exactly as pushed to `reasons`. */
  reason: string;
  /** Index of the simple command in the line (commands only). */
  segment?: number;
  /** outside_workspace: the resolved path it reaches (absent when it cannot be told). */
  path?: string;
  /** network: the hosts visible in this part; absent or [] = not host-coverable. */
  hosts?: string[];
  /** The simple command's words and whether it redirects to a file (commands only). */
  words?: string[];
  redirects?: boolean;
  /** A write to guarded ground (`guardedWriteReason`): no rule ever covers it (P14). */
  guarded?: true;
  /**
   * Other reason lines of `reasons` this finding stands for: a second rule that reported the same
   * part and subject (`cd X` outside and leaving the workspace) adds no finding of its own.
   */
  merged?: string[];
}

export interface Classification {
  actions: PermissionAction[];
  /** One human-readable line per finding, for the permission card. */
  reasons: string[];
  /** The structured form of `reasons` (and of actions without a reason line). */
  findings: Finding[];
  /** Set for tools that only touch the agent's own bookkeeping: allowed whatever the policy. */
  alwaysAllow?: true;
  /**
   * Set when the engine could not classify all of the call — an unknown tool, an opaque command
   * (decision 49): the policy's `unclassified` decision joins those of `actions`, which then hold
   * only what could still be seen (a push mentioned inside an inline script, say).
   */
  unclassified?: true;
  /**
   * Set when the call writes agent or git configuration, or the user's deliverables folder
   * (decisions 22, 122): no "Allow similar" rule ever allows it (P9-17, decision 138).
   */
  guarded?: true;
}

export interface PolicyVerdict extends Classification {
  decision: PermissionDecision;
  /** The category that produced `decision` (the strictest one); absent when nothing was recognised. */
  dominant?: PermissionAction;
}

// ---------------------------------------------------------------------------
// Policy merge and decision
// ---------------------------------------------------------------------------

/**
 * The global default table (SPEC §3.6, decision 22): the SPEC's table unless the settings say
 * otherwise (P25-01, `defaultPermissionPolicy` in `config.json`). Process-wide on purpose: every
 * pure function here merges over it and floors at it, and a settings write applies to the next
 * tool call of every agent, like a project's table (decision 31). Set at startup and by
 * `PATCH /api/settings` only; tests that set it reset it.
 */
let globalDefault: PermissionPolicy = DEFAULT_PERMISSION_POLICY;

/** The global default table now (always complete: every category has a value). */
export function globalDefaultPolicy(): PermissionPolicy {
  return globalDefault;
}

/**
 * Replaces the global default: `policy` merged over the SPEC's table (a category it leaves out
 * keeps the SPEC's value), or the SPEC's table itself for `null`/`undefined`. Validation and the
 * remote floor (decision 37) are the caller's (`SettingsService`).
 */
export function setGlobalDefaultPolicy(policy: PermissionPolicy | null | undefined): void {
  if (!policy) {
    globalDefault = DEFAULT_PERMISSION_POLICY;
    return;
  }
  const unclassified = policy.unclassified ?? DEFAULT_PERMISSION_POLICY.unclassified;
  globalDefault = {
    rules: { ...DEFAULT_PERMISSION_POLICY.rules, ...policy.rules },
    ...(unclassified !== undefined ? { unclassified } : {}),
  };
}

/** The per-project policy over the global default: missing actions fall back to the default. */
export function resolvePolicy(override?: PermissionPolicy | null): PermissionPolicy {
  const unclassified = override?.unclassified ?? globalDefault.unclassified;
  return {
    rules: { ...globalDefault.rules, ...(override?.rules ?? {}) },
    ...(unclassified !== undefined ? { unclassified } : {}),
  };
}

/**
 * `policy` with no category looser than `floor` (default: the global table): per category the
 * stricter of the two (P2-04). What a remote client's choice of policy becomes unless the server
 * is configured to let remote clients set up auto-approvals (`autoApproveRemote`).
 */
export function noLooserThan(
  policy: PermissionPolicy,
  floor: PermissionPolicy = globalDefault,
): PermissionPolicy {
  const own = resolvePolicy(policy);
  const base = resolvePolicy(floor);
  const actions = new Set([
    ...Object.keys(own.rules),
    ...Object.keys(base.rules),
  ]) as Set<PermissionAction>;
  const unclassified =
    own.unclassified === undefined && base.unclassified === undefined
      ? undefined
      : strictest([own.unclassified ?? 'ask', base.unclassified ?? 'ask']);
  return {
    rules: Object.fromEntries(
      [...actions].map((a) => [a, strictest([own.rules[a], base.rules[a]])]),
    ),
    ...(unclassified !== undefined ? { unclassified } : {}),
  };
}

/**
 * How a policy write is judged (P2-21): where its request came from, and whether the server lets
 * remote clients set up auto-approvals (`autoApproveRemote`, TECHNOLOGY §8).
 */
export interface PolicyWrite {
  /** Absent: unknown, which counts as remote (fails closed). */
  origin?: RequestOrigin | undefined;
  autoApproveRemote?: boolean | undefined;
}

/**
 * The policy a write actually stores (P2-21): every `permissionPolicy` write — a project created
 * or edited through any command, REST route or brain tool, and the spawn presets of
 * `POST /api/agents` — goes through here. A local request, or any request on a server with
 * `autoApproveRemote`, keeps its policy; anything else (remote, or of unknown origin) is held to
 * the global default in every category (`noLooserThan`). Clearing a policy needs no floor: it
 * returns to the global default.
 */
export function policyForWrite(
  policy: PermissionPolicy,
  write: PolicyWrite = {},
): PermissionPolicy {
  if (write.origin === 'local' || write.autoApproveRemote) return policy;
  return noLooserThan(policy);
}

/**
 * The origin a brain's writes take when it acts on a turn's messages (P2-21): `local` only when
 * every message carries `origin: 'local'`; one remote or unknown message (an agent's or the
 * system's has none) makes the whole turn unknown, which policy writes treat as remote.
 */
export function originOfMessages(
  messages: readonly { origin?: RequestOrigin | undefined }[],
): RequestOrigin | undefined {
  if (messages.length === 0) return undefined;
  if (messages.every((m) => m.origin === 'local')) return 'local';
  return messages.some((m) => m.origin === 'remote') ? 'remote' : undefined;
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
export function ruleFor(policy: PermissionPolicy, action: PermissionAction): PermissionDecision {
  return asDecision(policy.rules[action]);
}

/**
 * The decision for a set of action categories under a policy. A call the engine could not fully
 * classify (`unclassified`; an empty set always is) also gets the policy's `unclassified`
 * decision — absent or unknown is `ask` (decision 49) — so nothing unrecognised is allowed
 * unless the project says so.
 */
export function decide(
  policy: PermissionPolicy,
  actions: PermissionAction[],
  unclassified = false,
): PermissionDecision {
  const merged = resolvePolicy(policy);
  const decisions: unknown[] = actions.map((a) => ruleFor(merged, a));
  if (unclassified || actions.length === 0) decisions.push(asDecision(merged.unclassified));
  return strictest(decisions);
}

/** Classifies the call and decides it under `policy` in one go. */
export function evaluate(
  policy: PermissionPolicy,
  call: ToolCall,
  ctx: PolicyContext,
): PolicyVerdict {
  const classification = classifyToolCall(call, ctx);
  if (classification.alwaysAllow) return { ...classification, decision: 'allow' };
  const decision = decide(policy, classification.actions, classification.unclassified === true);
  const merged = resolvePolicy(policy);
  const dominant = classification.actions.find((a) => ruleFor(merged, a) === decision);
  return { ...classification, decision, ...(dominant ? { dominant } : {}) };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Tools that only read the file system; their `path`-like inputs decide inside vs. outside. */
export const READ_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'NotebookRead',
]);
/** Tools that write files. */
export const EDIT_TOOLS: ReadonlySet<string> = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
]);
/**
 * Tools that reach the network by definition. `codex:network` is a Codex Steward asking for
 * network access in its sandbox (`item/permissions/requestApproval`, P11-04).
 */
const NETWORK_TOOLS = new Set(['WebFetch', 'WebSearch', 'codex:network']);
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
export const PATH_FIELDS = ['file_path', 'notebook_path', 'path', 'directory', 'cwd'];
/**
 * Fields that carry a glob, per tool (resolved from the tool's `path`, else the cwd). Grep's
 * `pattern` is a regular expression, not a location.
 */
export const GLOB_FIELDS: Record<string, string[]> = {
  Glob: ['pattern'],
  Grep: ['glob'],
};
export const DEFAULT_GLOB_FIELDS = ['pattern', 'glob'];

export function classifyToolCall(call: ToolCall, ctx: PolicyContext): Classification {
  const input = isRecord(call.input) ? call.input : {};
  const name = call.toolName;

  if (HARMLESS_TOOLS.has(name))
    return { actions: [], reasons: [], findings: [], alwaysAllow: true };
  if (NETWORK_TOOLS.has(name)) {
    const reason = `${name} reaches the network`;
    const host =
      name === 'WebFetch' && typeof input['url'] === 'string' ? hostOfUrl(input['url']) : undefined;
    return {
      actions: ['network'],
      reasons: [reason],
      findings: [
        { action: 'network', part: name, reason, ...(host !== undefined ? { hosts: [host] } : {}) },
      ],
    };
  }
  if (READ_TOOLS.has(name)) return classifyPaths(name, input, 'read_workspace', ctx);
  if (EDIT_TOOLS.has(name)) return classifyPaths(name, input, 'edit_workspace', ctx);
  if (name === 'Bash') {
    const command = typeof input['command'] === 'string' ? input['command'] : '';
    return classifyCommand(command, ctx);
  }
  // MCP tools of the user's own setup land here too: a `trusted` project allows them (decision 49)
  // — unless their input mentions a push, which still asks (the rule for opaque commands: an ACP
  // agent's `execute` whose command cannot be read lands here with its title and raw input).
  const reasons = [`unknown tool ${name}`];
  const pushes = mentionsPush(inputText(input));
  reasons.push(...pushes);
  const findings: Finding[] = pushes.map((reason) => ({
    action: 'push' as const,
    part: name,
    reason,
  }));
  return { actions: pushes.length ? ['push'] : [], reasons, findings, unclassified: true };
}

/** An unknown tool's input as text for `mentionsPush` (never throws). */
function inputText(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input) ?? '';
  } catch {
    return '';
  }
}

function classifyPaths(
  tool: string,
  input: Record<string, unknown>,
  inside: PermissionAction,
  ctx: PolicyContext,
): Classification {
  // A `paths` array (an ACP call that names several files) is judged path by path too.
  const listed = Array.isArray(input['paths']) ? (input['paths'] as unknown[]) : [];
  const paths = [...PATH_FIELDS.map((f) => input[f]), ...listed].filter(
    (v): v is string => typeof v === 'string',
  );
  const edit = inside === 'edit_workspace';
  // An edit tool that names no file cannot be placed: ask.
  if (edit && paths.length === 0) {
    return {
      actions: [],
      reasons: [`${tool} names no file path`],
      findings: [],
      unclassified: true,
    };
  }

  const reasons: string[] = [];
  const findings: Finding[] = [];
  const note = (part: string, reason: string, path?: string, guarded?: true) => {
    reasons.push(reason);
    findings.push({
      action: 'outside_workspace',
      part,
      reason,
      ...(path !== undefined ? { path } : {}),
      ...(guarded ? { guarded } : {}),
    });
  };
  let guarded = false;
  for (const p of paths) {
    // Guarded wherever the path is — inside the workspace or not (P9-17 review B1).
    const guard = edit ? guardedWriteReason(p, ctx) : undefined;
    if (guard) {
      note(
        `${tool} ${p}`,
        `${tool} on ${p}: ${guard}`,
        unalias(resolvePath(p, ctx, cwdOf(ctx)), ctx),
        true,
      );
      guarded = true;
    } else if (!isInsideWorkspace(p, ctx)) {
      note(
        `${tool} ${p}`,
        `${tool} on ${p}: outside the workspace`,
        unalias(resolvePath(p, ctx, cwdOf(ctx)), ctx),
      );
    }
  }
  const base = typeof input['path'] === 'string' ? input['path'] : undefined;
  const from = base !== undefined ? resolvePath(base, ctx, cwdOf(ctx)) : cwdOf(ctx);
  for (const f of GLOB_FIELDS[tool] ?? DEFAULT_GLOB_FIELDS) {
    const g = input[f];
    if (typeof g !== 'string') continue;
    const locations = globLocations(g);
    if (locations === null) {
      note(`${tool} ${g}`, `${tool} on ${g}: cannot tell where the pattern points`);
      continue;
    }
    if (locations.some((l) => !isInsideWorkspace(l, { ...ctx, cwd: from }))) {
      note(`${tool} ${g}`, `${tool} on ${g}: outside the workspace`);
    }
  }
  if (reasons.length === 0) {
    return { actions: [inside], reasons: [], findings: [{ action: inside, part: '', reason: '' }] };
  }
  return {
    actions: ['outside_workspace'],
    reasons,
    findings,
    ...(guarded ? { guarded: true } : {}),
  };
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
  /**
   * The bodies of the heredocs it reads, one after the other, as written (P13-02: for the judge's
   * command splitter only — the gate itself still treats a body as data).
   */
  heredocBody?: string;
}

export interface LexedLine {
  /** Every simple command, including those inside `$(…)`, backticks and `<(…)`. */
  commands: SimpleCommand[];
  /** Why the line cannot be read safely; non-empty means the line is opaque. */
  opaque: string[];
}

/** What a word holds where a command substitution was; it reads as an unexpandable variable. */
const SUBSTITUTION = '$()';
export const MAX_NESTING = 16;
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
  private heredocs: {
    delim: string;
    strip: boolean;
    expand: boolean;
    command: SimpleCommand;
  }[] = [];

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
    // Where an unquoted `)` operator ended: zsh reads a `(` right after it as glob qualifiers (R-m).
    let closedAt = -1;
    // Where the current word starts in the raw text, and where this loop step started.
    let wordStart = -1;
    let stepStart = start;

    const append = (text: string) => {
      if (word === null) wordStart = stepStart;
      word = (word ?? '') + text;
    };
    const flushWord = () => {
      if (word === null) return;
      if (pendingOp !== null) {
        cmd.redirects.push({ op: pendingOp, target: word });
        if (pendingOp === '<<' || pendingOp === '<<-') {
          this.heredocs.push({
            delim: word,
            strip: pendingOp === '<<-',
            expand: !quoted,
            command: cmd,
          });
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
      stepStart = i;
      // Only space and tab separate words: bash reads a carriage return as a word character.
      if (c === ' ' || c === '\t') {
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
          // A `~` (tilde expansion) or an `=` (zsh's =command) in the word part is unreadable;
          // only the assigning operator itself (`${x:=…}`, `${x=…}`) may hold an `=`.
          const inner = body.slice(2, -1);
          const operator = /^[A-Za-z_][A-Za-z0-9_]*:?=/.exec(inner)?.[0] ?? '';
          if (inner.includes('~') || inner.slice(operator.length).includes('='))
            return this.fail(`\${…} holding ~ or =: ${body}`);
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
      } else if (c === '<' && /^<\d*-\d*>/.test(src.slice(i))) {
        // zsh reads `<->`, `<1-10>` as numeric globs, not redirections: never readable (R-n).
        return this.fail(`zsh numeric glob: ${/^<\d*-\d*>/.exec(src.slice(i))![0]}`);
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
      } else if (c === '(' && word !== null && !/^\s*\)/.test(src.slice(i + 1))) {
        // zsh reads `word(…)` as glob qualifiers or modifiers (`a(:s/x/y/)` rewrites the path,
        // `a(e:'…':)` runs code): never readable (P14-03 review, ruling R-l). `name()` is a
        // function definition, read elsewhere.
        const close = src.indexOf(')', i + 1);
        return this.fail(
          `zsh glob qualifier or modifier: ${word}${src.slice(i, close < 0 ? src.length : close + 1)}`,
        );
      } else if (
        c === '(' &&
        (i === closedAt ||
          (!/^\s*\)/.test(src.slice(i + 1)) &&
            (pendingOp !== null ||
              cmd.redirects.length > 0 ||
              cmd.words.some((w) => !COMMAND_POSITION_WORDS.has(w)))))
      ) {
        // Outside command position zsh reads `(…)` as a glob group (`cat (a|b)`) and a `(` right
        // after a `)` as glob qualifiers (`(*)(e:'…':)` runs code): never readable (P14-03
        // review, ruling R-m). `name ()` stays a function definition, read elsewhere.
        const close = src.indexOf(')', i + 1);
        return this.fail(
          `zsh glob group or qualifier: ${src.slice(i, close < 0 ? src.length : close + 1)}`,
        );
      } else if (c === '(') {
        flushCommand(false);
        depth++;
        i++;
      } else if (c === ')') {
        flushCommand(false);
        i++;
        closedAt = i;
        if (depth === 0 && nested) return i;
        if (depth > 0) depth--;
      } else if (
        // `{` and `}` are reserved only in command position, as in bash: before any word or
        // redirection of the simple command, or right after reserved words that put the next
        // word in command position (`time {`, `then {`). Elsewhere they are ordinary arguments.
        (c === '{' || c === '}') &&
        word === null &&
        pendingOp === null &&
        cmd.words.every((w) => COMMAND_POSITION_WORDS.has(w)) &&
        cmd.redirects.length === 0 &&
        isWordEnd(next)
      ) {
        flushCommand(false);
        i++;
      } else if (
        c === '=' &&
        !(word === null && isWordEnd(next)) &&
        (word === null || !/^[A-Za-z0-9_./:@%+-]+$/.test(src.slice(wordStart, i)))
      ) {
        // zsh expands an unquoted `=cmd` to the command's path (`=node`), also after quotes,
        // expansions and brace alternatives (`''=ls`, `$x=git`, `{x,''=ls}`): an `=` is readable
        // only after plain literal characters (`--color=auto`, R-l, R-m, R-n). A lone `=` names
        // no command and stays as it is (`test a = b`).
        let end = i + 1;
        while (end < src.length && !/[\s;&|<>()]/.test(src[end]!)) end++;
        return this.fail(`zsh =command expansion: ${src.slice(i, end)}`);
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
      h.command.heredocBody = (h.command.heredocBody ?? '') + body;
      // An unquoted delimiter expands the body: a substitution there would run.
      if (h.expand && /`|\$\(/.test(body)) this.opaque.push('heredoc body runs a substitution');
    }
    return i;
  }
}

/** Reserved words after which the next word is again in command position. */
const COMMAND_POSITION_WORDS: ReadonlySet<string> = new Set([
  'then',
  'do',
  'else',
  'elif',
  'if',
  'while',
  'until',
  '!',
  'time',
  'coproc',
]);

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
 * skipped, with their options, to find the command's real name. zsh's precommand modifiers
 * `noglob`, `nocorrect` and `-` too (P14-08: `noglob cd /tmp/x` enters /tmp/x).
 */
const WRAPPERS = new Set([
  'noglob',
  'nocorrect',
  '-',
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
  // `-iC dir` (a cluster ending in a value option) and the long forms take the next word too.
  env: /^(?:-[A-Za-z]*[uCS]|--chdir|--unset|--split-string)$/,
};

/**
 * An assignment word: `NAME=`, zsh's and bash's `NAME+=`, `NAME[...]=`, `NAME[...]+=`. In front of
 * a command each of them sets the command's environment (P14-08 review C-1: `GIT_DIR+=x git …`
 * is `GIT_DIR=x` when the variable is unset).
 */
export const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;

/**
 * The folders `env` moves its program to, in order (P14-08 review I-3): `-C <dir>`, `-C<dir>`,
 * a cluster ending in `C` (`-iC <dir>`), `--chdir <dir>`, `--chdir=<dir>` — among the options of
 * an `env` word in the command's wrapper chain (`nice env -C d cmd` too).
 */
function envChdirs(words: readonly string[]): string[] {
  const h = commandHead([...words]);
  const out: string[] = [];
  let inEnv = false;
  for (let k = 0; k < h; k++) {
    const w = words[k]!;
    if (!w.startsWith('-')) {
      inEnv = baseName(w) === 'env';
      continue;
    }
    if (!inEnv) continue;
    const long = /^--chdir(?:=(.*))?$/.exec(w);
    const short = /^-[A-Za-z]*C(.*)$/.exec(w);
    if (!long && !short) continue;
    const glued = long ? long[1] : short![1];
    if (glued !== undefined && glued !== '') out.push(glued);
    else if (k + 1 < h) out.push(words[++k]!);
  }
  return out;
}

/**
 * Whether an `env` word anywhere in the command splits a string into a new command line (P14-08
 * review N-1): `-S <s>`, `-S<s>`, a cluster reaching `S` (`-iS<s>`), `--split-string[=<s>]` and its
 * prefixes (`--sp=…`), among env's options and assignments (`env X=1 -S…` too: fail closed). The
 * packed line, its program, its assignments and its `-C` are never read, so it is unreadable.
 */
export function envSplitsString(words: readonly string[]): boolean {
  for (let i = 0; i < words.length; i++) {
    if (baseName(words[i]!) !== 'env') continue;
    for (let k = i + 1; k < words.length; k++) {
      const w = words[k]!;
      if (w.startsWith('--')) {
        const name = w.slice(2).split('=')[0]!;
        if (name !== '' && 'split-string'.startsWith(name)) return true;
        if (w === '--chdir' || w === '--unset') k++;
        continue;
      }
      if (w.length > 1 && w.startsWith('-')) {
        const letters = /^-([A-Za-z0-9]*)/.exec(w)![1]!;
        // The cluster's letters up to the first one that takes a value (`-iS…`, `-uX`).
        const m = /^[^uCPS]*([uCPS])?/.exec(letters)!;
        if (m[1] === 'S') return true;
        if (m[1] !== undefined && m[0].length === w.length - 1) k++; // its value is the next word
        continue;
      }
      if (!w.includes('=')) break; // env's program: its own options are its own
    }
  }
  return false;
}

/** Index of the command's real name in `words`, past assignments and wrappers. */
export function commandHead(words: string[]): number {
  let k = 0;
  while (k < words.length) {
    const w = words[k]!;
    // Assignments and reserved words that put the next word in command position (R-h).
    if (ASSIGNMENT_WORD.test(w) || (COMMAND_POSITION_WORDS.has(w) && w !== 'time')) {
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
      } else if (name === 'env' && opt.includes('=')) {
        // env sets any `x=y` it is given, whatever the name (`env 'A B=1' cmd`).
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
export const INTERPRETER = new RegExp(
  `^(?:sh|bash|zsh|dash|fish|ksh|csh|tcsh|ash|${PYTHON}|pypy[0-9.]*|node|nodejs|bun|deno|perl|ruby|irb|php|lua|luajit|rscript|osascript|tclsh|groovy|jshell)$`,
);
export const SHELLS = /^(?:sh|bash|zsh|dash|fish|ksh|csh|tcsh|ash)$/;
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
export const HARMLESS_DEVICES: ReadonlySet<string> = new Set([
  '/dev/null',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/stdin',
  '/dev/tty',
]);

/**
 * Bash builtins and reserved words. External programs cannot change the shell's state; only
 * builtins, keywords and assignments can (ruling R-g).
 */
const SHELL_BUILTINS = new Set([
  'alias',
  'bg',
  'bind',
  'break',
  'builtin',
  'caller',
  'cd',
  'command',
  'compgen',
  'complete',
  'compopt',
  'continue',
  'declare',
  'dirs',
  'disown',
  'echo',
  'enable',
  'eval',
  'exec',
  'exit',
  'export',
  'false',
  'fc',
  'fg',
  'getopts',
  'hash',
  'help',
  'history',
  'jobs',
  'kill',
  'let',
  'local',
  'logout',
  'mapfile',
  'popd',
  'printf',
  'pushd',
  'pwd',
  'read',
  'readarray',
  'readonly',
  'return',
  'set',
  'shift',
  'shopt',
  'source',
  'suspend',
  'test',
  'times',
  'trap',
  'true',
  'type',
  'typeset',
  'ulimit',
  'umask',
  'unalias',
  'unset',
  'wait',
  '.',
  ':',
  '[',
  // Reserved words: they prefix or wrap other commands, so the next word is not the program.
  'function',
  'coproc',
  'time',
  '!',
  '[[',
  '((',
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'do',
  'done',
  'while',
  'until',
  'for',
  'case',
  'esac',
  'select',
  'in',
  '{',
  '}',
  // Not a builtin, but it runs its arguments as a command with a changed environment.
  'env',
  // zsh (the user's shell may be zsh): builtins and keywords that change options, functions,
  // variables or what runs (P14-03 review, ruling R-k).
  'setopt',
  'unsetopt',
  'emulate',
  'zmodload',
  'autoload',
  'bindkey',
  'functions',
  'unfunction',
  'integer',
  'float',
  'noglob',
  'nocorrect',
  'repeat',
  'foreach',
  'zstyle',
  'zparseopts',
  'disable',
  'unhash',
  'vared',
  'sched',
  'zle',
  'limit',
  'unlimit',
  // zsh's precommand modifier `- cmd` (runs cmd as a login command).
  '-',
]);
/** Builtins that cannot change what a later command's network destination is. */
const STATE_SAFE_BUILTINS = new Set([
  'cd',
  'chdir',
  'print',
  'pushd',
  'popd',
  'echo',
  'true',
  'false',
  'test',
  '[',
  'pwd',
  ':',
  'printf',
]);
/** `NAME=value` or `NAME+=value`: a prefix assignment (no subscript). */
const PREFIX_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
/** The variable an assignment word sets. */
function assignedName(word: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*/.exec(word)?.[0] ?? '';
}
/**
 * Which prefix assignments (`NAME=value` before `program` in the same simple command) a caller
 * does not count as a change of shell state (P14-07, ruling F-2).
 */
export type PrefixAssignmentOk = (name: string, program: string) => boolean;

/**
 * Prefix assignments that cannot make a program run other code or read other configuration
 * (P14-08): a token, the locale, the time zone, colour switches, `CI`. An allow-list: a variable
 * not named here (`GIT_EXTERNAL_DIFF`, `GIT_PAGER`, `EDITOR`, `LD_PRELOAD`, `XDG_CONFIG_HOME`,
 * `PS4`, … and `TERM`, which picks a terminfo entry) may run or load something.
 */
const INERT_PREFIX = /^(?:GH_TOKEN|GITHUB_TOKEN|LANG|LC_[A-Z]+|TZ|NO_COLOR|FORCE_COLOR|CI)$/;

/**
 * Folder rules (ruling F-2a, P14-08): a prefix assignment of an inert variable (`INERT_PREFIX`,
 * case-sensitive) sets the program's environment only — unless the program changes the directory.
 * Any other prefix assignment counts as a change of state: the line is never folder-covered.
 */
export const FOLDER_PREFIX_OK: PrefixAssignmentOk = (name, program) =>
  !['cd', 'pushd', 'chdir', 'popd'].includes(program.toLowerCase()) && INERT_PREFIX.test(name);

/**
 * Whether a simple command sets a variable that is not inert (`INERT_PREFIX`) other than by a
 * leading prefix assignment (P14-08 review I-1): an assignment word in its wrapper chain (`sudo
 * X=1 cmd`, `nice env X=1 cmd`, `timeout 5 env X+=1 cmd`), or any `x=y` word after an `env` word
 * anywhere (fail closed: env sets whatever it is given). Leading assignments are judged by
 * `changesShellState` with `FOLDER_PREFIX_OK`.
 */
export function wrapperSetsEnv(words: readonly string[]): boolean {
  const h = commandHead([...words]);
  let lead = 0;
  while (lead < words.length && ASSIGNMENT_WORD.test(words[lead]!)) lead++;
  const envAt = words.findIndex((w) => baseName(w) === 'env');
  return words.some((w, i) => {
    if (i < lead) return false;
    const inChain = i < h && ASSIGNMENT_WORD.test(w);
    const afterEnv = envAt >= 0 && i > envAt && !w.startsWith('-') && w.includes('=');
    return (inChain || afterEnv) && !INERT_PREFIX.test(w.slice(0, w.search(/\+?=/)));
  });
}

/** Visible hosts (ruling F-2b): gh's token does not route, so `GH_TOKEN=… gh …` keeps its host. */
export const HOSTS_PREFIX_OK: PrefixAssignmentOk = (name, program) =>
  (name === 'GH_TOKEN' || name === 'GITHUB_TOKEN') && program === 'gh';

/** A word the shell could expand into another word (a builtin's name, for one). */
const EXPANDABLE = /[$`{}*?[\]~\\]/;
/** `${NAME:=…}`, `${NAME=…}` and friends assign while they expand. */
const ASSIGNING_EXPANSION = /\$\{[^}]*=/;

/**
 * Whether a simple command may change the shell's state (variables, functions, traps, hashed
 * paths, options) that a later command's destination could depend on. An allowlist (ruling
 * R-g): false only with no assignment word, no assigning expansion, and a program word that is
 * an external program or one of the safe builtins (`printf` only without `-v…`).
 */
function changesShellState(simple: SimpleCommand, prefixOk?: PrefixAssignmentOk): boolean {
  const { words } = simple;
  const texts = [...words, ...simple.redirects.map((r) => r.target), simple.heredocBody ?? ''];
  if (texts.some((w) => ASSIGNING_EXPANSION.test(w))) return true;
  // Prefix assignments (`NAME=value program …`) the caller accepts are not a change of state:
  // they set the program's environment only. Standalone ones (no program after them) still are.
  let k = 0;
  while (prefixOk && k < words.length && PREFIX_ASSIGNMENT.test(words[k]!)) k++;
  const after = words[k];
  const accepted =
    k > 0 &&
    after !== undefined &&
    words.slice(0, k).every((w) => prefixOk!(assignedName(w), after));
  const program = words[accepted ? k : 0];
  if (program === undefined) return false;
  if (STATE_SAFE_BUILTINS.has(program)) {
    if (program === 'printf') return words.some((w) => w.startsWith('-v'));
    // zsh's print: `-v` assigns, `-z` pushes onto the editing buffer, `-s`/`-S` onto the history.
    if (program === 'print') return words.slice(1).some((w) => /^-[A-Za-z]*[vzsS]/.test(w));
    return false;
  }
  return ASSIGNMENT_WORD.test(program) || EXPANDABLE.test(program) || SHELL_BUILTINS.has(program);
}

/**
 * Whether a command line may change the shell's state anywhere (ruling R-g): a simple command
 * that does (`changesShellState`), a function definition, or arithmetic (`(( X = 1 ))`, `$[X=1]`).
 * The lexer drops a function definition's parentheses, so those two are read from the text —
 * joined as bash joins it first: a backslash-newline is removed before words are split (`(\⏎(`).
 * Shared by visible hosts and by folder rules (P14-03, ruling R-k).
 */
export function lineChangesShellState(
  command: string,
  lexed: ReturnType<typeof lexCommand> = lexCommand(command.trim()),
  prefixOk?: PrefixAssignmentOk,
): boolean {
  const joined = command.trim().replace(/\\\n/g, '');
  return (
    lexed.commands.some((c) => changesShellState(c, prefixOk)) ||
    /[A-Za-z_][\w-]*\s*\(\s*\)|\bfunction\s/.test(joined) ||
    /\(\(|\$\[/.test(joined)
  );
}

export function classifyCommand(command: string, ctx: PolicyContext): Classification {
  const actions = new Set<PermissionAction>();
  const reasons: string[] = [];
  const findings: Finding[] = [];
  const note = (action: PermissionAction | undefined, reason: string, extra: Partial<Finding>) => {
    reasons.push(reason);
    if (action === undefined) return;
    actions.add(action);
    const finding: Finding = { action, part: '', reason, ...extra };
    // One row per distinct reason: the same rule matching twice in a part adds no second finding.
    const same = (f: Finding) =>
      f.action === finding.action &&
      f.part === finding.part &&
      f.segment === finding.segment &&
      f.path === finding.path &&
      JSON.stringify(f.hosts) === JSON.stringify(finding.hosts);
    const existing = findings.find(same);
    if (!existing) findings.push(finding);
    else {
      if (existing.reason !== reason) (existing.merged ??= []).push(reason);
      if (finding.guarded) existing.guarded = true;
    }
  };
  let guarded = false;
  const trimmed = command.trim();
  if (trimmed === '') {
    return { actions: [], reasons: ['empty command'], findings: [], unclassified: true };
  }

  const lexed = lexCommand(trimmed);
  let opaque = lexed.opaque.length > 0;
  for (const why of lexed.opaque) reasons.push(`cannot read the command safely: ${why}`);

  // `cd` changes where the later segments resolve relative paths from.
  let cwd = cwdOf(ctx);
  // Variables set anywhere in the line (export, an assignment segment, ...) can redirect any
  // command's network destination: no host is then visible (ruling R-d).
  const lineSetsEnv = lineChangesShellState(trimmed, lexed, HOSTS_PREFIX_OK);

  for (const [segment, simple] of lexed.commands.entries()) {
    const here: PolicyContext = { ...ctx, cwd };
    const text = simple.words.join(' ');
    const shown = text || simple.redirects.map((r) => `${r.op}${r.target}`).join(' ');
    const redirectsToFile = simple.redirects.some((r) => WRITE_REDIRECTS.has(r.op));
    // The resolved place a path token reaches from this segment's cwd; none for a glob.
    const placeOf = (token: string, at: PolicyContext = here): Partial<Finding> =>
      /[*?[]/.test(token) ? {} : { path: unalias(resolvePath(token, at, at.cwd!), at) };
    const seg = (extra: Partial<Finding> = {}): Partial<Finding> => ({
      part: shown,
      segment,
      words: simple.words,
      redirects: redirectsToFile,
      ...extra,
    });
    for (const rule of OPAQUE_RULES) {
      if (rule.pattern.test(text)) {
        opaque = true;
        reasons.push(`${rule.reason}: ${shown}`);
      }
    }
    if (envSplitsString(simple.words)) {
      opaque = true;
      reasons.push(`env -S runs a command line the engine cannot read: ${shown}`);
    }
    const hidden = hiddenProgram(simple);
    if (hidden) {
      opaque = true;
      reasons.push(`${hidden}: ${shown}`);
    }
    const scanned = [text, ...simple.redirects.map((r) => r.target)].join(' ');
    for (const rule of ALL_RULES) {
      if (rule.pattern.test(scanned)) {
        const hosts =
          rule.action === 'network'
            ? hostsOfCommand(simple.words, {
                lineSetsEnv,
                hasRedirect: simple.redirects.length > 0,
              })
            : undefined;
        note(rule.action, `${rule.reason}: ${shown}`, seg(hosts ? { hosts } : {}));
      }
    }
    // `env -C <dir>` runs the program in <dir> (P14-08 review I-3): the folder is judged like a
    // `cd`'s, and the command's paths from there AND from the shell's cwd (its redirections
    // open there; fail closed). A folder the engine cannot place is guarded: it always asks.
    let envCwd: string | undefined;
    for (const dir of envChdirs(simple.words)) {
      if (/[$`]/.test(dir) || /^~[^/]/.test(dir)) {
        guarded = true;
        note(
          'outside_workspace',
          `env -C ${dir}: cannot tell where it leads`,
          seg({ guarded: true }),
        );
        continue;
      }
      envCwd = resolvePath(dir, ctx, envCwd ?? cwd);
      if (!isInsideWorkspace(envCwd, ctx)) {
        note(
          'outside_workspace',
          `env -C ${dir}: runs outside the workspace`,
          seg({ path: unalias(envCwd, ctx) }),
        );
      }
      const why = guardedWriteReason(envCwd, ctx);
      if (why) {
        guarded = true;
        note(
          'outside_workspace',
          `${dir}: ${why}`,
          seg({ path: unalias(envCwd, ctx), guarded: true }),
        );
      }
    }
    const places: PolicyContext[] = envCwd === undefined ? [here] : [here, { ...ctx, cwd: envCwd }];
    const { paths, unresolvable, clustered } = pathsOf(simple);
    for (const at of places) {
      for (const p of paths) {
        if (!isInsideWorkspace(p, at)) {
          note('outside_workspace', `${p}: outside the workspace`, seg(placeOf(p, at)));
        }
      }
      for (const c of clustered) {
        if (!isInsideWorkspace(c.path, at)) {
          note('outside_workspace', `${c.shown}: cannot tell where it points`, seg());
        }
      }
    }
    for (const p of unresolvable) {
      note('outside_workspace', `${p}: cannot tell where it points`, seg());
    }
    // The card names every file curl sends, inside the workspace too (`.env`): P9-17 review S2.
    for (const f of curlUploads(simple.words)) reasons.push(`curl reads and sends the file ${f}`);
    for (const at of places) {
      for (const g of guardedTargets(simple, at)) {
        guarded = true;
        note(
          'outside_workspace',
          `${g.path}: ${g.reason}`,
          seg({ ...placeOf(g.path, at), guarded: true }),
        );
      }
    }

    const h = commandHead(simple.words);
    const name = simple.words[h]?.toLowerCase();
    // zsh's `chdir` is `cd` (P14-03 review, ruling R-l).
    if (name === 'cd' || name === 'pushd' || name === 'chdir') {
      const args = simple.words.slice(h + 1).filter((w) => w !== '--');
      const operands = args.filter((w) => w === '-' || !/^-[A-Za-z]+$/.test(w));
      const target = operands[0];
      let cdResolved = true;
      // zsh's `cd old new` (replace in the cwd) and the stack (`-`, `+N`, `-N`): unknown.
      const unknown =
        operands.length > 1 || (target !== undefined && /^(?:-|[+-]\d+)$/.test(target));
      if (!unknown && (target === undefined || target === '' || target === '~')) {
        cwd = ctx.home ?? homedir();
      } else if (unknown || unresolvable.length > 0 || /[$`]/.test(target ?? '')) {
        cdResolved = false;
        note('outside_workspace', `cd ${target}: cannot tell where it leads`, seg());
      } else {
        cwd = resolvePath(target ?? '', ctx, cwd);
      }
      if (!isInsideWorkspace(cwd, ctx)) {
        note(
          'outside_workspace',
          `${shown}: leaves the workspace`,
          seg(cdResolved ? { path: unalias(cwd, ctx) } : {}),
        );
      }
    }
  }
  if (opaque) {
    // What the engine saw still counts; a push hidden in the unreadable part is looked for in
    // the raw text (decision 49), so a trusted project still asks before anything leaves.
    for (const why of mentionsPush(trimmed)) {
      note('push', why, { part: why });
    }
    return {
      actions: [...actions],
      reasons,
      findings,
      unclassified: true,
      ...(guarded ? { guarded: true as const } : {}),
    };
  }
  if (actions.size === 0) {
    actions.add('run_workspace');
    findings.push({ action: 'run_workspace', part: '', reason: '' });
  }
  return {
    actions: [...actions],
    reasons,
    findings,
    ...(guarded ? { guarded: true as const } : {}),
  };
}

/** `git`, then — anywhere later in the text — `push` as a word (`git-push`, `'git','push'` too). */
const GIT_PUSH = /\bgit\b[\s\S]*?\bpush\b/i;

/**
 * Why the raw text of an opaque command may push (decision 49): `git` followed anywhere later by
 * `push` — across quotes, `sh -c "…"`, inline scripts, heredoc bodies and newlines, so
 * `python - <<EOF … subprocess.run(['git', 'push']) … EOF` counts — and the push rules (`npm
 * publish`, `gh pr create`, `scp host:…`, …) over the text with quotes and backslashes removed.
 * Deliberately over-eager (`git log; echo push` counts too: one card too many). It cannot see a
 * push that is computed (`"gi"+"t"`), encoded or kept in a script file the command runs.
 */
export function mentionsPush(text: string): string[] {
  const bare = text.replace(/["'`\\]/g, '');
  const out: string[] = [];
  if (GIT_PUSH.test(text) || GIT_PUSH.test(bare)) {
    out.push('the command mentions git push, which leaves the machine');
  }
  for (const rule of PUSH_RULES) {
    if (rule.action === 'push' && !rule.reason.startsWith('git push') && rule.pattern.test(bare)) {
      out.push(`${rule.reason} (inside an opaque command)`);
    }
  }
  return out;
}

/** Why a write to agent or git configuration asks (decisions 22, 122). */
const CONFIG_REASON = 'agent or git configuration, which runs outside the gate';

/** Why a write under a user folder asks (P9-06). */
const USER_FOLDER_REASON =
  "the project's deliverables folder, which belongs to the user (only the server copies into it)";

/** Why a write to the user's own start-up, login or key files asks (P9-17 review B1). */
const USER_SETUP_REASON =
  "the user's shell start-up files, login items, SSH or git configuration, which run outside the gate";

/**
 * Files in the home folder whose contents run as the user outside the gate (P9-17 review B1):
 * shell start-up files, git's and Claude Code's own configuration. Compared case-folded (APFS
 * is case-insensitive by default).
 */
const HOME_GUARDED_FILES = [
  '.zshrc',
  '.zprofile',
  '.zshenv',
  '.zlogin',
  '.zlogout',
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.bash_logout',
  '.profile',
  '.gitconfig',
  '.claude.json',
];
/** Folders in the home folder that are guarded with everything below them. */
const HOME_GUARDED_TREES = ['Library/LaunchAgents', '.ssh', '.config/git'];
/** Folders of the machine that are guarded with everything below them. */
const SYSTEM_GUARDED_TREES = ['/Library/LaunchAgents', '/Library/LaunchDaemons'];

/**
 * Why writing `p` always asks — no "Allow similar" rule may ever allow it (P9-17, decision 138;
 * review B1) — or `undefined`. Judged wherever `p` is, inside the workspace or not: agent or git
 * configuration (`isAgentConfigPath`), the project's deliverables folder (`isUserFolderPath`),
 * the user's shell start-up files, login items (`~/Library/LaunchAgents`, `/Library/Launch*`),
 * `~/.ssh`, `~/.gitconfig` and `~/.config/git`, and someone else's home (`~user`).
 */
export function guardedWriteReason(p: string, ctx: PolicyContext): string | undefined {
  if (/^~[^/]/.test(p)) return "someone else's home folder";
  if (isAgentConfigPath(p, ctx)) return CONFIG_REASON;
  if (isUserFolderPath(p, ctx)) return USER_FOLDER_REASON;
  const fold = (q: string) => q.normalize('NFC').toLowerCase();
  const raw = resolvePath(p, ctx, cwdOf(ctx));
  const targets = [...new Set([raw, unalias(raw, ctx)])].map(fold);
  const home = fold(resolve(expandHome('~', ctx)));
  for (const t of targets) {
    if (HOME_GUARDED_FILES.some((f) => t === join(home, f))) return USER_SETUP_REASON;
    if (HOME_GUARDED_TREES.some((d) => within(fold(join(home, d)), t))) return USER_SETUP_REASON;
    if (SYSTEM_GUARDED_TREES.some((d) => within(fold(d), t))) return USER_SETUP_REASON;
  }
  return undefined;
}

/** A word as a path: `$HOME`/`${HOME}` read as `~`, `$PWD` as `.` (as `pathToken` does). */
function asPathWord(word: string): string {
  return word.replace(/^\$\{?HOME\}?(?=\/|$)/, '~').replace(/^\$\{?PWD\}?(?=\/|$)/, '.');
}

/**
 * What a simple command may write that always asks (`guardedWriteReason`): its write
 * redirections' targets and, unless the command only reads, every argument (an option's value
 * too). Plain words count (`cp out.pdf deliverables/`): they resolve from the command's cwd.
 */
function guardedTargets(
  command: SimpleCommand,
  ctx: PolicyContext,
): { path: string; reason: string }[] {
  const candidates = command.redirects
    .filter((r) => WRITE_REDIRECTS.has(r.op))
    .map((r) => r.target);
  const h = commandHead(command.words);
  // A leading assignment's value is a place the program may write, whatever it is
  // (`GIT_DIR=.git/hooks git status`, `GIT_TRACE=.git/hooks/x git log`: P14-08).
  for (const w of command.words.slice(0, h)) {
    if (ASSIGNMENT_WORD.test(w)) candidates.push(...assignedPaths(w));
  }
  const name = command.words[h] !== undefined ? baseName(command.words[h]) : undefined;
  if (name !== undefined && !READ_ONLY_COMMANDS.has(name)) {
    for (const w of command.words.slice(h + 1)) {
      // Each comma part too (`-Wl,-o,.git/hooks/x`): fail closed for any program.
      for (const part of w.includes(',') ? [w, ...w.split(',')] : [w]) {
        const values = part.startsWith('-') ? optionValues(part) : [];
        candidates.push(...(values.length > 0 ? values.map((v) => v.value) : [part]));
      }
      if (ASSIGNMENT_WORD.test(w)) candidates.push(...assignedPaths(w));
    }
  }
  const out: { path: string; reason: string }[] = [];
  for (const c of candidates) {
    for (const alt of expandBraces(c) ?? [c]) {
      const word = asPathWord(alt);
      if (word === '' || /[$`]/.test(word) || HARMLESS_DEVICES.has(word)) continue;
      const reason = guardedWriteReason(word, ctx);
      if (reason) {
        out.push({ path: alt, reason });
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
  /**
   * Paths only a cluster reading of an option word gives (`-ro/x`: `-r -o /x`; P14-08 review
   * I-4), with the word they come from: one outside the workspace cannot be placed (it asks, with
   * no folder row); one inside is nothing.
   */
  clustered: { path: string; shown: string }[];
}

/**
 * Path-looking tokens of a shell line. Option values (`--out=/tmp/x`) and redirection targets
 * count too; braces are expanded. Plain words are not paths, so `ls foo` never escapes; `ls
 * ../foo` is checked. `$HOME` and `$PWD` are expanded; any other `$VAR` or substitution inside
 * a path-like token makes it unresolvable, and so does `~user`.
 */
export function pathsInCommand(command: string): Omit<CommandPaths, 'clustered'> {
  const out: Omit<CommandPaths, 'clustered'> = { paths: [], unresolvable: [] };
  for (const c of lexCommand(command).commands) {
    const p = pathsOf(c);
    // A caller that only reads `paths` judges the cluster readings too (fail closed).
    out.paths.push(...p.paths, ...p.clustered.map((x) => x.path));
    out.unresolvable.push(...p.unresolvable);
  }
  return out;
}

/**
 * Programs whose single-dash options never cluster (`gcc -Iinclude/x` is `include/x`, not `-I -i
 * …`): only the value after the first letter counts (P14-08 review I-4).
 */
const NON_CLUSTERING = new Set([
  'cc',
  'c++',
  'gcc',
  'g++',
  'clang',
  'clang++',
  'ld',
  'javac',
  'swiftc',
  'rustc',
]);
/**
 * The compilers' multi-letter single-dash options with a glued path (`-isystem/usr/x`, `-MF/x`,
 * `-dumpdir/x`: P14-08 review N-2). Longer names first. Options with `=` (`-specs=`,
 * `-fprofile-use=`, `--output=`) and one-letter ones (`-o`, `-B`) are read by `optionValues`.
 */
const COMPILER_PATH_OPTION =
  /^-(?:isystem|iquote|idirafter|imacros|include|iprefix|iwithprefixbefore|iwithprefix|isysroot|iframework|imultilib|MF|MJ|dumpdir|dumpbase-ext|dumpbase)(.+)$/;
/** An option that hands its comma-separated parts to the linker, assembler or preprocessor. */
const PASS_THROUGH_OPTION = /^-W[alp],/;

function pathsOf(command: SimpleCommand): CommandPaths {
  const out: CommandPaths = { paths: [], unresolvable: [], clustered: [] };
  const head = command.words[commandHead(command.words)];
  const clusters = head === undefined || !NON_CLUSTERING.has(baseName(head));
  const add = (word: string, isTarget: boolean) => {
    for (const alt of expandBraces(word) ?? [word]) pathToken(alt, isTarget, out, word, clusters);
  };
  for (const w of command.words) {
    const long = clusters ? undefined : COMPILER_PATH_OPTION.exec(w)?.[1];
    if (long !== undefined) add(long, false);
    // `-Wl,-o,/x`: each part is a word of its own (P14-08 review N-2).
    if (PASS_THROUGH_OPTION.test(w)) for (const part of w.split(',').slice(1)) add(part, false);
    add(w, false);
    // An assignment's value may name a path (`GIT_WORK_TREE=/x git …`, `make DESTDIR=/x`, `dd
    // of=/x`), a list of them (`PYTHONPATH=a:/x`) too (P14-07).
    if (ASSIGNMENT_WORD.test(w)) for (const part of assignedPaths(w)) add(part, false);
  }
  // A file curl reads and sends is a read target, wherever it is (P9-17 review S2).
  for (const f of curlUploads(command.words)) add(f, true);
  for (const r of command.redirects) {
    if (r.op === '<<' || r.op === '<<-' || r.op === '<<<') continue; // delimiter / string, not a file
    if ((r.op === '>&' || r.op === '<&') && /^(?:\d+-?|-)$/.test(r.target)) continue; // fd dup
    add(r.target, true);
  }
  return out;
}

/** curl options whose value names a file to send when it starts with `@` (`-d @body.json`). */
const CURL_AT_DATA = new Set(['-d', '--data', '--data-binary', '--data-ascii', '--json']);
/** curl options whose value is `name@file` or `@file` (`--data-urlencode`). */
const CURL_URLENCODE = new Set(['--data-urlencode']);
/** curl options whose value is a form field, `name=@file` or `name=<file` (`-F`). */
const CURL_FORM = new Set(['-F', '--form']);
/** curl options whose value is a file it reads (`-T file`, `-K config`). */
const CURL_FILE = new Set(['-T', '--upload-file', '-K', '--config']);
const CURL_VALUE_OPTS = [...CURL_AT_DATA, ...CURL_URLENCODE, ...CURL_FORM, ...CURL_FILE];

/**
 * The files a curl command reads and sends (P9-17 review S2): `-d/--data/--data-binary/
 * --data-ascii/--json @file`, `--data-urlencode [name]@file`, `-F/--form name=@file` or
 * `name=<file`, `-T/--upload-file file`, `-K/--config file` — the value glued (`-d@f`,
 * `--data=@f`) or as the next word. `-` (stdin) is not a file. Other commands: none.
 */
export function curlUploads(words: readonly string[]): string[] {
  const h = commandHead([...words]);
  if (h >= words.length || baseName(words[h]!) !== 'curl') return [];
  const out: string[] = [];
  const take = (opt: string, value: string) => {
    let file: string | undefined;
    if (CURL_AT_DATA.has(opt)) file = value.startsWith('@') ? value.slice(1) : undefined;
    else if (CURL_URLENCODE.has(opt)) {
      const at = value.indexOf('@');
      const eq = value.indexOf('=');
      file = at >= 0 && (eq < 0 || at < eq) ? value.slice(at + 1) : undefined;
    } else if (CURL_FORM.has(opt)) {
      const m = /=[@<]([^;]*)/.exec(value);
      file = m ? m[1] : undefined;
    } else if (CURL_FILE.has(opt)) file = value;
    if (file !== undefined && file !== '' && file !== '-' && file !== '.') out.push(file);
  };
  for (let k = h + 1; k < words.length; k++) {
    const w = words[k]!;
    const eq = w.indexOf('=');
    const long = w.startsWith('--') && eq > 0 ? w.slice(0, eq) : undefined;
    if (long !== undefined && CURL_VALUE_OPTS.includes(long)) {
      take(long, w.slice(eq + 1));
    } else if (CURL_VALUE_OPTS.includes(w)) {
      const value = words[k + 1];
      if (value !== undefined) take(w, value);
      k++;
    } else if (/^-[dFTK]./.test(w)) {
      take(w.slice(0, 2), w.slice(2)); // glued short option: `-d@file`, `-Tfile`
    }
  }
  return out;
}

/**
 * What an assignment word's value may name as paths: the value, each `:`-separated part of it
 * (`PYTHONPATH=a:/x`) — a URL kept whole (`registry=https://…` names no path).
 */
function assignedPaths(word: string): string[] {
  const value = word.slice(ASSIGNMENT_WORD.exec(word)?.[0].length ?? word.indexOf('=') + 1);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return [value];
  return value.split(':').filter((p) => p !== '');
}

/** A value an option word may carry; `strict` when it starts like an expansion (`$`, `~`). */
interface OptionValue {
  value: string;
  strict: boolean;
  /** Read after the second or a later option letter: only a cluster reading gives it. */
  later: boolean;
}

/**
 * The values an option word may carry (none for a word that carries none): `--opt=<value>` (any
 * `-…=`), and a value glued to single-dash option letters — after ANY of them, since the letters
 * may be a cluster (`-ro/etc/x` is `-r -o /etc/x`; `-ox/../x` is `-o x/../x`): every suffix that
 * contains a `/`, is `..` (P14-07 M5, P14-08: `-C..`) or starts with `$` or `~` (`-o$HOME/.zshrc`;
 * `strict`: an expanded path, outside or unknown). A suffix of none of these kinds stays an option
 * (`-la`, `-n5`).
 */
function optionValues(word: string): OptionValue[] {
  const out: OptionValue[] = [];
  const eq = word.indexOf('=');
  if (eq > 0 && word.startsWith('-')) {
    out.push({ value: word.slice(eq + 1), strict: false, later: false });
  }
  const m = /^-([A-Za-z0-9]+)(.*)$/.exec(word);
  if (m) {
    const [, letters = '', rest = ''] = m;
    for (let i = 1; i <= letters.length; i++) {
      const value = letters.slice(i) + rest;
      const later = i > 1;
      if (/^[$~]/.test(value)) out.push({ value, strict: true, later });
      else if (value.includes('/') || value === '..') out.push({ value, strict: false, later });
    }
  }
  return out;
}

/**
 * A word's path tokens into `out`. An option word's first value is a path; a later one (a cluster
 * reading, `clusters` only) goes to `out.clustered` (P14-08 review I-4).
 */
function pathToken(
  raw: string,
  isTarget: boolean,
  out: CommandPaths,
  shown: string,
  clusters = true,
): void {
  if (!isTarget && raw.startsWith('-')) {
    for (const v of optionValues(raw)) {
      if (!v.strict && v.value.startsWith('-')) continue;
      if (!v.later) wordPath(v.value, v.strict, out, shown);
      else if (clusters) {
        const seen: CommandPaths = { paths: [], unresolvable: [], clustered: [] };
        wordPath(v.value, v.strict, seen, shown);
        out.clustered.push(...seen.paths.map((path) => ({ path, shown })));
        out.unresolvable.push(...seen.unresolvable);
      }
    }
    return;
  }
  wordPath(raw, isTarget, out, shown);
}

/** `pathToken` for a word that is not an option. */
function wordPath(raw: string, isTarget: boolean, out: CommandPaths, shown: string): void {
  let token = raw;
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

export function cwdOf(ctx: PolicyContext): string {
  return resolvePath(ctx.cwd ?? ctx.workspace, ctx, ctx.workspace);
}

/** `p` made absolute: `~` expanded, relative paths resolved from `from`. */
export function resolvePath(p: string, ctx: PolicyContext, from: string): string {
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
  return within(workspace, unalias(resolvePath(p, ctx, cwd), ctx));
}

/** `target` rewritten from another spelling of a root to the one the context names. */
function unalias(target: string, ctx: PolicyContext): string {
  for (const { from, to } of ctx.aliases ?? []) {
    if (within(from, target)) return join(to, relative(from, target));
  }
  return target;
}

function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Whether `p` names agent or git configuration that runs outside the gate on a later spawn or
 * git command: anything under `.claude/`, `.git/` or `.husky/`, agy's `.agents/` (workspace hooks
 * and MCP servers) and `.gemini/` (P11-05), Codex's `.codex/` (a trusted project's `config.toml`, P11-14), or a `.mcp.json` / `.claude.json`. Measured from the agent's cwd when `p` is under it (its worktree), else from
 * the workspace root when under it, so a workspace that itself lives under such a directory is not
 * flagged wholesale; anywhere else, on the whole path.
 */
export function isAgentConfigPath(p: string, ctx: PolicyContext): boolean {
  const workspace = resolve(expandHome(ctx.workspace, ctx));
  const cwd = ctx.cwd ? resolve(expandHome(ctx.cwd, ctx)) : workspace;
  const target = unalias(resolvePath(p, ctx, cwd), ctx);
  // Below the cwd or the workspace, only the part below them counts; elsewhere the whole path
  // (P9-17 review B1: `~/.claude/settings.json`, `~/other/.git/hooks/x`). Case-folded (APFS).
  const root = within(cwd, target) ? cwd : within(workspace, target) ? workspace : sep;
  const segments = relative(root, target)
    .split(sep)
    .map((s) => s.normalize('NFC').toLowerCase());
  const last = segments[segments.length - 1];
  return (
    segments.some(
      (s) =>
        s === '.claude' ||
        s === '.git' ||
        s === '.husky' ||
        s === '.agents' ||
        s === '.gemini' ||
        s === '.codex',
    ) ||
    last === '.mcp.json' ||
    last === '.claude.json'
  );
}

/**
 * Whether `p` (absolute, `~`-prefixed or relative to `ctx.cwd`) is one of `ctx.userFolders` or
 * lies under one (P9-06: the project's deliverables folder). Lexical, like `isInsideWorkspace`;
 * the path is compared as resolved and as unaliased to the workspace's spelling.
 */
export function isUserFolderPath(p: string, ctx: PolicyContext): boolean {
  if (!ctx.userFolders || ctx.userFolders.length === 0) return false;
  if (/^~[^/]/.test(p)) return false;
  const raw = resolvePath(p, ctx, cwdOf(ctx));
  const targets = [raw, unalias(raw, ctx)];
  // Case-folded: on a case-insensitive volume (APFS by default) `Deliverables/x` is the same
  // folder; on a case-sensitive one this only asks more often (fail closed).
  const fold = (q: string) => q.normalize('NFC').toLowerCase();
  return ctx.userFolders.some((f) => {
    const folder = fold(resolve(expandHome(f, ctx)));
    return targets.some((t) => within(folder, fold(t)));
  });
}

export function expandHome(p: string, ctx: PolicyContext): string {
  if (p === '~') return ctx.home ?? homedir();
  if (p.startsWith('~/')) return (ctx.home ?? homedir()) + p.slice(1);
  return p;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
