import * as nodeFs from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Id } from '@galactic/protocol';
import { GALACTIC_DIR, worktreeRoot } from '../workspace/workspaces.js';

/**
 * Where a deliverable may point (P9-02; TECHNOLOGY §9.2, SPEC decisions 121, 122). Pure checks
 * over a small file-system facade (`PathFs`), so tests run on temporary folders and can swap a
 * file between the check and the open.
 *
 * - **Real paths.** Every path — the roots and the path checked — goes through
 *   `realpathSync.native`, which follows every symlink and, on macOS, returns the name as it is
 *   on disk (its case and its Unicode normalisation). `fs.realpathSync` (and `canonical()`) keep
 *   the spelling they were given, so `Proj/FILE.txt` and `proj/file.txt` would compare as
 *   different strings on a case-insensitive APFS volume. Containment in a root compares exact
 *   strings of on-disk names (a mismatch refuses: fail closed); the refused areas (`.git`,
 *   `.galactic`, the data folder, secret names) compare case-folded NFC names, so `.GIT/config`
 *   is still refused.
 * - **Allowed roots**: the workspace, the repository it belongs to, the task's worktree root
 *   (derived by `worktreeRoot`, never a stored path) and the deliverables folder (inside the
 *   workspace anyway). Refused inside them: `.git`, `.galactic/` except the task's own worktree,
 *   the server's data folder, `/` and the home directory itself.
 * - **Secret names** (agents only): `SECRET_NAME_RULES`.
 * - **Strays** (decision 122): outside the roots, an agent's path is accepted only in a temporary
 *   folder, owned by the server's user, not a link itself, born after the agent's first spawn.
 * - **Reading** (`openChecked`): re-check, open the final component with `O_NOFOLLOW`, compare the
 *   descriptor's `(dev, ino)` with the checked path's; a mismatch is `changed`.
 *
 * Known limit: a hard link inside the project to a file elsewhere has the inside path as its real
 * path, so it passes (`realpath` cannot tell; refusing `nlink > 1` would refuse every file pnpm
 * links into `node_modules`). It is the same exposure as an agent copying a secret into an
 * ordinary file (TECHNOLOGY §9.9), and hard links cannot cross volumes.
 */

/** The subset of `fs.Stats` the checks read. */
export interface PathStat {
  dev: number;
  ino: number;
  uid: number;
  mode: number;
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
  ctimeMs: number;
  nlink: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** The file-system calls the checks make; `nodePathFs` by default. */
export interface PathFs {
  /** Every symlink followed; on-disk names (`realpathSync.native`). */
  realpath(path: string): string;
  lstat(path: string): PathStat;
  stat(path: string): PathStat;
  open(path: string, flags: number): number;
  fstat(fd: number): PathStat;
  read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number;
  close(fd: number): void;
}

export const nodePathFs: PathFs = {
  realpath: (p) => nodeFs.realpathSync.native(p),
  lstat: (p) => nodeFs.lstatSync(p),
  stat: (p) => nodeFs.statSync(p),
  open: (p, flags) => nodeFs.openSync(p, flags),
  fstat: (fd) => nodeFs.fstatSync(fd),
  read: (fd, buffer, offset, length, position) =>
    nodeFs.readSync(fd, buffer, offset, length, position),
  close: (fd) => nodeFs.closeSync(fd),
};

/** `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`: never follow a final link, never hang on a FIFO. */
export const CHECKED_OPEN_FLAGS =
  nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW | nodeFs.constants.O_NONBLOCK;

/** Where the project's own paths are. Paths need not be canonical; `deliverableRoots` makes them so. */
export interface RootsInput {
  /** The project's workspace (or a standalone task's). */
  workspace: string;
  /** `Project.meta.workspace.repoRoot`, when the workspace is a sub-folder of a repository. */
  repoRoot?: string;
  /** The task whose own worktree is allowed (`worktreeRoot(workspace, taskId)`). */
  taskId?: Id;
  /** `Project.meta.deliverablesFolder` (or a standalone task's), once made. */
  deliverablesFolder?: string;
}

/** Places refused whatever the roots say. */
export interface RefusedPlaces {
  /** The server's data folder (`~/.galactic` or `GALACTIC_HOME`). */
  dataDir: string;
  /** Default `os.homedir()`. */
  home?: string;
}

/** The canonical roots of one project or task, with the places refused inside them. */
export interface DeliverableRoots {
  workspace: string;
  repoRoot?: string;
  worktree?: string;
  deliverablesFolder?: string;
  dataDir: string;
  home: string;
}

export type PathWhere = 'worktree' | 'deliverables' | 'workspace' | 'repository' | 'stray';

export type PathRefusalCode =
  /** Malformed: empty, a NUL byte, relative without a working folder, too long, not a file or folder. */
  | 'invalid'
  /** Nothing there (or it cannot be reached). */
  | 'missing'
  /** Outside every root (and not an acceptable stray). */
  | 'outside'
  /** Inside a root but in a refused area: `.git`, `.galactic`, the data folder, `/`, home. */
  | 'refused_area'
  /** A name that usually holds secrets (agents only). */
  | 'secret'
  /** In a temporary folder but not an acceptable stray (a link, another owner, too old). */
  | 'stray_refused'
  /** The file changed between the check and the open (HTTP 409 `changed`). */
  | 'changed';

export interface PathRefusal {
  ok: false;
  code: PathRefusalCode;
  /** For the agent's tool result or the panel; names the path as given. */
  reason: string;
}

export interface PathAccepted {
  ok: true;
  /** The real path (canonical, on-disk names): what a deliverable stores and what is read. */
  path: string;
  /** Which root holds it (the most specific). */
  where: PathWhere;
  type: 'file' | 'folder';
  /** `stat` of the real path at the check. */
  stat: PathStat;
}

export type PathCheck = PathAccepted | PathRefusal;

/** What makes a temporary-folder path an acceptable stray (decision 122). */
export interface StrayRule {
  /** When the agent's first `agent.spawned` was logged (ms); a stray must be born after it − 1 s. */
  firstSpawnAt: number;
  /** The server's uid; default `process.getuid()`. */
  uid?: number;
  /** Temporary folders; default `os.tmpdir()` and `/private/tmp`, real paths. */
  tmpDirs?: string[];
}

export interface CheckOptions {
  /** Resolves a relative path (the agent's working folder); a relative path without it is refused. */
  cwd?: string;
  /** Refuse secret-looking names (`SECRET_NAME_RULES`): agents' declarations and their re-checks. */
  secretNames?: boolean;
  /** Accept a stray in a temporary folder (an agent's declaration only, before it is copied). */
  stray?: StrayRule;
}

/** Longest path accepted before touching the disk (macOS `PATH_MAX` is 1024). */
export const MAX_PATH_LENGTH = 4096;

/** Folded for the refused-area comparisons: NFC and lower case (APFS is case-insensitive by default). */
export function foldName(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function isInsideFolded(child: string, parent: string): boolean {
  return isInside(foldName(child), foldName(parent));
}

function components(rel: string): string[] {
  return rel === '' ? [] : rel.split(sep).filter((c) => c !== '');
}

/** The real path of `path`'s longest existing prefix plus the rest as written. */
export function canonicalWith(path: string, fs: PathFs = nodePathFs): string {
  const abs = resolve(path);
  let existing = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(fs.realpath(existing), ...rest);
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return abs;
      rest.unshift(basename(existing));
      existing = parent;
    }
  }
}

/** The canonical roots for one project (and task). */
export function deliverableRoots(
  input: RootsInput,
  places: RefusedPlaces,
  fs: PathFs = nodePathFs,
): DeliverableRoots {
  const workspace = canonicalWith(input.workspace, fs);
  return {
    workspace,
    ...(input.repoRoot ? { repoRoot: canonicalWith(input.repoRoot, fs) } : {}),
    ...(input.taskId
      ? { worktree: canonicalWith(worktreeRoot(input.workspace, input.taskId), fs) }
      : {}),
    ...(input.deliverablesFolder
      ? { deliverablesFolder: canonicalWith(input.deliverablesFolder, fs) }
      : {}),
    dataDir: canonicalWith(places.dataDir, fs),
    home: canonicalWith(places.home ?? homedir(), fs),
  };
}

/**
 * Secret-looking names (TECHNOLOGY §9.2, decision 121), matched against folded basenames: `.env`,
 * `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keychain*`, private SSH keys, `.npmrc`,
 * `.netrc`, `.pypirc`, `.git-credentials`, `credentials*`.
 */
export const SECRET_NAME_RULES: readonly RegExp[] = [
  /^\.env$/,
  /^\.env\..*/,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.pfx$/,
  /\.keychain/,
  /^id_rsa/,
  /^id_dsa/,
  /^id_ecdsa/,
  /^id_ed25519/,
  /^\.npmrc$/,
  /^\.netrc$/,
  /^\.pypirc$/,
  /^\.git-credentials$/,
  /^credentials/,
];

/** Configuration folders whose contents are all secret (any component of the path). */
export const SECRET_FOLDERS: readonly string[] = ['.ssh', '.aws', '.gnupg', '.docker', '.kube'];

/** Whether a basename looks like it holds secrets. */
export function isSecretName(name: string): boolean {
  const folded = foldName(name);
  return SECRET_NAME_RULES.some((rule) => rule.test(folded)) || SECRET_FOLDERS.includes(folded);
}

function refuse(code: PathRefusalCode, reason: string): PathRefusal {
  return { ok: false, code, reason };
}

function errCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | undefined)?.code;
}

/** The roots in order of specificity: the first that holds a path names where it is. */
function rootList(roots: DeliverableRoots): [PathWhere, string][] {
  const list: [PathWhere, string][] = [];
  if (roots.worktree) list.push(['worktree', roots.worktree]);
  if (roots.deliverablesFolder) list.push(['deliverables', roots.deliverablesFolder]);
  list.push(['workspace', roots.workspace]);
  if (roots.repoRoot) list.push(['repository', roots.repoRoot]);
  return list;
}

function defaultTmpDirs(fs: PathFs): string[] {
  const dirs = new Set<string>();
  for (const d of [tmpdir(), '/private/tmp', '/tmp']) {
    try {
      dirs.add(fs.realpath(d));
    } catch {
      // not on this system
    }
  }
  return [...dirs];
}

/** Why `real` (inside a root, or a stray) lies in a refused area, or `undefined`. */
function refusedArea(
  real: string,
  where: PathWhere,
  roots: DeliverableRoots,
  base: string,
): string | undefined {
  if (real === '/' || foldName(real) === foldName(roots.home)) {
    return 'it is / or the home folder itself';
  }
  if (isInsideFolded(real, roots.dataDir) || isInsideFolded(roots.dataDir, real)) {
    return "it is in (or contains) the server's data folder";
  }
  const parts = components(relative(base, real)).map(foldName);
  if (parts.includes('.git')) return 'it is inside a .git folder';
  // Below the task's own worktree `base` is the worktree, so its own `.galactic/` prefix is not
  // among `parts`; anywhere else `.galactic/` is another task's worktree or the server's files.
  if (parts.includes(GALACTIC_DIR)) {
    return "it is inside .galactic/ (another task's worktree or the server's own files)";
  }
  return undefined;
}

function secretIn(real: string, requested: string, base: string): string | undefined {
  for (const name of [basename(real), basename(requested)]) {
    if (isSecretName(name)) return `"${name}" looks like it holds secrets`;
  }
  const folder = components(relative(base, real))
    .map(foldName)
    .find((c) => SECRET_FOLDERS.includes(c));
  return folder ? `it is inside a ${folder} folder, which holds secrets` : undefined;
}

/**
 * Checks a path against a project's (or task's) roots, on its real path. Used on declaration (an
 * agent's: `secretNames` and `stray`; the user's: neither) and again before every read, view,
 * download or open (`openChecked` does it).
 */
export function checkPath(
  path: string,
  roots: DeliverableRoots,
  opts: CheckOptions = {},
  fs: PathFs = nodePathFs,
): PathCheck {
  if (typeof path !== 'string' || path.trim() === '') return refuse('invalid', 'no path given');
  if (path.includes('\0')) return refuse('invalid', 'the path contains a NUL byte');
  if (path.length > MAX_PATH_LENGTH) return refuse('invalid', 'the path is too long');
  if (!isAbsolute(path) && !opts.cwd) {
    return refuse('invalid', `${path} is relative and there is no working folder to resolve it`);
  }
  const requested = isAbsolute(path) ? resolve(path) : resolve(opts.cwd as string, path);

  let real: string;
  let stat: PathStat;
  try {
    real = fs.realpath(requested);
    stat = fs.stat(real);
  } catch (e) {
    const code = errCode(e);
    if (code === 'ENAMETOOLONG') return refuse('invalid', 'the path is too long');
    if (code === 'ELOOP') return refuse('invalid', `${path} is a symlink loop`);
    return refuse('missing', `${path} does not exist`);
  }
  const type = stat.isFile() ? 'file' : stat.isDirectory() ? 'folder' : undefined;
  if (!type) return refuse('invalid', `${path} is neither a file nor a folder`);

  const inRoot = rootList(roots).find(([, root]) => isInside(real, root));
  if (inRoot) {
    const [where] = inRoot;
    // Refused areas are looked for below the outermost root that holds the path (the worktree's
    // own components when it is in the task's worktree).
    const base =
      where === 'worktree'
        ? (roots.worktree as string)
        : (rootList(roots)
            .filter(([w, root]) => w !== 'worktree' && isInside(real, root))
            .at(-1)?.[1] as string);
    const area = refusedArea(real, where, roots, base);
    if (area) return refuse('refused_area', `${path} is refused: ${area}`);
    if (opts.secretNames) {
      const secret = secretIn(real, requested, base);
      if (secret) return refuse('secret', `${path} is refused: ${secret}`);
    }
    return { ok: true, path: real, where, type, stat };
  }

  if (!opts.stray) {
    return refuse('outside', `${path} is outside the project's folder`);
  }
  return checkStray(path, requested, real, stat, type, roots, opts, fs);
}

function checkStray(
  path: string,
  requested: string,
  real: string,
  stat: PathStat,
  type: 'file' | 'folder',
  roots: DeliverableRoots,
  opts: CheckOptions,
  fs: PathFs,
): PathCheck {
  const rule = opts.stray as StrayRule;
  const tmp = (rule.tmpDirs ?? defaultTmpDirs(fs)).find((d) => isInside(real, d) && real !== d);
  if (!tmp) {
    return refuse(
      'outside',
      `${path} is outside the project's folder (and not a file in a temporary folder)`,
    );
  }
  const area = refusedArea(real, 'stray', roots, tmp);
  if (area) return refuse('refused_area', `${path} is refused: ${area}`);
  if (opts.secretNames) {
    const secret = secretIn(real, requested, tmp);
    if (secret) return refuse('secret', `${path} is refused: ${secret}`);
  }
  let own: PathStat;
  try {
    own = fs.lstat(requested);
  } catch {
    return refuse('missing', `${path} does not exist`);
  }
  if (own.isSymbolicLink()) {
    return refuse('stray_refused', `${path} is a symlink; declare the file it points to`);
  }
  const uid = rule.uid ?? process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    return refuse('stray_refused', `${path} belongs to another user`);
  }
  const born = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.ctimeMs;
  if (born < rule.firstSpawnAt - 1000) {
    return refuse(
      'stray_refused',
      `${path} is older than this agent's first session, so it was not made by it`,
    );
  }
  return { ok: true, path: real, where: 'stray', type, stat };
}

/** What a download ticket binds to (TECHNOLOGY §9.6). */
export interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

export function identityOf(stat: PathStat): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}

export function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

export interface CheckedOpen {
  ok: true;
  /** Read only through this descriptor; the caller closes it (`fs.close`). */
  fd: number;
  path: string;
  where: PathWhere;
  type: 'file' | 'folder';
  /** `fstat` of the descriptor. */
  stat: PathStat;
}

/**
 * The checked-descriptor read (every read, view, download, open): re-checks `path`, opens its real
 * path with `O_NOFOLLOW` and compares the descriptor's `(dev, ino)` with the checked `stat`. A
 * file swapped between the two (a new file, a link — `ELOOP` — or a link in a parent folder) is
 * `changed`; the descriptor is closed. A stored path is passed as is (absolute).
 */
export function openChecked(
  path: string,
  roots: DeliverableRoots,
  opts: CheckOptions = {},
  fs: PathFs = nodePathFs,
): CheckedOpen | PathRefusal {
  const check = checkPath(path, roots, opts, fs);
  if (!check.ok) return check;
  let fd: number;
  try {
    fd = fs.open(check.path, CHECKED_OPEN_FLAGS);
  } catch (e) {
    const code = errCode(e);
    if (code === 'ENOENT') return refuse('missing', `${path} does not exist`);
    if (code === 'ELOOP' || code === 'EMLINK') {
      return refuse('changed', `${path} changed while it was being opened`);
    }
    return refuse('missing', `${path} cannot be opened (${code ?? 'error'})`);
  }
  let stat: PathStat;
  try {
    stat = fs.fstat(fd);
  } catch {
    fs.close(fd);
    return refuse('changed', `${path} changed while it was being opened`);
  }
  if (stat.dev !== check.stat.dev || stat.ino !== check.stat.ino) {
    fs.close(fd);
    return refuse('changed', `${path} changed while it was being opened`);
  }
  return { ok: true, fd, path: check.path, where: check.where, type: check.type, stat };
}
