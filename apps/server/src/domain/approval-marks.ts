import { isAbsolute, join, relative, sep } from 'node:path';
import {
  approvalLogCategory,
  type ApprovalLogCategory,
  type ApprovalMarkMatch,
  type CommandPart,
  type PermissionAction,
  type ToolCall,
} from '@galactic/protocol';
import { partsOfCall } from './command-parts.js';
import {
  HARMLESS_DEVICES,
  PATH_FIELDS,
  classifyCommand,
  classifyToolCall,
  commandHead,
  cwdOf,
  isInsideWorkspace,
  lexCommand,
  pathsInCommand,
  resolvePath,
  type Classification,
  type PolicyContext,
} from './permissions.js';
import { onSite, proposePrefix } from './permission-rules.js';

/**
 * Approval marks (P13-14; design 2026-11-14-waykeeper-auto-mode §4.5): "Ask me next time" on a
 * logged Waykeeper approval makes a mark, and the Waykeeper forwards every later request that
 * implies the marked one. The mark is built from the approval with the kinds "Allow similar" uses,
 * turned around: a file action → the same category on that target or anything inside it; a
 * network call → the same site and its subdomains; another command → the same first words; any
 * other tool → the same tool.
 *
 * Pure: no I/O. A mark only ever makes the Waykeeper ask, so `markCovers` fails toward a match
 * whenever a target of the mark's category cannot be placed.
 */

/** The log categories a folder mark is made for, with their permission category. */
const FOLDER_CATEGORY: Partial<Record<ApprovalLogCategory, PermissionAction>> = {
  delete: 'destructive',
  outside: 'outside_workspace',
  edit: 'edit_workspace',
  read: 'read_workspace',
};

/** Longest prefix a mark keeps (`ApprovalMarkMatch` allows 20 words). */
const MAX_PREFIX_WORDS = 20;

/**
 * The mark made from one approval: `a.toolCall` as the event logged it, its `parts` when the event
 * carries them (else split again), its `action`; `ctx.cwd` is the approval's cwd. Always the same
 * JSON for the same approval (the store compares marks by `JSON.stringify`): keys in the schema's
 * order, folder paths de-duplicated and sorted, hosts lower-cased.
 */
export function markFromApproval(
  a: { toolCall: ToolCall; parts?: CommandPart[] | undefined; action?: PermissionAction },
  ctx: PolicyContext,
): ApprovalMarkMatch {
  const { toolCall } = a;
  if (toolCall.toolName !== 'Bash') {
    const c = classifyToolCall(toolCall, ctx);
    const files = toolPaths(toolCall);
    const category = c.actions[0];
    if (files.length > 0 && category !== undefined && files.every((p) => !/^~[^/]/.test(p))) {
      const cwd = cwdOf(ctx);
      return folderMark(
        category,
        files.map((p) => unalias(resolvePath(p, ctx, cwd), ctx)),
      );
    }
    const host = hostsOf(c)[0];
    if (host !== undefined) return siteMark(host);
    return { kind: 'tool', toolName: toolCall.toolName };
  }

  const parts = a.parts?.length ? a.parts : partsOfCall(toolCall, ctx);
  const whole = approvalLogCategory({ action: a.action, parts });
  const part = parts.find((p) => approvalLogCategory({ parts: [p] }) === whole) ?? parts[0];
  if (part === undefined) return { kind: 'tool', toolName: toolCall.toolName };

  const category = FOLDER_CATEGORY[whole];
  if (category !== undefined) {
    const placed = placeOf(part.text, ctx, cwdOf(ctx));
    if (!placed.unplaceable && placed.paths.length > 0) {
      return folderMark(
        category,
        placed.paths.map((p) => p.path),
      );
    }
  }
  if (whole === 'network') {
    const host = hostsOf(classifyCommand(part.text, ctx))[0];
    if (host !== undefined) return siteMark(host);
  }
  const words = proposePrefix(part.text) ?? partWords(part.text);
  if (words.length > 0) return { kind: 'prefix', words };
  return { kind: 'tool', toolName: toolCall.toolName };
}

/**
 * Whether a request implies the mark `match`: any of its parts (or the non-Bash call itself) does.
 * - `folder`: the part has `match.category` and one of its targets is a mark path or inside one —
 *   or cannot be placed (a variable, a substitution, `~user`, a `cd` it cannot follow): it asks.
 *   A glob target matches when it may reach into a mark path.
 * - `site`: a host the part visibly reaches is the mark's host or a subdomain of it.
 * - `prefix`: a command of the part starts with the mark's words (its wrapper or assignments in
 *   front skipped too).
 * - `tool`: the same tool.
 */
export function markCovers(
  match: ApprovalMarkMatch,
  req: { toolCall: ToolCall; parts: CommandPart[]; ctx: PolicyContext },
): boolean {
  const { toolCall, ctx } = req;
  if (match.kind === 'tool') return toolCall.toolName === match.toolName;

  if (toolCall.toolName !== 'Bash') {
    const c = classifyToolCall(toolCall, ctx);
    switch (match.kind) {
      case 'folder': {
        if (!c.actions.includes(match.category)) return false;
        const files = toolPaths(toolCall);
        if (files.some((p) => /^~[^/]/.test(p))) return true;
        const cwd = cwdOf(ctx);
        return files.some((p) =>
          inMark({ path: resolvePath(p, ctx, cwd), glob: false }, match.paths, ctx),
        );
      }
      case 'site':
        return hostsOf(c).some((h) => onSite(h, match.host));
      case 'prefix':
        return false;
    }
  }

  const parts = req.parts.length > 0 ? req.parts : partsOfCall(toolCall, ctx);
  switch (match.kind) {
    case 'folder':
      return foldersCover(match, parts, ctx);
    case 'site':
      return parts.some((p) =>
        hostsOf(classifyCommand(p.text, ctx)).some((h) => onSite(h, match.host)),
      );
    case 'prefix':
      return parts.some((p) =>
        lexCommand(p.text).commands.some(
          (c) =>
            startsWith(c.words, match.words) ||
            startsWith(c.words.slice(commandHead(c.words)), match.words),
        ),
      );
  }
}

/**
 * The folder test over a Bash call's parts, in order. A `cd` moves where relative targets resolve
 * for the parts after it; as in the splitter (`Splitter.outside`), every cwd the line has been at
 * counts, and a `cd` it cannot follow makes every later target of the category unplaceable.
 */
function foldersCover(
  match: Extract<ApprovalMarkMatch, { kind: 'folder' }>,
  parts: CommandPart[],
  ctx: PolicyContext,
): boolean {
  let cwd = cwdOf(ctx);
  const seen = new Set([cwd]);
  let unknownCwd = false;
  for (const part of parts) {
    if (part.categories.includes(match.category)) {
      if (unknownCwd) return true;
      for (const from of seen) {
        const placed = placeOf(part.text, ctx, from);
        if (placed.unplaceable) return true;
        if (placed.paths.some((p) => inMark(p, match.paths, ctx))) return true;
      }
    }
    const moved = cdTarget(part.text);
    if (moved === undefined) continue;
    if (moved === null || (moved === '~' && ctx.home === undefined)) unknownCwd = true;
    else {
      cwd = moved === '~' ? ctx.home! : resolvePath(moved, ctx, cwd);
      seen.add(cwd);
    }
  }
  return false;
}

/**
 * Where a `cd`/`pushd` part goes: `undefined` when the part is not one, `'~'` for home, `null`
 * when it cannot be followed (`cd -`, a variable, a substitution, `~user`), else the target.
 */
function cdTarget(text: string): string | null | undefined {
  const commands = lexCommand(text).commands;
  if (commands.length !== 1) return undefined;
  const words = commands[0]!.words;
  const h = commandHead(words);
  const name = words[h]?.toLowerCase();
  if (name !== 'cd' && name !== 'pushd') return undefined;
  const target = words.slice(h + 1).find((w) => w === '-' || !w.startsWith('-'));
  if (target === undefined || target === '' || target === '~') return '~';
  if (target === '-' || /[$`]/.test(target) || /^~[^/]/.test(target)) return null;
  return target;
}

interface Placed {
  /** Resolved, un-aliased. A glob target is its folder before the first glob segment. */
  path: string;
  glob: boolean;
}

/**
 * The targets a part names, resolved from `cwd`: every argument after the command's name that is
 * not an option, every file it redirects to, and what the gate reads as a path (`pathsInCommand`:
 * option values such as `--out=/x`). `unplaceable` when one of them uses a variable other than
 * `$HOME`/`$PWD`, a substitution or `~user`, or the part cannot be read at all.
 */
function placeOf(
  text: string,
  ctx: PolicyContext,
  cwd: string,
): { paths: Placed[]; unplaceable: boolean } {
  const lexed = lexCommand(text);
  if (lexed.opaque.length > 0) return { paths: [], unplaceable: true };
  const words: string[] = [];
  for (const c of lexed.commands) {
    words.push(...c.words.slice(commandHead(c.words) + 1).filter((w) => !w.startsWith('-')));
    for (const r of c.redirects) {
      if (r.op === '<<' || r.op === '<<-' || r.op === '<<<') continue;
      if ((r.op === '>&' || r.op === '<&') && /^(?:\d+-?|-)$/.test(r.target)) continue;
      words.push(r.target);
    }
  }
  const gate = pathsInCommand(text);
  if (gate.unresolvable.length > 0) return { paths: [], unplaceable: true };
  const paths: Placed[] = [];
  for (const raw of [...words, ...gate.paths]) {
    if (raw === '' || HARMLESS_DEVICES.has(raw)) continue;
    const word = raw.replace(/^\$(?:HOME\b|\{HOME\})/, '~').replace(/^\$(?:PWD\b|\{PWD\})/, cwd);
    if (/[$`]/.test(word) || /^~[^/]/.test(word)) return { paths: [], unplaceable: true };
    const segments = word.split('/');
    const g = segments.findIndex((s) => /[*?[\]{}]/.test(s));
    const plain =
      g < 0 ? word : segments.slice(0, g).join('/') || (word.startsWith('/') ? '/' : '.');
    paths.push({ path: unalias(resolvePath(plain, ctx, cwd), ctx), glob: g >= 0 });
  }
  return { paths, unplaceable: false };
}

/** Whether a target is a mark path or inside one; a glob also when a mark path is inside it. */
function inMark(p: Placed, markPaths: readonly string[], ctx: PolicyContext): boolean {
  const path = unalias(p.path, ctx);
  return markPaths.some((raw) => {
    const m = unalias(raw, ctx);
    return (
      isInsideWorkspace(path, { ...ctx, workspace: m, cwd: m }) ||
      (p.glob && isInsideWorkspace(m, { ...ctx, workspace: path, cwd: path }))
    );
  });
}

/** `p` rewritten from another spelling of the workspace or cwd (`ctx.aliases`) to the context's. */
function unalias(p: string, ctx: PolicyContext): string {
  for (const { from, to } of ctx.aliases ?? []) {
    const rel = relative(from, p);
    if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
      return join(to, rel);
    }
  }
  return p;
}

/** The paths a non-Bash tool names (`file_path`, `path`, …, and an ACP `paths` list). */
function toolPaths(call: ToolCall): string[] {
  const input =
    typeof call.input === 'object' && call.input !== null && !Array.isArray(call.input)
      ? (call.input as Record<string, unknown>)
      : {};
  const listed = Array.isArray(input['paths']) ? (input['paths'] as unknown[]) : [];
  return [...PATH_FIELDS.map((f) => input[f]), ...listed].filter(
    (v): v is string => typeof v === 'string' && v !== '',
  );
}

/** The hosts a classification's network findings visibly reach, lower-cased. */
function hostsOf(c: Classification): string[] {
  return c.findings
    .filter((f) => f.action === 'network')
    .flatMap((f) => f.hosts ?? [])
    .map((h) => h.toLowerCase());
}

/** The words of a part's first command, empty words left out, at most `MAX_PREFIX_WORDS`. */
function partWords(text: string): string[] {
  const first = lexCommand(text).commands[0]?.words ?? text.trim().split(/\s+/);
  return first.filter((w) => w !== '').slice(0, MAX_PREFIX_WORDS);
}

function startsWith(words: readonly string[], prefix: readonly string[]): boolean {
  return words.length >= prefix.length && prefix.every((w, i) => words[i] === w);
}

function folderMark(category: PermissionAction, paths: string[]): ApprovalMarkMatch {
  return { kind: 'folder', category, paths: [...new Set(paths)].sort() };
}

function siteMark(host: string): ApprovalMarkMatch {
  return { kind: 'site', host: host.toLowerCase() };
}
