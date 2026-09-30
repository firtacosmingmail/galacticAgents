import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  DEFAULT_PERMISSION_POLICY,
  type PermissionAction,
  type PermissionDecision,
  type PermissionPolicy,
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

export interface ToolCallRequest {
  toolName: string;
  input?: unknown;
}

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
}

export interface PolicyVerdict extends Classification {
  decision: PermissionDecision;
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
  call: ToolCallRequest,
  ctx: PolicyContext,
): PolicyVerdict {
  const classification = classifyToolCall(call, ctx);
  return { ...classification, decision: decide(policy, classification.actions) };
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

export function classifyToolCall(call: ToolCallRequest, ctx: PolicyContext): Classification {
  const input = isRecord(call.input) ? call.input : {};
  const name = call.toolName;

  if (HARMLESS_TOOLS.has(name)) return { actions: ['read_workspace'], reasons: [] };
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
  const outside = paths.filter((p) => !isInsideWorkspace(p, ctx));
  if (outside.length === 0) return { actions: [inside], reasons: [] };
  return {
    actions: ['outside_workspace'],
    reasons: outside.map((p) => `${tool} on ${p}: outside the workspace`),
  };
}

// --- shell commands ---------------------------------------------------------

interface CommandRule {
  action: PermissionAction;
  pattern: RegExp;
  reason: string;
}

/** Word-boundary helper for command names: start of segment or after `sudo`/`env`/whitespace. */
const cmd = (name: string) => `(?:^|\\s)(?:sudo\\s+|env\\s+\\S+=\\S+\\s+)*${name}(?=\\s|$)`;

const DESTRUCTIVE_RULES: CommandRule[] = [
  { action: 'destructive', pattern: new RegExp(cmd('rm')), reason: 'rm deletes files' },
  { action: 'destructive', pattern: new RegExp(cmd('rmdir')), reason: 'rmdir deletes directories' },
  { action: 'destructive', pattern: new RegExp(cmd('unlink')), reason: 'unlink deletes files' },
  { action: 'destructive', pattern: new RegExp(cmd('shred')), reason: 'shred destroys files' },
  {
    action: 'destructive',
    pattern: new RegExp(cmd('find') + '.*\\s-delete(?=\\s|$)'),
    reason: 'find -delete deletes files',
  },
  {
    action: 'destructive',
    pattern: new RegExp(
      cmd('git') + '\\s+branch\\s+(?:.*\\s)?(?:-[a-zA-Z]*[dD]|--delete)(?=\\s|$)',
    ),
    reason: 'git branch delete',
  },
  {
    action: 'destructive',
    pattern: new RegExp(cmd('git') + '\\s+push\\s+(?:.*\\s)?(?:--delete|-d)(?=\\s|$)'),
    reason: 'git push --delete removes a remote branch',
  },
  {
    action: 'destructive',
    pattern: new RegExp(
      cmd('git') + '\\s+push(?:\\s+\\S+)*\\s+(?:--force(?:-with-lease)?|-f|\\+\\S+)(?=\\s|$)',
    ),
    reason: 'git push --force',
  },
  {
    action: 'destructive',
    pattern: new RegExp(cmd('git') + '\\s+reset\\s+(?:.*\\s)?--hard'),
    reason: 'git reset --hard discards changes',
  },
  {
    action: 'destructive',
    pattern: new RegExp(cmd('git') + '\\s+clean\\b'),
    reason: 'git clean deletes untracked files',
  },
  {
    action: 'destructive',
    pattern: new RegExp(cmd('git') + '\\s+(?:checkout|restore)\\s+(?:--\\s+)?\\.(?=\\s|$)'),
    reason: 'git checkout/restore . discards changes',
  },
  {
    action: 'destructive',
    pattern: new RegExp(cmd('git') + '\\s+(?:stash\\s+(?:drop|clear)|worktree\\s+remove)\\b'),
    reason: 'git stash drop / worktree remove',
  },
  {
    action: 'destructive',
    pattern: new RegExp(
      cmd('git') + '\\s+(?:tag|remote)\\s+(?:.*\\s)?(?:-d|--delete|rm|remove)(?=\\s|$)',
    ),
    reason: 'git tag/remote delete',
  },
  {
    action: 'destructive',
    pattern: /(?:^|\s)--force(?:-with-lease)?(?=\s|$)/,
    reason: '--force operation',
  },
  { action: 'destructive', pattern: new RegExp(cmd('dd')), reason: 'dd overwrites devices/files' },
  { action: 'destructive', pattern: new RegExp(cmd('mkfs(?:\\.\\w+)?')), reason: 'mkfs' },
  { action: 'destructive', pattern: new RegExp(cmd('truncate')), reason: 'truncate empties files' },
  {
    action: 'destructive',
    pattern: /\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b/i,
    reason: 'SQL DROP',
  },
];

const PUSH_RULES: CommandRule[] = [
  {
    action: 'push',
    pattern: new RegExp(cmd('git') + '\\s+push\\b'),
    reason: 'git push leaves the machine',
  },
  {
    action: 'push',
    pattern: new RegExp(cmd('git') + '\\s+send-email\\b'),
    reason: 'git send-email',
  },
  {
    action: 'push',
    pattern: new RegExp(cmd('(?:npm|pnpm|yarn|cargo|twine|gem)') + '\\s+publish\\b'),
    reason: 'package publish leaves the machine',
  },
  {
    action: 'push',
    pattern: new RegExp(
      cmd('gh') +
        '\\s+(?:pr|release|repo|issue)\\s+(?:create|merge|delete|edit|close|comment|push)\\b',
    ),
    reason: 'gh writes to GitHub',
  },
  {
    action: 'push',
    pattern: new RegExp(
      cmd('(?:scp|rsync|sftp)') + '.*\\S+@\\S+:|' + cmd('(?:scp|rsync)') + '.*\\s\\S+:\\S+',
    ),
    reason: 'copy to a remote host',
  },
  {
    action: 'push',
    pattern: new RegExp(cmd('docker') + '\\s+push\\b'),
    reason: 'docker push leaves the machine',
  },
];

const NETWORK_RULES: CommandRule[] = [
  {
    action: 'network',
    pattern: new RegExp(cmd('(?:curl|wget|http|https|xh|aria2c)')),
    reason: 'HTTP client',
  },
  { action: 'network', pattern: /https?:\/\//, reason: 'URL in command' },
  {
    action: 'network',
    pattern: new RegExp(
      cmd('(?:npm|pnpm|yarn|bun)') +
        '\\s+(?:i|install|ci|add|update|up|upgrade|dlx|create|exec|x|link)\\b',
    ),
    reason: 'package install',
  },
  {
    action: 'network',
    pattern: new RegExp(cmd('(?:npx|pnpx|bunx)')),
    reason: 'npx may download packages',
  },
  {
    action: 'network',
    pattern: new RegExp(
      cmd('(?:pip3?|pipx|uv|poetry|conda|pipenv)') + '\\s+(?:install|add|sync|download)\\b',
    ),
    reason: 'python package install',
  },
  {
    action: 'network',
    pattern: new RegExp(cmd('cargo') + '\\s+(?:install|add|fetch|update|search)\\b'),
    reason: 'cargo fetch/install',
  },
  {
    action: 'network',
    pattern: new RegExp(cmd('go') + '\\s+(?:get|install|mod\\s+download)\\b'),
    reason: 'go get',
  },
  {
    action: 'network',
    pattern: new RegExp(
      cmd('(?:brew|apt|apt-get|dnf|yum|pacman|apk|snap|port|choco|winget)') +
        '\\s+(?:install|upgrade|update|add|remove|uninstall|purge)\\b',
    ),
    reason: 'system package manager',
  },
  {
    action: 'network',
    pattern: new RegExp(
      cmd('git') + '\\s+(?:clone|fetch|pull|ls-remote|submodule\\s+update|remote\\s+update)\\b',
    ),
    reason: 'git talks to a remote',
  },
  {
    action: 'network',
    pattern: new RegExp(cmd('(?:ssh|telnet|nc|ncat|netcat|nmap|ftp|sftp|scp|rsync)')),
    reason: 'remote connection',
  },
  {
    action: 'network',
    pattern: new RegExp(cmd('docker') + '\\s+(?:pull|login|build)\\b'),
    reason: 'docker pulls images',
  },
  { action: 'network', pattern: new RegExp(cmd('gh')), reason: 'gh talks to GitHub' },
  {
    action: 'network',
    pattern: new RegExp(cmd('(?:mail|sendmail|mutt)')),
    reason: 'mail leaves the machine',
  },
];

const ESCAPE_RULES: CommandRule[] = [
  {
    action: 'outside_workspace',
    pattern: /(?:^|\s)sudo(?=\s|$)/,
    reason: 'sudo escapes the workspace sandbox',
  },
  {
    action: 'outside_workspace',
    pattern: /(?:^|\s)(?:su|doas)(?=\s|$)/,
    reason: 'privilege change',
  },
  {
    action: 'outside_workspace',
    pattern: new RegExp(cmd('(?:chmod|chown|chgrp)') + '.*\\s-[a-zA-Z]*R'),
    reason: 'recursive ownership/mode change',
  },
  {
    action: 'outside_workspace',
    pattern: new RegExp(cmd('(?:crontab|launchctl|systemctl|reboot|shutdown|halt|poweroff)')),
    reason: 'system service or power control',
  },
  {
    action: 'outside_workspace',
    pattern: new RegExp(cmd('(?:kill|killall|pkill)')),
    reason: 'signals to other processes',
  },
];

const ALL_RULES = [...DESTRUCTIVE_RULES, ...PUSH_RULES, ...NETWORK_RULES, ...ESCAPE_RULES];

/** Splits a shell line into simple commands on `&&`, `||`, `;`, `|`, newlines and subshell parens. */
export function splitCommand(command: string): string[] {
  return command
    .split(/\s*(?:&&|\|\||;|\||\n|\$\(|\)|`)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function classifyCommand(command: string, ctx: PolicyContext): Classification {
  const actions = new Set<PermissionAction>();
  const reasons: string[] = [];
  const trimmed = command.trim();
  if (trimmed === '') return { actions: [], reasons: ['empty command'] };

  for (const segment of splitCommand(trimmed)) {
    for (const rule of ALL_RULES) {
      if (rule.pattern.test(segment)) {
        actions.add(rule.action);
        reasons.push(`${rule.reason}: ${segment}`);
      }
    }
    for (const p of pathsInCommand(segment)) {
      if (!isInsideWorkspace(p, ctx)) {
        actions.add('outside_workspace');
        reasons.push(`${p}: outside the workspace`);
      }
    }
  }
  if (actions.size === 0) actions.add('run_workspace');
  return { actions: [...actions], reasons };
}

/**
 * Path-looking tokens of a command segment: absolute paths, `~` paths and relative paths that
 * contain a `/` or a `..`. Option values (`--out=/tmp/x`) and redirections count too. Plain words
 * are not paths, so `ls foo` never escapes; `ls ../foo` is checked.
 */
export function pathsInCommand(segment: string): string[] {
  const out: string[] = [];
  for (const raw of segment.split(/\s+/)) {
    let token = raw.replace(/^[<>]+/, '').replace(/^["']|["']$/g, '');
    const eq = token.indexOf('=');
    if (eq > 0 && token.startsWith('-')) token = token.slice(eq + 1);
    if (token.startsWith('-')) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) continue; // URLs are the network rules' business
    if (
      token.startsWith('/') ||
      token.startsWith('~') ||
      token === '..' ||
      token.startsWith('../') ||
      token.includes('/../') ||
      token.endsWith('/..')
    ) {
      out.push(token);
    }
  }
  return out;
}

// --- paths ------------------------------------------------------------------

/**
 * Whether `p` (absolute, `~`-prefixed or relative to `ctx.cwd`) resolves inside `ctx.workspace`.
 * Purely lexical — `..` segments are resolved, symlinks are not (the engine has no file system).
 */
export function isInsideWorkspace(p: string, ctx: PolicyContext): boolean {
  const workspace = resolve(expandHome(ctx.workspace, ctx));
  const cwd = ctx.cwd ? resolve(expandHome(ctx.cwd, ctx)) : workspace;
  const target = resolve(cwd, expandHome(p, ctx));
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
