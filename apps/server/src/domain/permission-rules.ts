import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  type Id,
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
  guardedWriteReason,
  HARMLESS_DEVICES,
  lexCommand,
  PATH_FIELDS,
  READ_TOOLS,
  resolvePolicy,
  ruleFor,
  type Classification,
  type Finding,
  type PolicyContext,
  type Redirect,
} from './permissions.js';

/**
 * "Allow similar" rules (P9-17; SPEC decision 138, TECHNOLOGY §8). Pure apart from the real-path
 * lookup (injectable): what a rule may be made from a permission request (`similarOptions`, the
 * card's three scopes with their previews), and which rules of a project cover the reasons a call
 * the table asks about gives (`coverage`, consulted by the gate). An LLM never takes part.
 *
 * Precedence, decided conservatively: the table first. A rule only ever turns an `ask` into an
 * `allow` — never a `deny` (the user's table or a hard refusal stays a refusal), never a push
 * (decision 49: a push always asks), never a write to agent or git configuration or to the
 * project's deliverables folder (decisions 22, 122), never a call the engine could not read —
 * unless an exact rule was made from that very call. A call passes only when every reason the
 * table asks about in it is covered by a rule made for that kind of reason (P14-03), so a prefix
 * or a folder allowed for one reason does not cover another (`npm run x ../../y` outside the
 * workspace is not covered by an `npm run` rule made for running in the workspace).
 *
 * An outside-the-workspace reason (P9-17 review B2) is covered only by an exact rule, a file
 * tool's folder rule (reading and writing apart) or a folder rule made from a command (P14): a
 * command prefix or the whole category would cover the whole computer, so neither ever covers one.
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

/**
 * The resolved spellings of the workspace and the cwd, when they differ from the given ones (a
 * symlink on the way: macOS `/var` → `/private/var`, a symlinked projects folder). Claude Code
 * resolves its cwd, so it names resolved paths; the engine judges them as the given ones. The cwd
 * comes first, so a worktree inside the workspace maps to itself. A path that does not exist (yet)
 * has no other spelling. Shared by the gate and the chooser's offline context (P9-17 review S8).
 */
export function aliasesOf(workspace: string, cwd: string): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  for (const given of [resolve(cwd), resolve(workspace)]) {
    let real: string;
    try {
      real = realpathSync(given);
    } catch {
      continue;
    }
    if (real !== given && !out.some((a) => a.from === real)) out.push({ from: real, to: given });
  }
  return out;
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
 * Commands that run whatever code they are given — shells, interpreters, `source`/`eval` — never
 * get a prefix rule (P9-17 review S3): `python3 …` or `bash …` as a prefix would allow anything,
 * a script the agent just wrote included. Compared on the base name, case-folded.
 */
const RUNS_ANY_CODE = new RegExp(
  '^(?:sh|bash|zsh|dash|fish|ksh|csh|tcsh|ash|python[0-9.]*|pypy[0-9.]*|node|nodejs|deno|bun|' +
    'perl|ruby|irb|php|lua|luajit|rscript|osascript|tclsh|groovy|jshell|source|\\.|eval)$',
);
/** Package runners: allowed as a prefix only with the package they run (`npx tsc`, not `npx`). */
const PACKAGE_RUNNERS = /^(?:npx|pnpx|bunx|uvx)$/;
/** Commands that run scripts from a file in the workspace (package.json, a Makefile). */
const SCRIPT_RUNNERS = /^(?:npm|pnpm|yarn|make|gmake|just)$/;

const commandName = (word: string) => (word.split('/').pop() ?? word).toLowerCase();

/** Why a prefix rule of `words` is never made or matched (P9-17 review S3), or `undefined`. */
export function prefixRefusal(words: readonly string[]): string | undefined {
  const name = words[0] !== undefined ? commandName(words[0]) : undefined;
  if (name === undefined) return 'no command';
  if (RUNS_ANY_CODE.test(name)) {
    return `${name} runs whatever code it is given, so a prefix would allow anything: only this exact command can be allowed`;
  }
  if (PACKAGE_RUNNERS.test(name) && words.length < 2) {
    return `${name} runs whatever package it is given: a prefix needs the package's name`;
  }
  return undefined;
}

/** What the preview adds for a prefix whose command runs scripts the agent can edit (S3). */
function scriptWarning(words: readonly string[]): string {
  const name = commandName(words[0] ?? '');
  if (!SCRIPT_RUNNERS.test(name)) return '';
  const file = /make$|^just$/.test(name) ? 'the Makefile (or justfile)' : 'package.json';
  return ` Note: this runs scripts from ${file}, which the agent can change — the rule allows whatever they say then.`;
}

/**
 * The prefix proposed for a command (P9-17): its name, plus its first argument when that reads as
 * a subcommand (`npm run build` → `npm run`; `curl https://…` → `curl`). Only for one simple
 * command with no redirection to a file, no assignment or wrapper in front (`FOO=1 x`, `sudo x`),
 * no computed name, and not a shell or interpreter (`prefixRefusal`); otherwise none.
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
  const words = next !== undefined && SUBCOMMAND.test(next) ? [name, next] : [name];
  return prefixRefusal(words) ? undefined : words;
}

/** Why `command` gets no prefix, in the chooser's words. */
function noPrefixReason(command: string): string {
  const c = lexCommand(command.trim()).commands;
  const words = c.length === 1 ? c[0]!.words : [];
  const refusal = words.length > 0 && commandHead(words) === 0 ? prefixRefusal(words) : undefined;
  return refusal ?? 'only a single command without redirections, assignments or sudo has a prefix';
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

/**
 * What binds the chooser's preview to the rule stored (P9-17 review S1): a hash of the draft's
 * scope, tool, match and categories. The preview sends it, "Allow and remember" sends it back,
 * and the server refuses (409 `stale`) when the rule it drafts again differs.
 */
export function draftDigest(
  d: Pick<RuleDraft, 'scope' | 'tool' | 'match' | 'categories' | 'unclassified'>,
): string {
  const body = stableJson({
    scope: d.scope,
    tool: d.tool,
    match: JSON.parse(JSON.stringify(d.match)) as unknown,
    categories: d.categories,
    unclassified: d.unclassified === true,
  });
  return createHash('sha256').update(body).digest('hex').slice(0, 32);
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

function tildeOf(p: string, home: string): string {
  return within(home, p) && p !== home ? `~/${relative(home, p)}` : p;
}

function tildify(p: string, ctx: PolicyContext): string {
  return tildeOf(p, ctx.home ?? homedir());
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
  // Outside the workspace (review B2): exactly this, or a folder — never a prefix or the category.
  const outside = asking.categories.includes('outside_workspace');

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
  } else if (subject.kind === 'command' && outside) {
    options.push({
      scope: 'prefix',
      available: false,
      reason:
        'it reaches outside the workspace, where a command prefix would cover the whole computer: only this exact command can be allowed',
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
              label: `${words.join(' ')} … (and any further arguments)`,
              preview:
                `Any command line in which every command starts with \`${words.join(' ')}\`, ` +
                'whatever arguments follow — a line that joins another command (;, &&, |, $(…)) ' +
                `or redirects to a file is not covered${only}.${scriptWarning(words)}`,
            },
          }
        : { scope: 'prefix', available: false, reason: noPrefixReason(subject.command) },
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
  } else if (outside) {
    options.push({
      scope: 'category',
      available: false,
      reason:
        'outside the workspace as a whole category would cover the whole computer: allow exactly this, or a folder',
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
          'never a push, never what the table denies, never anything outside the workspace, ' +
          'never a write to agent or git configuration, the deliverables folder or your shell ' +
          'and login set-up.',
      },
    });
  }
  return { options };
}

// --- matching (the gate) --------------------------------------------------------------------

function matchesScope(
  rule: PermissionRule,
  call: ToolCall,
  subject: Subject,
  ctx: PolicyContext,
): boolean {
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
        prefixRefusal(match.words) === undefined &&
        commandMatchesPrefix(subject.command, match.words)
      );
    case 'host':
      // A site rule covers network findings one by one (`coversFinding`), never a whole call.
      return false;
    case 'folder':
      return (
        rule.scope === 'prefix' &&
        subject.kind === 'paths' &&
        groupOf(rule.tool) === subject.group &&
        !subject.unreadable &&
        subject.paths.length > 0 &&
        subject.paths.every((p) => within(match.folder, p)) &&
        // A write that reaches guarded ground through a symlink (review B1): never.
        (subject.group !== 'edit' || subject.paths.every((p) => !guardedWriteReason(p, ctx)))
      );
  }
}

/** Whether `folder` is a folder a rule may cover: never the root, the home folder or above it. */
function coverableFolder(folder: string, ctx: PolicyContext): boolean {
  if (!isAbsolute(folder)) return false;
  const f = resolve(folder);
  return dirname(f) !== f && !within(f, ctx.home ?? homedir());
}

/**
 * A `..` path segment anywhere in a command line. A finding's path is resolved lexically, so
 * `link/..` reads as the link's folder where the kernel goes to the link target's parent: a
 * folder rule never covers a command with one (P14-03, conservative). `dev..HEAD` is not one.
 */
const DOT_DOT_SEGMENT = /(?:^|[^.\w-])\.\.(?:$|[^.\w-])/;

/** Whether the command's `segment` (classifyCommand's index) starts with `words`, cleanly. */
function segmentStartsWith(command: string, f: Finding, words: readonly string[]): boolean {
  if (f.segment === undefined || f.words === undefined || f.redirects !== false) return false;
  const simple = lexCommand(command.trim()).commands[f.segment];
  if (!simple || simple.heredoc || !simple.redirects.every(harmlessRedirect)) return false;
  if (simple.words.length !== f.words.length || simple.words.some((w, i) => w !== f.words![i])) {
    return false;
  }
  return words.every((w, i) => f.words![i] === w) && commandMatchesPrefix(f.words.join(' '), words);
}

/** What `coverage` knows about the call while it looks at one finding. */
interface CoverageInput {
  input: RuleInput;
  realPath: RealPath;
  /** The Bash command (trimmed), or `undefined` for another tool. */
  command: string | undefined;
  subject: () => Subject;
}

/**
 * Whether a folder rule made from a command (`access: 'any'`) covers this outside-the-workspace
 * finding: its real path is under the folder — for a command the finding's resolved path, for a
 * file tool (either group, controller ruling 2) every path the call names. Never a write that
 * reaches guarded ground through a symlink.
 */
function folderCovers(folder: string, f: Finding, k: CoverageInput): boolean {
  const { ctx } = k.input;
  if (!coverableFolder(folder, ctx)) return false;
  if (k.command !== undefined) {
    if (f.path === undefined || DOT_DOT_SEGMENT.test(k.command)) return false;
    const real = physicalPath(f.path, ctx, k.realPath);
    if (real === undefined || !within(folder, real)) return false;
    // Lexically ordinary but guarded once symlinks are followed (review B1): never.
    return !(guardedWriteReason(real, ctx) && !guardedWriteReason(f.path, ctx));
  }
  const subject = k.subject();
  return (
    subject.kind === 'paths' &&
    !subject.unreadable &&
    subject.paths.length > 0 &&
    subject.paths.every((p) => within(folder, p)) &&
    (subject.group !== 'edit' || subject.paths.every((p) => !guardedWriteReason(p, ctx)))
  );
}

/** Whether `host` is `site` or a subdomain of it, on a label boundary. */
function onSite(host: string, site: string): boolean {
  const h = host.toLowerCase();
  const s = site.toLowerCase();
  if (s === '' || s.startsWith('.')) return false;
  return h === s || h.endsWith(`.${s}`);
}

/** Whether `rule` covers the one asked finding `f` (never a legacy exact or file-tool folder). */
function coversFinding(rule: PermissionRule, f: Finding, k: CoverageInput): boolean {
  const { match } = rule;
  const outside = f.action === 'outside_workspace';
  switch (match.kind) {
    case 'folder':
      return rule.scope === 'folder' && match.access === 'any' && outside
        ? folderCovers(match.folder, f, k)
        : false;
    case 'host':
      return (
        rule.scope === 'site' &&
        f.action === 'network' &&
        f.hosts !== undefined &&
        f.hosts.length > 0 &&
        f.hosts.every((h) => onSite(h, match.host))
      );
    case 'words': {
      if (rule.scope !== 'prefix' || outside || k.command === undefined) return false;
      if (rule.tool !== k.input.call.toolName || !rule.categories.includes(f.action)) return false;
      if (prefixRefusal(match.words) !== undefined) return false;
      // A finding of one simple command; or the line's own (running in the workspace): all of it.
      return f.segment !== undefined
        ? segmentStartsWith(k.command, f, match.words)
        : commandMatchesPrefix(k.command, match.words);
    }
    case 'categories':
      return rule.scope === 'category' && !outside && rule.categories.includes(f.action);
    case 'text':
      return false;
  }
}

/** A stored rule that covers the call as a whole, as before P14: an exact or a file-tool folder. */
function coversWholeCall(rule: PermissionRule, asking: Asking, k: CoverageInput): boolean {
  const legacyFolder =
    rule.scope === 'prefix' && rule.match.kind === 'folder' && rule.match.access === undefined;
  if (rule.scope !== 'exact' && !legacyFolder) return false;
  if (rule.match.kind === 'folder' && !coverableFolder(rule.match.folder, k.input.ctx))
    return false;
  if (asking.unclassified && !(rule.scope === 'exact' && rule.unclassified)) return false;
  if (!asking.categories.every((c) => rule.categories.includes(c))) return false;
  return matchesScope(rule, k.input.call, k.subject(), k.input.ctx);
}

/** How a project's rules cover a call the table asks about (P14-03). */
export interface Coverage {
  /** Every asked finding covered: the call is allowed. */
  allowed: boolean;
  /** Rules that covered at least one finding (all of them when `allowed`). */
  ruleIds: Id[];
  /** Asked findings no rule covers (empty when `allowed`). */
  uncovered: Finding[];
}

/**
 * Which of a project's rules cover `input.call`, which the table asks about (`c` is the call's
 * verdict; the gate checks the decision is `ask`): the call is allowed only when every finding the
 * table asks about is covered by some rule whose kind fits it — a folder its outside-the-workspace
 * paths, a site its visible hosts, a prefix the reasons of the commands it starts, a category its
 * categories (never outside the workspace). A stored exact or file-tool folder rule covers its
 * whole call, as before. Nothing is ever covered for a push, a guarded write (`neverByRule`), or a
 * call the engine cannot read (except by an exact rule made from that very call).
 */
export function coverage(
  rules: readonly PermissionRule[],
  input: RuleInput,
  c: Classification,
): Coverage {
  const asking = askingOf(input.policy, c);
  const asked = c.findings.filter((f) => asking.categories.includes(f.action));
  const none: Coverage = { allowed: false, ruleIds: [], uncovered: asked };
  if (rules.length === 0 || c.alwaysAllow || neverByRule(c)) return none;
  if (asked.some((f) => f.action === 'push')) return none;
  const live = rules.filter((r) => !r.categories.includes('push'));
  const call = input.call;
  const realPath = input.realPath ?? systemRealPath;
  const raw = isRecord(call.input) ? call.input['command'] : undefined;
  let subject: Subject | undefined;
  const k: CoverageInput = {
    input,
    realPath,
    command: call.toolName === 'Bash' ? (typeof raw === 'string' ? raw.trim() : '') : undefined,
    subject: () => (subject ??= subjectOf(call, input.ctx, realPath)),
  };
  const whole = live.find((r) => coversWholeCall(r, asking, k));
  if (whole) return { allowed: true, ruleIds: [whole.id], uncovered: [] };
  if (asking.unclassified) return none;
  // Every category the table asks about must have a finding (Task 2's invariant): else fail closed.
  if (asked.length === 0 || asking.categories.some((a) => !asked.some((f) => f.action === a))) {
    return none;
  }
  const used = new Set<Id>();
  const uncovered: Finding[] = [];
  for (const f of asked) {
    const rule = live.find((r) => coversFinding(r, f, k));
    if (rule) used.add(rule.id);
    else uncovered.push(f);
  }
  const ruleIds = live.filter((r) => used.has(r.id)).map((r) => r.id);
  return { allowed: uncovered.length === 0 && ruleIds.length > 0, ruleIds, uncovered };
}

// --- a job's unattended rules (P10, final review I2) -----------------------------------------

/** What a job's unattended rule is made of (`JobRule` without its id, label and origin). */
export type UnattendedRuleShape = Pick<PermissionRule, 'scope' | 'tool' | 'match' | 'categories'>;

/**
 * Why a job's unattended rule has a shape the "Allow similar" chooser never makes (SPEC decisions
 * 138, 144), or `undefined`. A job card is written by a Waykeeper, so the server holds its rules to
 * what a permission card could have offered: an exact rule matches a text; a prefix rule a
 * command's words (never a shell or interpreter, never outside the workspace) or an absolute
 * folder of a file tool (never the root, the home folder or above it); a category rule (tool `*`)
 * whole categories, never outside the workspace; always at least one category, never a push.
 */
export function unattendedRuleRefusal(
  rule: UnattendedRuleShape,
  opts: { home?: string } = {},
): string | undefined {
  const { scope, tool, match, categories } = rule;
  if (categories.includes('push')) return 'a job never pushes unattended: drop the push rule';
  if (categories.length === 0) return 'a rule needs at least one category';
  const outside = categories.includes('outside_workspace');
  const pairs: Record<PermissionRuleScope, readonly PermissionRuleMatch['kind'][]> = {
    exact: ['text'],
    prefix: ['words', 'folder'],
    category: ['categories'],
    folder: ['folder'],
    site: ['host'],
  };
  if (scope === 'folder' || scope === 'site') {
    return `a ${scope} rule is not offered to a job (P14)`;
  }
  if (!pairs[scope].includes(match.kind)) {
    return `a ${scope} rule never matches ${match.kind === 'categories' ? 'whole categories' : `a ${match.kind}`}`;
  }
  switch (match.kind) {
    case 'text':
      return match.text.trim() ? undefined : 'an exact rule needs what it matches';
    case 'words': {
      if (tool !== 'Bash') return 'a command prefix is a Bash rule';
      if (outside) {
        return 'a command prefix outside the workspace would cover the whole computer: allow exactly one command, or a folder';
      }
      return prefixRefusal(match.words);
    }
    case 'folder': {
      if (!groupOf(tool))
        return `a folder rule is for a tool that reads or writes files, not ${tool}`;
      if (!isAbsolute(match.folder)) return 'a folder rule needs an absolute folder';
      const folder = resolve(match.folder);
      const home = opts.home ?? homedir();
      if (dirname(folder) === folder || within(folder, home)) {
        return `${tildeOf(folder, home)} is too broad (the root or the home folder)`;
      }
      return undefined;
    }
    case 'categories':
      if (tool !== '*') return 'a category rule covers every tool (`*`)';
      if (outside) {
        return 'outside the workspace as a whole category would cover the whole computer: allow exactly one call, or a folder';
      }
      return undefined;
  }
}

/**
 * A job's unattended rule in words, computed from what it matches — the job card's line, never
 * the proposer's label. The "Allow similar" wording, plus the categories it is limited to.
 */
export function unattendedRuleLabel(
  rule: UnattendedRuleShape,
  opts: { home?: string } = {},
): string {
  const { tool, match, categories } = rule;
  const only = ` — only as ${categoryWords(categories)}`;
  switch (match.kind) {
    case 'text':
      return tool === 'Bash'
        ? `exactly: ${shorten(match.text)}${only}`
        : `${tool} exactly: ${shorten(match.text)}${only}`;
    case 'words':
      return `${match.words.join(' ')} … (and any further arguments)${only}`;
    case 'folder': {
      const doing = groupOf(tool) === 'read' ? 'reading' : 'writing and editing';
      return `${doing} under ${tildeOf(resolve(match.folder), opts.home ?? homedir())}/…${only}`;
    }
    case 'host':
      return `${tool} to ${match.host}${only}`;
    case 'categories':
      return `any call the table asks about only as ${categoryWords(categories)}`;
  }
}
