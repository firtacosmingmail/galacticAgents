import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import {
  PermissionAction,
  type PermissionPolicy,
  type PermissionRule,
  type PermissionRuleMatch,
  type PermissionRuleScope,
  type ToolCall,
} from '@galactic/protocol';
import {
  classifyCommand,
  commandHead,
  cwdOf,
  decide,
  DEFAULT_GLOB_FIELDS,
  EDIT_TOOLS,
  evaluate,
  expandHome,
  GLOB_FIELDS,
  globLocations,
  HARMLESS_DEVICES,
  lexCommand,
  PATH_FIELDS,
  READ_TOOLS,
  resolvePolicy,
  ruleFor,
  type Classification,
  type PolicyContext,
  type Redirect,
} from './permissions.js';

/**
 * "Allow similar" rules (P9-17; SPEC decision 138, TECHNOLOGY §8). Pure apart from the real-path
 * lookup (injectable): what a rule may be made from a permission request (`similarOptions`, the
 * card's three scopes with their previews), and which rule of a project allows a call the table
 * asks about (`matchingRule`, consulted by the gate). An LLM never takes part.
 *
 * Precedence, decided conservatively: the table first. A rule only ever turns an `ask` into an
 * `allow` — never a `deny` (the user's table or a hard refusal stays a refusal), never a push
 * (decision 49: a push always asks), never a write to agent or git configuration or to the
 * project's deliverables folder (decisions 22, 122), never a call the engine could not read —
 * unless an exact rule was made from that very call. A call matches a rule only when everything
 * the table asks about in it is among the categories the rule was made for, so a prefix or a
 * folder allowed for one reason does not cover another (`npm run x ../../y` outside the
 * workspace is not covered by an `npm run` rule made for running in the workspace).
 */

/** The real path of an existing file or folder (symlinks resolved), or `undefined`. */
export type RealPath = (path: string) => string | undefined;

export const systemRealPath: RealPath = (p) => {
  try {
    return realpathSync.native(p);
  } catch {
    return undefined;
  }
};

/** What the gate knows about a call: the call, where it runs and the project's table. */
export interface RuleInput {
  call: ToolCall;
  ctx: PolicyContext;
  policy: PermissionPolicy;
  /** Default: the file system's (`systemRealPath`). */
  realPath?: RealPath;
}

/** What the table asks about in a call: its `ask` categories, and whether it is unreadable. */
export interface Asking {
  categories: PermissionAction[];
  unclassified: boolean;
}

export function askingOf(policy: PermissionPolicy, c: Classification): Asking {
  const merged = resolvePolicy(policy);
  // In the table's order, so a rule's categories and label read the same whatever the call.
  const categories = PermissionAction.options.filter(
    (a) => c.actions.includes(a) && ruleFor(merged, a) === 'ask',
  );
  const unreadable = c.unclassified === true || c.actions.length === 0;
  return { categories, unclassified: unreadable && decide(policy, [], true) === 'ask' };
}

/** Why no rule may ever allow this call, or `undefined`. */
function neverByRule(c: Classification): string | undefined {
  if (c.actions.includes('push')) return 'a push always asks (decision 49)';
  if (c.guarded) {
    return 'it writes agent or git configuration, or the deliverables folder: it always asks';
  }
  return undefined;
}

// --- subjects -------------------------------------------------------------------------------

type Group = 'read' | 'edit';

/** What a call is about, as rules compare it. */
type Subject =
  | { kind: 'command'; command: string }
  | {
      kind: 'paths';
      group: Group;
      /** Real paths (symlinks resolved), one per path field and per glob location. */
      paths: string[];
      /** The exact subject: the real paths and the raw patterns with the folder they apply in. */
      text: string;
      /** A pattern whose locations cannot be told: no folder rule matches. */
      unreadable: boolean;
    }
  | { kind: 'text'; text: string };

const groupOf = (tool: string): Group | undefined =>
  READ_TOOLS.has(tool) ? 'read' : EDIT_TOOLS.has(tool) ? 'edit' : undefined;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** JSON with sorted keys: the same input always reads the same. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * `p` (absolute, `~/`, or relative to `from`) as the file system would reach it: walked segment
 * by segment from the root, each existing segment replaced by its real path, so a symlink is
 * followed and a `..` after it leaves the link's target (not the link's folder) — as the kernel
 * does. Past the first segment that does not exist the rest is lexical (it cannot be a link).
 * `undefined` for `~user` (someone else's home).
 */
export function physicalPath(
  p: string,
  ctx: PolicyContext,
  realPath: RealPath,
  from: string = cwdOf(ctx),
): string | undefined {
  if (/^~[^/]/.test(p)) return undefined;
  const expanded = expandHome(p, ctx);
  const absolute = isAbsolute(expanded) ? expanded : `${from}${sep}${expanded}`;
  let current: string = sep;
  for (const segment of absolute.split(sep)) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      current = dirname(current);
      continue;
    }
    const next = join(current, segment);
    current = realPath(next) ?? next;
  }
  return current;
}

function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function subjectOf(call: ToolCall, ctx: PolicyContext, realPath: RealPath): Subject {
  const input = isRecord(call.input) ? call.input : {};
  const tool = call.toolName;
  if (tool === 'Bash') {
    const command = typeof input['command'] === 'string' ? input['command'].trim() : '';
    return { kind: 'command', command };
  }
  const group = groupOf(tool);
  if (group) {
    const listed = Array.isArray(input['paths']) ? (input['paths'] as unknown[]) : [];
    const raw = [...PATH_FIELDS.map((f) => input[f]), ...listed].filter(
      (v): v is string => typeof v === 'string',
    );
    const paths: string[] = [];
    const parts: string[] = [];
    let unreadable = false;
    for (const p of raw) {
      const real = physicalPath(p, ctx, realPath);
      if (real === undefined) unreadable = true;
      else {
        paths.push(real);
        parts.push(real);
      }
    }
    const base = typeof input['path'] === 'string' ? input['path'] : undefined;
    const from =
      (base !== undefined ? physicalPath(base, ctx, realPath) : undefined) ??
      physicalPath(cwdOf(ctx), ctx, realPath) ??
      cwdOf(ctx);
    for (const f of GLOB_FIELDS[tool] ?? DEFAULT_GLOB_FIELDS) {
      const g = input[f];
      if (typeof g !== 'string') continue;
      parts.push(`${f} ${g} in ${from}`);
      const locations = globLocations(g);
      if (locations === null) {
        unreadable = true;
        continue;
      }
      for (const l of locations) {
        const real = physicalPath(l, ctx, realPath, from);
        if (real === undefined) unreadable = true;
        else paths.push(real);
      }
    }
    return { kind: 'paths', group, paths, text: [...new Set(parts)].sort().join('\n'), unreadable };
  }
  if (tool === 'WebFetch' && typeof input['url'] === 'string') {
    return { kind: 'text', text: input['url'] };
  }
  if (tool === 'WebSearch' && typeof input['query'] === 'string') {
    return { kind: 'text', text: input['query'] };
  }
  return { kind: 'text', text: stableJson(input) };
}

// --- command prefixes -----------------------------------------------------------------------

/**
 * Whether the engine cannot read `command` (a shell `-c`, an inline script, an interpreter fed
 * from stdin, `eval`, …): such a line has no prefix and matches none. Opaqueness does not depend
 * on where the command runs.
 */
function opaque(command: string): boolean {
  return classifyCommand(command, { workspace: '/nowhere', cwd: '/nowhere' }).unclassified === true;
}

/** A redirection that writes or reads no file: an fd duplication, or a harmless device. */
function harmlessRedirect(r: Redirect): boolean {
  if ((r.op === '>&' || r.op === '<&') && /^(?:\d+-?|-)$/.test(r.target)) return true;
  return r.op !== '<<' && r.op !== '<<-' && r.op !== '<<<' && HARMLESS_DEVICES.has(r.target);
}

/**
 * Whether every simple command of `command` — each part of a list or pipeline, each command
 * substitution — starts with exactly `words` (the shell's words, quotes removed), with no
 * redirection to a file and no heredoc. An unreadable line never matches. So `npm run x; rm -rf ~`,
 * `npm run x | sh`, `npm run x > ~/.zshrc` and `npm run $(curl …)` do not match `["npm", "run"]`.
 */
export function commandMatchesPrefix(command: string, words: readonly string[]): boolean {
  if (words.length === 0) return false;
  const lexed = lexCommand(command.trim());
  if (lexed.opaque.length > 0 || lexed.commands.length === 0 || opaque(command)) return false;
  return lexed.commands.every(
    (c) =>
      !c.heredoc &&
      c.redirects.every(harmlessRedirect) &&
      c.words.length >= words.length &&
      words.every((w, i) => c.words[i] === w),
  );
}

/** A plain subcommand word (`run`, `test`, `fetch`): no path, option, value or expansion. */
const SUBCOMMAND = /^[A-Za-z][A-Za-z0-9:_-]*$/;

/**
 * The prefix proposed for a command (P9-17): its name, plus its first argument when that reads as
 * a subcommand (`npm run build` → `npm run`; `curl https://…` → `curl`). Only for one simple
 * command with no redirection to a file, no assignment or wrapper in front (`FOO=1 x`, `sudo x`)
 * and no computed name; otherwise none (only "exactly this" or the category).
 */
export function proposePrefix(command: string): string[] | undefined {
  const lexed = lexCommand(command.trim());
  if (lexed.opaque.length > 0 || lexed.commands.length !== 1 || opaque(command)) return undefined;
  const c = lexed.commands[0]!;
  if (c.heredoc || !c.redirects.every(harmlessRedirect)) return undefined;
  const w = c.words;
  if (w.length === 0 || commandHead(w) !== 0) return undefined;
  const name = w[0]!;
  if (/[$`]/.test(name) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(name)) return undefined;
  const next = w[1];
  return next !== undefined && SUBCOMMAND.test(next) ? [name, next] : [name];
}

// --- options (the card's chooser) -----------------------------------------------------------

/** The categories in words, for the previews and labels. */
export const CATEGORY_WORDS: Record<PermissionAction, string> = {
  read_workspace: 'reading in the workspace',
  edit_workspace: 'editing in the workspace',
  run_workspace: 'running commands in the workspace',
  destructive: 'destructive actions',
  outside_workspace: 'outside the workspace',
  network: 'network access',
  push: 'push',
};

/** "network access", "destructive actions and network access", "a, b and c". */
function categoryWords(cs: readonly PermissionAction[]): string {
  const words = cs.map((c) => CATEGORY_WORDS[c]);
  return words.length <= 1
    ? (words[0] ?? '')
    : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** A rule as the server would make it from a request (no id, author or time yet). */
export interface RuleDraft {
  scope: PermissionRuleScope;
  tool: string;
  match: PermissionRuleMatch;
  categories: PermissionAction[];
  unclassified?: true;
  label: string;
  /** Exactly what it will match, in words (the chooser's preview). */
  preview: string;
}

export type ScopeOption =
  | { scope: PermissionRuleScope; available: true; draft: RuleDraft }
  | { scope: PermissionRuleScope; available: false; reason: string };

export interface SimilarOptions {
  /** Why no rule can be made from this request at all (a push, a denial, …). */
  refused?: string;
  options: ScopeOption[];
}

const shorten = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function tildify(p: string, ctx: PolicyContext): string {
  const home = ctx.home ?? homedir();
  return within(home, p) && p !== home ? `~/${relative(home, p)}` : p;
}

const GROUP_TOOLS: Record<Group, string> = {
  read: 'Reading, searching and listing (Read, Glob, Grep, LS)',
  edit: 'Writing and editing (Write, Edit, MultiEdit, NotebookEdit)',
};

/**
 * The folder a folder rule would cover: the common folder of the call's paths — a file's folder,
 * or the folder itself for a search or a listing. Never the root, the home folder or above it.
 */
function proposeFolder(
  call: ToolCall,
  subject: Extract<Subject, { kind: 'paths' }>,
  ctx: PolicyContext,
): { folder: string } | { reason: string } {
  if (subject.unreadable || subject.paths.length === 0) {
    return { reason: 'the engine cannot tell where this call points' };
  }
  const listing = call.toolName === 'Glob' || call.toolName === 'Grep' || call.toolName === 'LS';
  const folders = subject.paths.map((p) => (listing ? p : dirname(p)));
  let common = folders[0]!;
  for (const f of folders.slice(1)) {
    while (!within(common, f)) common = dirname(common);
  }
  const home = ctx.home ?? homedir();
  if (dirname(common) === common || within(common, home)) {
    return { reason: `${tildify(common, ctx)} is too broad (the root or the home folder)` };
  }
  return { folder: common };
}

/**
 * What the card's "Allow similar" chooser offers for a request (P9-17): one option per scope,
 * each with the rule the server would store and a preview of exactly what it matches, or why the
 * scope is not offered. Refused as a whole when the table does not ask about the call any more
 * (it allows or denies it now), for a push, for a write to configuration or deliverables.
 */
export function similarOptions(input: RuleInput): SimilarOptions {
  const { call, ctx, policy } = input;
  const realPath = input.realPath ?? systemRealPath;
  const verdict = evaluate(policy, call, ctx);
  if (verdict.alwaysAllow) return { refused: 'this call needs no permission', options: [] };
  const never = neverByRule(verdict);
  if (never) return { refused: never, options: [] };
  if (verdict.decision !== 'ask') {
    return {
      refused: `the project's table ${verdict.decision === 'deny' ? 'denies' : 'allows'} this call now`,
      options: [],
    };
  }
  const asking = askingOf(policy, verdict);
  const subject = subjectOf(call, ctx, realPath);
  const tool = call.toolName;
  const options: ScopeOption[] = [];
  const asks =
    asking.categories.length > 0
      ? ` (the table asks about it as ${categoryWords(asking.categories)})`
      : '';
  const only =
    asking.categories.length > 0
      ? ` — only while the table asks about it as ${categoryWords(asking.categories)} and nothing else`
      : '';

  // Exactly this.
  const exactText =
    subject.kind === 'command'
      ? subject.command
      : subject.kind === 'paths'
        ? subject.text
        : subject.text;
  const exactLabel =
    subject.kind === 'paths'
      ? `${tool} ${subject.paths.map((p) => tildify(p, ctx)).join(', ') || shorten(subject.text)}`
      : subject.kind === 'command'
        ? shorten(subject.command)
        : `${tool} ${shorten(subject.text)}`;
  options.push({
    scope: 'exact',
    available: true,
    draft: {
      scope: 'exact',
      tool,
      match: { kind: 'text', text: exactText },
      categories: asking.categories,
      ...(asking.unclassified ? { unclassified: true as const } : {}),
      label: exactLabel,
      preview:
        subject.kind === 'command'
          ? `Exactly the command \`${shorten(subject.command, 200)}\`${asks}.`
          : subject.kind === 'paths'
            ? `${GROUP_TOOLS[subject.group]} exactly ${subject.paths.map((p) => tildify(p, ctx)).join(', ') || 'what this call names'}${asks}.`
            : `${tool} with exactly this input: ${shorten(subject.text, 200)}${asks}.`,
    },
  });

  // This prefix / folder.
  if (asking.unclassified) {
    options.push({
      scope: 'prefix',
      available: false,
      reason: 'the engine cannot read this call, so only this exact call can be allowed',
    });
  } else if (subject.kind === 'command') {
    const words = proposePrefix(subject.command);
    options.push(
      words
        ? {
            scope: 'prefix',
            available: true,
            draft: {
              scope: 'prefix',
              tool,
              match: { kind: 'words', words },
              categories: asking.categories,
              label: `${words.join(' ')} …`,
              preview:
                `Any command line whose every command starts with \`${words.join(' ')}\` — not ` +
                'joined with another command (;, &&, |, $(…)), with no redirection to a file' +
                `${only}.`,
            },
          }
        : {
            scope: 'prefix',
            available: false,
            reason: 'only a single command without redirections, assignments or sudo has a prefix',
          },
    );
  } else if (subject.kind === 'paths') {
    const folder = proposeFolder(call, subject, ctx);
    options.push(
      'folder' in folder
        ? {
            scope: 'prefix',
            available: true,
            draft: {
              scope: 'prefix',
              tool,
              match: { kind: 'folder', folder: folder.folder },
              categories: asking.categories,
              label: `${tildify(folder.folder, ctx)}/…`,
              preview:
                `${GROUP_TOOLS[subject.group]} anything under ${tildify(folder.folder, ctx)} ` +
                `(symlinks followed: a link that leads elsewhere is not covered)${only}.`,
            },
          }
        : { scope: 'prefix', available: false, reason: folder.reason },
    );
  } else {
    options.push({
      scope: 'prefix',
      available: false,
      reason: `${tool} has no command prefix or folder`,
    });
  }

  // The whole category.
  if (asking.unclassified || asking.categories.length === 0) {
    options.push({
      scope: 'category',
      available: false,
      reason: 'the engine cannot read this call, so it has no category',
    });
  } else {
    options.push({
      scope: 'category',
      available: true,
      draft: {
        scope: 'category',
        tool: '*',
        match: { kind: 'categories' },
        categories: asking.categories,
        label: categoryWords(asking.categories),
        preview:
          `Any tool call the table asks about only as ${categoryWords(asking.categories)} — ` +
          'never a push, never what the table denies, never a write to agent configuration or ' +
          'the deliverables folder.',
      },
    });
  }
  return { options };
}

// --- matching (the gate) --------------------------------------------------------------------

function matchesScope(rule: PermissionRule, call: ToolCall, subject: Subject): boolean {
  const { match } = rule;
  switch (match.kind) {
    case 'categories':
      return rule.scope === 'category';
    case 'text':
      if (rule.scope !== 'exact') return false;
      if (subject.kind === 'paths') {
        return groupOf(rule.tool) === subject.group && match.text === subject.text;
      }
      return (
        rule.tool === call.toolName &&
        match.text === (subject.kind === 'command' ? subject.command : subject.text)
      );
    case 'words':
      return (
        rule.scope === 'prefix' &&
        subject.kind === 'command' &&
        rule.tool === call.toolName &&
        commandMatchesPrefix(subject.command, match.words)
      );
    case 'folder':
      return (
        rule.scope === 'prefix' &&
        subject.kind === 'paths' &&
        groupOf(rule.tool) === subject.group &&
        !subject.unreadable &&
        subject.paths.length > 0 &&
        subject.paths.every((p) => within(match.folder, p))
      );
  }
}

/**
 * The first of a project's rules that allows `input.call`, which the table asks about
 * (`classification` is the call's verdict; the gate checks the decision is `ask`). `undefined`
 * when none does — or when no rule may (a push, configuration, deliverables).
 */
export function matchingRule(
  rules: readonly PermissionRule[],
  input: RuleInput,
  classification: Classification,
): PermissionRule | undefined {
  if (rules.length === 0 || classification.alwaysAllow) return undefined;
  if (neverByRule(classification)) return undefined;
  const asking = askingOf(input.policy, classification);
  let subject: Subject | undefined;
  for (const rule of rules) {
    if (rule.categories.includes('push')) continue;
    if (asking.unclassified && !(rule.scope === 'exact' && rule.unclassified)) continue;
    if (!asking.categories.every((c) => rule.categories.includes(c))) continue;
    subject ??= subjectOf(input.call, input.ctx, input.realPath ?? systemRealPath);
    if (matchesScope(rule, input.call, subject)) return rule;
  }
  return undefined;
}
