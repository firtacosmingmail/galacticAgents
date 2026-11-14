import { isAbsolute, join, relative, resolve, sep } from 'node:path';
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

/**
 * A Steward's own folders (P13-16): a folder mark stores a path inside one as `{worktree}/<rest>`
 * or `{scratch}/<rest>`, and expands the token with the requesting Steward's folder, so a mark
 * made in one task's worktree applies to the same place in every other task's.
 */
export interface MarkRoots {
  worktree?: string | undefined;
  scratch?: string | undefined;
}

const ROOT_TOKENS = [
  ['{worktree}', 'worktree'],
  ['{scratch}', 'scratch'],
] as const;

/** `path` with the longest root it is equal to or inside replaced by that root's token. */
function tokenise(path: string, roots: MarkRoots | undefined): string {
  const found = ROOT_TOKENS.flatMap(([token, key]) => {
    const root = roots?.[key];
    if (root === undefined) return [];
    const rel = relative(resolve(root), path);
    const inside = rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    return inside ? [{ token, rel, length: resolve(root).length }] : [];
  }).sort((a, b) => b.length - a.length)[0];
  if (!found) return path;
  return found.rel === '' ? found.token : `${found.token}/${found.rel.split(sep).join('/')}`;
}

/** A mark path with its token expanded to the requester's folder; `undefined` without that root. */
function expand(path: string, roots: MarkRoots | undefined): string | undefined {
  for (const [token, key] of ROOT_TOKENS) {
    if (path !== token && !path.startsWith(`${token}/`)) continue;
    const root = roots?.[key];
    return root === undefined ? undefined : join(resolve(root), path.slice(token.length));
  }
  return path;
}

/** Longest prefix a mark keeps (`ApprovalMarkMatch` allows 20 words). */
const MAX_PREFIX_WORDS = 20;

/**
 * The mark made from one approval: `a.toolCall` as the event logged it, its `parts` when the event
 * carries them (else split again), its `action`; `ctx.cwd` is the approval's cwd. Always the same
 * JSON for the same approval (the store compares marks by `JSON.stringify`): keys in the schema's
 * order, folder paths tokenised by `roots` (the approving Steward's worktree and scratch folder),
 * then de-duplicated and sorted, hosts lower-cased.
 */
export function markFromApproval(
  a: { toolCall: ToolCall; parts?: CommandPart[] | undefined; action?: PermissionAction },
  ctx: PolicyContext,
  roots?: MarkRoots,
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
        roots,
      );
    }
    // A site mark only for a network call (an MCP tool whose text holds a URL keeps a tool mark).
    const host = c.actions.includes('network')
      ? [...inputHosts(toolCall), ...hostsOf(c)][0]
      : undefined;
    if (host !== undefined) return siteMark(host);
    return { kind: 'tool', toolName: toolCall.toolName };
  }

  const parts = a.parts?.length ? a.parts : partsOfCall(toolCall, ctx);
  const whole = approvalLogCategory({ action: a.action, parts });
  const part = parts.find((p) => approvalLogCategory({ parts: [p] }) === whole) ?? parts[0];
  if (part === undefined) return { kind: 'tool', toolName: toolCall.toolName };

  const category = FOLDER_CATEGORY[whole];
  const from = category !== undefined ? approvedCwd(toolCall, parts, part, ctx) : undefined;
  if (category !== undefined && from !== undefined) {
    const placed = placeOf(part.text, ctx, from);
    if (!placed.unplaceable && placed.paths.length > 0) {
      return folderMark(
        category,
        placed.paths.map((p) => p.path),
        roots,
      );
    }
  }
  if (whole === 'network') {
    // The same reading as `markCovers`: the part's own words first (a POST or upload has no
    // classifier hosts), the classifier's as a fallback.
    const host = [...wordHosts(part.text), ...hostsOf(classifyCommand(part.text, ctx))][0];
    if (host !== undefined) return siteMark(host);
  }
  const words = prefixWords(part.text);
  if (words.length > 0) return { kind: 'prefix', words };
  return { kind: 'tool', toolName: toolCall.toolName };
}

/**
 * The cwd the approved `part` ran from: the approval's own, moved by the `cd`s before it. Only when
 * that cwd is certain — every `cd` of the line runs in the line's own shell, unconditionally and in
 * order (`ownShell`: not in `( … )`, `$(…)`, a nested shell or after `&&`/`||`), and each can be
 * followed; otherwise `undefined` (no folder mark: the line may have been at more than one cwd).
 */
function approvedCwd(
  toolCall: ToolCall,
  parts: CommandPart[],
  part: CommandPart,
  ctx: PolicyContext,
): string | undefined {
  let cwd = cwdOf(ctx);
  const before = parts.slice(0, parts.indexOf(part));
  const cds = before.map((p) => cdTarget(p.text)).filter((t) => t !== undefined);
  if (cds.length === 0) return cwd;
  const input = toolCall.input as { command?: unknown } | null;
  const line = typeof input?.command === 'string' ? lexCommand(input.command) : undefined;
  const lineCds = line?.commands.filter((c) => {
    const name = c.words[commandHead(c.words)]?.toLowerCase();
    return name === 'cd' || name === 'pushd';
  });
  if (
    line === undefined ||
    line.opaque.length > 0 ||
    lineCds === undefined ||
    lineCds.length !== parts.filter((p) => cdTarget(p.text) !== undefined).length ||
    lineCds.some((c) => !c.ownShell)
  ) {
    return undefined;
  }
  for (const target of cds) {
    if (target === null || (target === '~' && ctx.home === undefined)) return undefined;
    cwd = target === '~' ? ctx.home! : resolvePath(target, ctx, cwd);
  }
  return cwd;
}

/**
 * Whether a request implies the mark `match`: any of its parts (or the non-Bash call itself) does.
 * A folder mark's `{worktree}`/`{scratch}` paths are first expanded with the requesting Steward's
 * `roots`; a token whose root is not given matches nothing.
 * - `folder`: the part has `match.category` and one of its targets is a mark path or inside one —
 *   or cannot be placed (a variable, a substitution, `~user`, a `cd` it cannot follow): it asks.
 *   A glob target matches when it may reach into a mark path; for a delete mark, so does a target
 *   that contains a mark path (deleting a parent deletes the marked folder).
 * - `site`: a host the part visibly reaches is the mark's host or a subdomain of it.
 * - `prefix`: a command of the part starts with the mark's words (its wrapper or assignments in
 *   front skipped too).
 * - `tool`: the same tool.
 */
export function markCovers(
  given: ApprovalMarkMatch,
  req: { toolCall: ToolCall; parts: CommandPart[]; ctx: PolicyContext },
  roots?: MarkRoots,
): boolean {
  const { toolCall, ctx } = req;
  if (given.kind === 'tool') return toolCall.toolName === given.toolName;
  let match = given;
  if (given.kind === 'folder') {
    const paths = given.paths.map((p) => expand(p, roots)).filter((p) => p !== undefined);
    if (paths.length === 0) return false;
    match = { ...given, paths };
  }

  if (toolCall.toolName !== 'Bash') {
    const c = classifyToolCall(toolCall, ctx);
    switch (match.kind) {
      case 'folder': {
        if (!c.actions.includes(match.category)) return false;
        const files = toolPaths(toolCall);
        if (files.some((p) => /^~[^/]/.test(p))) return true;
        const cwd = cwdOf(ctx);
        return files.some((p) =>
          inMark({ path: resolvePath(p, ctx, cwd), glob: false }, match, ctx),
        );
      }
      case 'site':
        return [...inputHosts(toolCall), ...hostsOf(c)].some((h) => onSite(h, match.host));
      case 'prefix':
        return false;
    }
  }

  const parts = req.parts.length > 0 ? req.parts : partsOfCall(toolCall, ctx);
  switch (match.kind) {
    case 'folder':
      return foldersCover(match, parts, ctx);
    case 'site':
      // Hosts read from the part's own words, whether the request writes or not (a POST, `-d`,
      // `--post-data`, an upload: the classifier names no hosts for those), plus the classifier's.
      return parts.some((p) =>
        [...wordHosts(p.text), ...hostsOf(classifyCommand(p.text, ctx))].some((h) =>
          onSite(h, match.host),
        ),
      );
    case 'prefix': {
      const marked = normalisedWords(match.words);
      return parts.some((p) =>
        lexCommand(p.text).commands.some(
          (c) =>
            startsWith(c.words, match.words) ||
            startsWith(c.words.slice(commandHead(c.words)), match.words) ||
            startsWith(normalisedWords(c.words.slice(commandHead(c.words))), marked),
        ),
      );
    }
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
  const edits = match.category === 'edit_workspace';
  for (const part of parts) {
    if (part.categories.includes(match.category)) {
      if (unknownCwd) return true;
      for (const from of seen) {
        const placed = placeOf(part.text, ctx, from, true);
        if (placed.unplaceable) return true;
        if (placed.paths.some((p) => inMark(p, match, ctx))) return true;
      }
    }
    // An edit mark also catches the same file edited from the shell, whatever the part's
    // category (the gate reads `sed -i`, `>`, `cp` as running in the workspace).
    if (edits) {
      for (const from of seen) {
        const edited = shellEdits(part.text, ctx, from);
        if (edited.unplaceable) return true;
        if (edited.paths.length > 0 && unknownCwd) return true;
        if (edited.paths.some((p) => inMark(p, match, ctx))) return true;
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

/** Commands whose plain arguments are the files they act on. */
const FILE_COMMANDS: ReadonlySet<string> = new Set([
  'rm',
  'rmdir',
  'unlink',
  'mv',
  'cp',
  'shred',
  'trash',
]);

/**
 * The words of one simple command that name its targets: every non-option argument of a command
 * whose arguments are files (`FILE_COMMANDS`); `find`'s start paths (`.` when it names none);
 * `git clean`'s pathspecs (the cwd when it names none) and `git rm`'s, under a `-C <dir>` given
 * in front. Any other command: none here — its targets are what the gate reads as paths
 * (`pathsInCommand`).
 */
function targetWords(words: readonly string[]): string[] {
  const h = commandHead([...words]);
  const name = words[h]?.split('/').pop()?.toLowerCase();
  const args = words.slice(h + 1);
  if (name !== undefined && FILE_COMMANDS.has(name)) return args.filter((w) => !w.startsWith('-'));
  if (name === 'find') {
    const end = args.findIndex((w) => w.startsWith('-') || w === '(' || w === '!');
    const starts = end < 0 ? args : args.slice(0, end);
    return starts.length > 0 ? starts : ['.'];
  }
  if (name === 'git') {
    const { dirs, rest } = gitGlobals(args);
    const under = (spec: string) =>
      dirs.reduceRight((acc, d) => (isAbsolute(acc) ? acc : join(d, acc)), spec);
    if (rest[0] === 'clean') {
      const specs: string[] = [];
      for (let k = 1; k < rest.length; k++) {
        const a = rest[k]!;
        if (a === '-e' || a === '--exclude') k++;
        else if (!a.startsWith('-')) specs.push(a);
      }
      return (specs.length > 0 ? specs : ['.']).map(under);
    }
    if (rest[0] === 'rm') {
      const dashes = rest.indexOf('--');
      const specs =
        dashes < 0
          ? rest.slice(1).filter((a) => !a.startsWith('-'))
          : [...rest.slice(1, dashes).filter((a) => !a.startsWith('-')), ...rest.slice(dashes + 1)];
      return specs.map(under);
    }
  }
  return [];
}

/** git's global options that take the next word as their value (`git -C dir status`). */
const GIT_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--config-env',
]);

/**
 * git's arguments with its global options in front skipped (`-C <dir>`, `-c <k=v>`,
 * `--git-dir=…`, `--no-pager`, …): `rest` starts at the subcommand; `dirs` are the `-C` folders.
 */
function gitGlobals(args: readonly string[]): { dirs: string[]; rest: string[] } {
  const dirs: string[] = [];
  let k = 0;
  while (k < args.length && args[k]!.startsWith('-') && args[k] !== '--') {
    const a = args[k]!;
    if (GIT_VALUE_OPTIONS.has(a)) {
      if (a === '-C' && args[k + 1] !== undefined) dirs.push(args[k + 1]!);
      k += 2;
    } else k++;
  }
  return { dirs, rest: args.slice(k) };
}

/**
 * A command's words from its name on, for matching and deriving prefix marks: the name as its
 * basename (`/usr/bin/git` → `git`) and, for git, its global options skipped (`git -C . branch`
 * → `git branch`).
 */
function normalisedWords(words: readonly string[]): string[] {
  if (words.length === 0) return [];
  const name = words[0]!.split('/').pop() || words[0]!;
  if (name !== 'git') return [name, ...words.slice(1)];
  return [name, ...gitGlobals(words.slice(1)).rest];
}

/** A plain word that names a subcommand (as the rule chooser reads one). */
const SUBCOMMAND_WORD = /^[A-Za-z][A-Za-z0-9:_-]*$/;

/**
 * The words of a prefix mark: the chooser's prefix (`proposePrefix`) when it has one, else all
 * the words of the part's first command; both from the normalised words (`normalisedWords`).
 */
function prefixWords(text: string): string[] {
  const proposed = proposePrefix(text);
  const all = partWords(text);
  const n = normalisedWords(all);
  if (proposed === undefined) return n.slice(0, MAX_PREFIX_WORDS);
  const next = n[1];
  return next !== undefined && SUBCOMMAND_WORD.test(next) ? n.slice(0, 2) : n.slice(0, 1);
}

/**
 * The targets a part names, resolved from `cwd`: its commands' `targetWords` and what the gate
 * reads as a path (`pathsInCommand`: absolute, `~`, `..` paths, option values such as `--out=/x`,
 * redirect targets). `unplaceable` when an argument or redirect target uses a variable other than
 * `$HOME`/`$PWD`, a substitution or `~user`, or the part cannot be read at all. With `anyArg`
 * (matching, never deriving), a part where none of those names a target has every plain
 * non-option argument read as a possible one: the part is in the mark's category, so it acts on
 * something, and a mark only ever makes the Waykeeper ask.
 */
function placeOf(
  text: string,
  ctx: PolicyContext,
  cwd: string,
  anyArg = false,
): { paths: Placed[]; unplaceable: boolean } {
  const lexed = lexCommand(text);
  if (lexed.opaque.length > 0) return { paths: [], unplaceable: true };
  const gate = pathsInCommand(text);
  if (gate.unresolvable.length > 0) return { paths: [], unplaceable: true };
  const words: string[] = [];
  const plainArgs: string[] = [];
  const names = new Set<string>();
  for (const c of lexed.commands) {
    const h = commandHead(c.words);
    const args = c.words.slice(h + 1);
    if (c.words[h] !== undefined) names.add(c.words[h]);
    const shown = [
      ...args,
      ...c.redirects.filter((r) => !HEREDOC_OPS.has(r.op)).map((r) => r.target),
    ];
    if (shown.some((w) => unplaceable(expandKnown(w, cwd)))) {
      return { paths: [], unplaceable: true };
    }
    words.push(...targetWords(c.words));
    plainArgs.push(...args.filter((w) => !w.startsWith('-')));
  }
  // Deriving, a command name the gate reads as a path (`/usr/bin/git`) is not a target.
  const fromGate = anyArg ? gate.paths : gate.paths.filter((w) => !names.has(w));
  const raws = [...words, ...fromGate].filter((w) => w !== '' && !HARMLESS_DEVICES.has(w));
  const paths: Placed[] = [];
  for (const raw of raws.length === 0 && anyArg ? plainArgs : raws) {
    const placed = placeWord(raw, ctx, cwd);
    if (placed === 'unplaceable') return { paths: [], unplaceable: true };
    if (placed !== undefined) paths.push(placed);
  }
  return { paths, unplaceable: false };
}

/** One target word resolved from `cwd`; a glob as its folder before the first glob segment. */
function placeWord(
  raw: string,
  ctx: PolicyContext,
  cwd: string,
): Placed | 'unplaceable' | undefined {
  if (raw === '' || HARMLESS_DEVICES.has(raw)) return undefined;
  const word = expandKnown(raw, cwd);
  if (unplaceable(word)) return 'unplaceable';
  const segments = word.split('/');
  const g = segments.findIndex((s) => /[*?[\]{}]/.test(s));
  const plain = g < 0 ? word : segments.slice(0, g).join('/') || (word.startsWith('/') ? '/' : '.');
  return { path: unalias(resolvePath(plain, ctx, cwd), ctx), glob: g >= 0 };
}

/** Redirections that write their target. */
const WRITE_REDIRECTS: ReadonlySet<string> = new Set(['>', '>>', '>|', '&>', '&>>', '<>', '>&']);

/**
 * The files a part edits from the shell, resolved from `cwd`: write-redirect targets, the files
 * of `sed -i`, `tee`, `truncate`, `dd of=`, and the destination of `cp`/`mv`/`install` (with
 * `<dest>/<source name>` too, in case the destination is a folder). `unplaceable` when one of
 * those cannot be placed or the part cannot be read.
 */
function shellEdits(
  text: string,
  ctx: PolicyContext,
  cwd: string,
): { paths: Placed[]; unplaceable: boolean } {
  const lexed = lexCommand(text);
  if (lexed.opaque.length > 0) return { paths: [], unplaceable: true };
  const raws: string[] = [];
  for (const c of lexed.commands) {
    for (const r of c.redirects) {
      if (!WRITE_REDIRECTS.has(r.op) || /^(\d+|-)$/.test(r.target)) continue;
      raws.push(r.target);
    }
    const h = commandHead(c.words);
    const name = c.words[h]?.split('/').pop()?.toLowerCase();
    const args = c.words.slice(h + 1);
    const plain = args.filter((w) => !w.startsWith('-'));
    if (name === 'sed' && args.some((a) => /^(-[a-zA-Z]*i|--in-place)/.test(a)))
      raws.push(...plain);
    else if (name === 'tee' || name === 'truncate') raws.push(...plain);
    else if (name === 'dd')
      raws.push(...args.filter((a) => a.startsWith('of=')).map((a) => a.slice(3)));
    else if (name === 'cp' || name === 'mv' || name === 'install') {
      const t = args.findIndex((a) => a === '-t' || a === '--target-directory');
      const eq = args.find((a) => a.startsWith('--target-directory='));
      const dest =
        t >= 0
          ? args[t + 1]
          : eq !== undefined
            ? eq.slice('--target-directory='.length)
            : plain.at(-1);
      if (dest === undefined) continue;
      const sources = plain.filter(
        (w, i) => w !== dest || (t < 0 && eq === undefined && i < plain.length - 1),
      );
      raws.push(dest, ...sources.map((s) => `${dest}/${s.split('/').filter(Boolean).pop() ?? s}`));
    }
  }
  const paths: Placed[] = [];
  for (const raw of raws) {
    const placed = placeWord(raw, ctx, cwd);
    if (placed === 'unplaceable') return { paths: [], unplaceable: true };
    if (placed !== undefined) paths.push(placed);
  }
  return { paths, unplaceable: false };
}

const HEREDOC_OPS: ReadonlySet<string> = new Set(['<<', '<<-', '<<<']);

/** `$HOME`/`$PWD` at the start of a word, as `~` and the cwd. */
function expandKnown(word: string, cwd: string): string {
  return word.replace(/^\$(?:HOME\b|\{HOME\})/, '~').replace(/^\$(?:PWD\b|\{PWD\})/, cwd);
}

/** A word with an expansion the engine cannot read, or someone else's home (`~user`). */
function unplaceable(word: string): boolean {
  return /[$`]/.test(word) || /^~[^/]/.test(word);
}

/**
 * Whether a target implies the folder mark: it is a mark path or inside one; a glob, or any target
 * of a delete mark, also when a mark path is inside it. Compared ignoring case too (macOS file
 * systems are case-insensitive: `rm -rf NODE_MODULES` deletes `node_modules`), which can only
 * make the Waykeeper ask.
 */
function inMark(
  p: Placed,
  match: Extract<ApprovalMarkMatch, { kind: 'folder' }>,
  ctx: PolicyContext,
): boolean {
  const path = unalias(p.path, ctx);
  const contains = p.glob || match.category === 'destructive';
  return match.paths.some((raw) => {
    const m = unalias(raw, ctx);
    return (
      isInsideWorkspace(path, { ...ctx, workspace: m, cwd: m }) ||
      (contains && isInsideWorkspace(m, { ...ctx, workspace: path, cwd: path })) ||
      within(m, path) ||
      (contains && within(path, m))
    );
  });
}

/** Whether `child` is `parent` or inside it, both absolute, ignoring case. */
function within(parent: string, child: string): boolean {
  if (!isAbsolute(parent) || !isAbsolute(child)) return false;
  const rel = relative(resolve(parent).toLowerCase(), resolve(child).toLowerCase());
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
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

/** A word that starts with a URL scheme (`https://`, `ftp://`, …). */
const SCHEMED = /^[a-z][a-z0-9+.-]*:\/\//i;
/** A schemeless `host[:port][/path]`, with an optional `user@` in front. */
const HOST_LIKE = /^(?:[^\s/@]+@)?[a-z0-9-]+(?:\.[a-z0-9-]+)+\.?(?::\d+)?(?:[/?#]|$)/i;
/** An scp-style git remote: `user@host:path`. */
const SCP_LIKE = /^[^\s/@:]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)\.?:/i;

/**
 * The host a word names, or `undefined`: the word, or an option's value after `=` (`--url=…`),
 * parsed as a URL (`https://` put in front of a schemeless `host/path`), lower-cased, its
 * trailing dot stripped, userinfo and port dropped. `rank` orders a derivation: a URL with a
 * scheme first, then a `host/path`, then a bare host-like word (which may be a file name).
 */
function hostOfWord(word: string): { host: string; rank: number } | undefined {
  const eq = word.indexOf('=');
  for (const w of eq > 0 ? [word, word.slice(eq + 1)] : [word]) {
    const scp = SCP_LIKE.exec(w);
    let url: string | undefined;
    let rank = 0;
    if (SCHEMED.test(w)) url = w;
    else if (scp) return { host: scp[1]!.toLowerCase(), rank: 1 };
    else if (HOST_LIKE.test(w)) {
      url = `https://${w}`;
      rank = /[/@:?#]/.test(w) ? 1 : 2;
    }
    if (url === undefined) continue;
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase().replace(/\.+$/, '');
    } catch {
      continue;
    }
    if (host !== '') return { host, rank };
  }
  return undefined;
}

/**
 * The hosts a part's own words name (`hostOfWord` over every word of every command), whether the
 * request writes or not; ordered for a derivation (a URL with a scheme first).
 */
function wordHosts(text: string): string[] {
  return lexCommand(text)
    .commands.flatMap((c) => c.words)
    .map(hostOfWord)
    .filter((h) => h !== undefined)
    .map((h, i) => ({ ...h, i }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((h) => h.host);
}

/** The hosts the string inputs of a non-Bash call name with a scheme (a WebFetch's `url`). */
function inputHosts(call: ToolCall): string[] {
  const input =
    typeof call.input === 'object' && call.input !== null && !Array.isArray(call.input)
      ? (call.input as Record<string, unknown>)
      : {};
  return Object.values(input)
    .filter((v): v is string => typeof v === 'string' && SCHEMED.test(v))
    .map(hostOfWord)
    .filter((h) => h !== undefined)
    .map((h) => h.host);
}

/**
 * The words of a part's first command from its name on (assignments and wrappers in front left
 * out, as `markCovers` also matches from there), empty words left out, at most `MAX_PREFIX_WORDS`.
 */
function partWords(text: string): string[] {
  const all = lexCommand(text).commands[0]?.words ?? text.trim().split(/\s+/);
  const h = commandHead(all);
  const first = h < all.length ? all.slice(h) : all;
  return first.filter((w) => w !== '').slice(0, MAX_PREFIX_WORDS);
}

function startsWith(words: readonly string[], prefix: readonly string[]): boolean {
  return words.length >= prefix.length && prefix.every((w, i) => words[i] === w);
}

function folderMark(
  category: PermissionAction,
  paths: string[],
  roots: MarkRoots | undefined,
): ApprovalMarkMatch {
  return {
    kind: 'folder',
    category,
    paths: [...new Set(paths.map((p) => tokenise(p, roots)))].sort(),
  };
}

function siteMark(host: string): ApprovalMarkMatch {
  return { kind: 'site', host: host.toLowerCase() };
}
