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

export function strictest(decisions: PermissionDecision[]): PermissionDecision {
  let result: PermissionDecision = 'allow';
  for (const d of decisions) if (STRICTNESS[d] > STRICTNESS[result]) result = d;
  return result;
}

/**
 * The decision for a set of action categories under a policy. An empty set (nothing recognised)
 * is `ask`, never `allow`.
 */
export function decide(policy: PermissionPolicy, actions: PermissionAction[]): PermissionDecision {
  if (actions.length === 0) return 'ask';
  const merged = resolvePolicy(policy);
  return strictest(actions.map((a) => merged.rules[a] ?? 'ask'));
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
  const rules = resolvePolicy(policy).rules;
  const dominant = classification.actions.find((a) => (rules[a] ?? 'ask') === decision);
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
/** Fields that carry a glob; only absolute / `~` / `..`-leading ones name a location. */
const GLOB_FIELDS = ['pattern', 'glob'];

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
  for (const f of GLOB_FIELDS) {
    const g = input[f];
    if (typeof g === 'string' && looksLikeLocation(g)) paths.push(g);
  }
  const outside = paths.filter((p) => !isInsideWorkspace(p, ctx));
  if (outside.length === 0) return { actions: [inside], reasons: [] };
  return {
    actions: ['outside_workspace'],
    reasons: outside.map((p) => `${tool} on ${p}: outside the workspace`),
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

// --- shell commands ---------------------------------------------------------

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
const cmd = (name: string) => `(?:^|\\s)${PREFIX}${name}(?=\\s|$)`;
/** git's global options (`-c k=v`, `-C dir`, `--no-pager`, …) sit between `git` and the subcommand. */
const GIT_OPTS = '(?:\\s+(?:-[cC]\\s+\\S+|--[\\w-]+(?:=\\S+)?|-\\S+))*';
const git = (sub: string) => cmd('git') + GIT_OPTS + '\\s+' + sub;

/**
 * Commands whose real payload is a string the engine cannot see (a shell `-c`, an interpreter
 * one-liner, `eval`). Unclassifiable → `ask`.
 */
const OPAQUE_RULES: { pattern: RegExp; reason: string }[] = [
  {
    pattern: re(cmd('(?:sh|bash|zsh|dash|fish|ksh|csh|tcsh)') + '(?:\\s+-\\S+)*\\s+-\\S*c'),
    reason: 'shell -c hides the command it runs',
  },
  {
    pattern: re(cmd('(?:node|bun|deno)') + '(?:\\s+-\\S+)*\\s+(?:-e|-p|--eval|--print|eval)'),
    reason: 'inline script hides what it does',
  },
  {
    pattern: re(
      cmd('(?:python[23]?|perl|ruby|php|osascript|lua|Rscript)') + '(?:\\s+-\\S+)*\\s+-[cer]',
    ),
    reason: 'inline script hides what it does',
  },
  { pattern: re(cmd('eval')), reason: 'eval hides the command it runs' },
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
    action: 'destructive',
    pattern: re(git('checkout(?!\\s+(?:-[bB]|--orphan)(?=\\s|$))\\s+\\S')),
    reason: 'git checkout overwrites working-tree files',
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
  {
    action: 'network',
    pattern: re(
      cmd('(?:npm|pnpm|yarn|bun)') +
        '\\s+(?:i|install|ci|add|update|up|upgrade|dlx|create|exec|x|link)\\b',
    ),
    reason: 'package install',
  },
  { action: 'network', pattern: re(cmd('(?:npx|pnpx|bunx)')), reason: 'npx may download packages' },
  {
    action: 'network',
    pattern: re(
      cmd('(?:pip3?|pipx|uv|poetry|conda|pipenv)') + '\\s+(?:install|add|sync|download)\\b',
    ),
    reason: 'python package install',
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
    pattern: re(cmd('(?:ssh|telnet|nc|ncat|netcat|nmap|ftp|sftp|scp|rsync)')),
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
];

const ALL_RULES = [...DESTRUCTIVE_RULES, ...PUSH_RULES, ...NETWORK_RULES, ...ESCAPE_RULES];

/**
 * Splits a shell line into simple commands on `&&`, `||`, `;`, `|`, newlines, subshell and group
 * delimiters, and strips the spellings that hide a command name from a naive match: a leading
 * backslash (`\rm`, the alias bypass) and leading `(`/`{`.
 */
export function splitCommand(command: string): string[] {
  return command
    .split(/\s*(?:&&|\|\||;|\||\n|\$\(|\(|\)|\{|\}|`)\s*/)
    .map((s) => s.replace(/(^|\s)\\+(?=\S)/g, '$1').trim())
    .filter(Boolean);
}

export function classifyCommand(command: string, ctx: PolicyContext): Classification {
  const actions = new Set<PermissionAction>();
  const reasons: string[] = [];
  const trimmed = command.trim();
  if (trimmed === '') return { actions: [], reasons: ['empty command'] };

  // `cd` changes where the later segments resolve relative paths from.
  let cwd = resolvePath(ctx.cwd ?? ctx.workspace, ctx, ctx.workspace);
  let opaque = false;

  for (const segment of splitCommand(trimmed)) {
    const here: PolicyContext = { ...ctx, cwd };
    // Quotes are stripped for matching so `"rm -rf x"` inside a wrapper still trips the rule.
    const bare = segment.replace(/["'`]/g, ' ');
    for (const rule of OPAQUE_RULES) {
      if (rule.pattern.test(segment)) {
        opaque = true;
        reasons.push(`${rule.reason}: ${segment}`);
      }
    }
    for (const rule of ALL_RULES) {
      if (rule.pattern.test(segment) || rule.pattern.test(bare)) {
        actions.add(rule.action);
        reasons.push(`${rule.reason}: ${segment}`);
      }
    }
    const { paths, unresolvable } = pathsInCommand(segment);
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
    const cd = /^(?:cd|pushd)(?:\s+(.*))?$/i.exec(segment);
    if (cd) {
      const target = cd[1]?.trim();
      if (target === undefined || target === '' || target === '~') {
        cwd = ctx.home ?? homedir();
      } else if (target === '-' || unresolvable.length > 0 || /[$`]/.test(target)) {
        actions.add('outside_workspace');
        reasons.push(`cd ${target}: cannot tell where it leads`);
      } else {
        cwd = resolvePath(target.replace(/^["']|["']$/g, ''), ctx, cwd);
      }
      if (!isInsideWorkspace(cwd, ctx)) {
        actions.add('outside_workspace');
        reasons.push(`${segment}: leaves the workspace`);
      }
    }
  }
  if (opaque) return { actions: [], reasons };
  if (actions.size === 0) actions.add('run_workspace');
  return { actions: [...actions], reasons };
}

export interface CommandPaths {
  /** Path-looking tokens: absolute, `~`, `$HOME`/`$PWD`-based, or relative with a `..`. */
  paths: string[];
  /** Tokens with a shell variable or substitution the engine cannot expand lexically. */
  unresolvable: string[];
}

/**
 * Path-looking tokens of a command segment. Option values (`--out=/tmp/x`) and redirections
 * count too. Plain words are not paths, so `ls foo` never escapes; `ls ../foo` is checked.
 * `$HOME` and `$PWD` are expanded; any other `$VAR` or backtick inside a path-like token makes
 * it unresolvable.
 */
export function pathsInCommand(segment: string): CommandPaths {
  const paths: string[] = [];
  const unresolvable: string[] = [];
  for (const raw of segment.split(/\s+/)) {
    let token = raw.replace(/^[<>]+/, '').replace(/^["']|["']$/g, '');
    const eq = token.indexOf('=');
    if (eq > 0 && token.startsWith('-')) token = token.slice(eq + 1);
    if (token.startsWith('-')) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) continue; // URLs are the network rules' business
    token = token
      .replace(/^\$\{?HOME\}?(?=\/|$)/, '~')
      .replace(/^\$\{?PWD\}?(?=\/|$)/, '.')
      .replace(/^"?\$\{?HOME\}?"?(?=\/)/, '~');
    if (/[$`]/.test(token)) {
      if (token.includes('/') || /^\$\{?(?:HOME|PWD|TMPDIR|TMP|TEMP)\}?/.test(token)) {
        unresolvable.push(raw);
      }
      continue;
    }
    if (looksLikeLocation(token)) paths.push(token);
  }
  return { paths, unresolvable };
}

// --- paths ------------------------------------------------------------------

/** `p` made absolute: `~` expanded, relative paths resolved from `from`. */
function resolvePath(p: string, ctx: PolicyContext, from: string): string {
  return resolve(expandHome(from, ctx), expandHome(p, ctx));
}

/**
 * Whether `p` (absolute, `~`-prefixed or relative to `ctx.cwd`) resolves inside `ctx.workspace`.
 * Purely lexical — `..` segments are resolved, symlinks are not (the engine has no file system).
 */
export function isInsideWorkspace(p: string, ctx: PolicyContext): boolean {
  const workspace = resolve(expandHome(ctx.workspace, ctx));
  const cwd = ctx.cwd ? resolve(expandHome(ctx.cwd, ctx)) : workspace;
  const target = resolvePath(p, ctx, cwd);
  const rel = relative(workspace, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function expandHome(p: string, ctx: PolicyContext): string {
  if (p === '~') return ctx.home ?? homedir();
  if (p.startsWith('~/')) return (ctx.home ?? homedir()) + p.slice(1);
  return p;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
