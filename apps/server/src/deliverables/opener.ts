import { execFile as nodeExecFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import { BundleId, KNOWN_IDES, type DetectedIde, type IdeSetting } from '@galactic/protocol';
import { extensionOf, isAppName } from './facts.js';

/**
 * Opening on the Mac (P9-03; TECHNOLOGY §9.7, SPEC decisions 127, 128, 131). The server, not the
 * page or the desktop shell, runs `/usr/bin/open`, so it works the same from a browser on the
 * Mac and from the desktop app:
 *
 * | Action | Argument vector |
 * |---|---|
 * | Open (the default app, like a double-click) | `open <path>` |
 * | Reveal in Finder | `open -R <path>` |
 * | Open in IDE | `open -a <the detected app's absolute path> <folder>` |
 * | Open an application (decision 128) | `open <path.app \| file>` |
 *
 * Always `execFile` with an argument array, a small allow-listed environment and a 10 s timeout —
 * never a shell. A path must be absolute (it starts with `/`, so `open` never reads it as an
 * option) and the callers pass only the canonical paths `deliverables/paths.ts` just re-checked;
 * an IDE is only ever one of the detected IDEs (never a name or a path from a request). Open
 * refuses what would run code (an application name, an executable without an extension:
 * `use_app`), whatever the caller checked. macOS only: elsewhere every open throws
 * `OpenerError('not_mac')` (501).
 *
 * Who may is the routes' business (P9-07): every open is local only, never remote, even with
 * `autoApproveRemote` — `requireLocal(req, {always: true})` in `http/security.ts`.
 *
 * IDE detection (decision 127): each of `KNOWN_IDES` by its bundle id, with Spotlight
 * (`mdfind "kMDItemCFBundleIdentifier == '<id>'"`) and a scan of `/Applications`,
 * `~/Applications` and `~/Applications/JetBrains Toolbox`; cached 60 s. An app counts only when
 * its real path (links followed) lies under `/Applications` or `~/Applications` — a project or a
 * worktree may hold a fake `WebStorm.app` with the right bundle id — and its code signature
 * satisfies `anchor apple generic`, its bundle id and, where known, its maker's Team ID
 * (`codesign --verify -R=…`, cached while the bundle's main files are unchanged). `open -a <that
 * path>` then launches exactly the app the settings page shows (never `open -b`, which lets
 * Launch Services pick any registered copy) — a CLI launcher (`webstorm`, `code`) is never used,
 * it may be missing from the server's PATH.
 */

export type OpenerErrorCode =
  'not_mac' | 'invalid_path' | 'no_ide' | 'ide_not_installed' | 'use_app' | 'open_failed';

export class OpenerError extends Error {
  constructor(
    readonly code: OpenerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OpenerError';
  }

  /** The HTTP status a route answers with. */
  get status(): number {
    switch (this.code) {
      case 'not_mac':
        return 501;
      case 'invalid_path':
        return 400;
      case 'no_ide':
      case 'ide_not_installed':
      case 'use_app':
        return 409;
      case 'open_failed':
        return 502;
    }
  }
}

/** `child_process.execFile` as the opener uses it (tests inject a fake: nothing is opened). */
export type ExecFile = (
  file: string,
  args: readonly string[],
  options: { timeout: number; env: Record<string, string> },
) => Promise<{ stdout: string; stderr: string }>;

/** What the opener reads of an `lstat`. */
export interface OpenerStat {
  dev: number;
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

/** The file system the detection and the fingerprint read (tests inject a fake). */
export interface OpenerFs {
  /** Entry names of a folder; throws when it does not exist. */
  readdir(path: string): Promise<string[]>;
  readFile(path: string): Promise<Buffer>;
  /** Without following a final symlink. */
  lstat(path: string): Promise<OpenerStat>;
  /** Every symlink followed (on-disk names). */
  realpath(path: string): Promise<string>;
  /** Whether something is there (following links). */
  exists(path: string): Promise<boolean>;
}

export const nodeOpenerFs: OpenerFs = {
  readdir: (path) => readdir(path),
  readFile: (path) => readFile(path),
  lstat: (path) => lstat(path),
  realpath: (path) => realpath(path),
  exists: (path) =>
    stat(path).then(
      () => true,
      () => false,
    ),
};

export const nodeExec: ExecFile = (file, args, options) =>
  new Promise((resolve, reject) => {
    nodeExecFile(
      file,
      [...args],
      { ...options, encoding: 'utf8', maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr }));
        else resolve({ stdout, stderr });
      },
    );
  });

export const OPEN = '/usr/bin/open';
export const MDFIND = '/usr/bin/mdfind';
export const PLUTIL = '/usr/bin/plutil';
export const CODESIGN = '/usr/bin/codesign';

/**
 * The Team IDs (the signing certificate's `OU`) of the IDE makers, checked by the signature
 * requirement. Read from the apps on Cosmin's Mac with `codesign -dv` and checked with
 * `codesign --verify -R=…` (2026-10-07): JetBrains (WebStorm) `2ZEFAR8TH3`, Microsoft (Visual
 * Studio Code) `UBF8T346G9`. Cursor (Anysphere) and Zed are not installed there, so theirs are not
 * recorded: they are checked for an Apple-anchored signature with their bundle id only.
 */
export const IDE_TEAM_IDS: Readonly<Record<string, string>> = {
  'com.jetbrains.WebStorm': '2ZEFAR8TH3',
  'com.jetbrains.intellij': '2ZEFAR8TH3',
  'com.jetbrains.intellij.ce': '2ZEFAR8TH3',
  'com.microsoft.VSCode': 'UBF8T346G9',
};

/** The code requirement an IDE's bundle must satisfy (`codesign --verify -R=<it>`). */
export function ideRequirement(bundleId: string): string {
  const id = BundleId.parse(bundleId);
  const team = IDE_TEAM_IDS[id];
  return (
    `anchor apple generic and identifier "${id}"` +
    (team ? ` and certificate leaf[subject.OU] = "${team}"` : '')
  );
}

/** Entries a bundle's fingerprint walks before it gives up (then it always asks again). */
export const FINGERPRINT_MAX_ENTRIES = 50_000;
/** Marks the fingerprint of a bundle past `FINGERPRINT_MAX_ENTRIES`. */
export const TOO_LARGE_FINGERPRINT = 'toolarge:';

/**
 * Whether a stored confirmation (`meta.confirmedOpen.fingerprint`) still covers `current`: never
 * for a bundle too large to walk whole — the user confirms every open of it.
 */
export function confirmationCovers(stored: string | undefined, current: string): boolean {
  return stored === current && !current.startsWith(TOO_LARGE_FINGERPRINT);
}
const TIMEOUT_MS = 10_000;
const DETECT_TTL_MS = 60_000;
/** What `open` and the detection tools inherit: no token, no keys (TECHNOLOGY §8). */
const OPEN_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', '__CF_USER_TEXT_ENCODING'];

export interface OpenerOptions {
  execFile?: ExecFile;
  fs?: OpenerFs;
  /** Default `process.platform`; anything but `darwin` refuses every open (501 `not_mac`). */
  platform?: NodeJS.Platform;
  /** Default `os.homedir()`: where `~/Applications` is. */
  home?: string;
  /** Check an IDE's code signature (default true; `codesign` through `execFile`). */
  verifySignatures?: boolean;
  /** Entries a bundle's fingerprint walks at most (default `FINGERPRINT_MAX_ENTRIES`). */
  fingerprintMaxEntries?: number;
  /** The `deliverables.ide` setting as it is now (default `auto`). */
  ideSetting?: () => IdeSetting;
  /** How long a detection is reused (default 60 s). */
  detectTtlMs?: number;
  now?: () => number;
}

export class Opener {
  private readonly exec: ExecFile;
  private readonly fs: OpenerFs;
  private readonly env: Record<string, string>;
  private detected: { at: number; ides: DetectedIde[] } | undefined;
  private detecting: Promise<DetectedIde[]> | undefined;
  /** Signature checks by real path, valid while the bundle's main files are unchanged. */
  private readonly signatures = new Map<string, { key: string; ok: boolean }>();

  constructor(private readonly opts: OpenerOptions = {}) {
    this.exec = opts.execFile ?? nodeExec;
    this.fs = opts.fs ?? nodeOpenerFs;
    this.env = {};
    for (const name of OPEN_ENV) {
      const value = process.env[name];
      if (value !== undefined) this.env[name] = value;
    }
  }

  /** Whether this server can open anything (it runs on macOS). */
  get supported(): boolean {
    return (this.opts.platform ?? process.platform) === 'darwin';
  }

  /**
   * **Open**: the file (or folder) with the Mac's default app for it, as a double-click does.
   * Refuses (409 `use_app`) what would run code — an application by its name (decision 128) or
   * an executable file without an extension, which the Finder runs in Terminal — whatever the
   * caller checked: those go through `openApp` after a confirmation, or are commands.
   */
  async open(path: string): Promise<void> {
    const p = checkedPath(path);
    this.requireMac();
    if (await this.wouldRunCode(p)) {
      throw new OpenerError(
        'use_app',
        `${basename(p)} would run code when opened: it opens as an application, after a confirmation.`,
      );
    }
    await this.run([p]);
  }

  /** **Reveal in Finder**: a Finder window on the item's folder, the item selected. */
  async reveal(path: string): Promise<void> {
    await this.run(['-R', checkedPath(path)]);
  }

  /**
   * **Open application** (decision 128): an `.app` bundle or a file the Finder would run. The
   * confirmation by fingerprint is the route's (P9-07); the vector is the same as Open's.
   */
  async openApp(path: string): Promise<void> {
    await this.run([checkedPath(path)]);
  }

  /**
   * **Open in IDE**: the folder in the IDE the setting names (`auto`: the first installed of
   * `KNOWN_IDES`). 409 `no_ide` when none is installed, `ide_not_installed` when the chosen one
   * is gone. Resolves to the IDE used.
   */
  async openInIde(folder: string): Promise<DetectedIde> {
    const path = checkedPath(folder);
    this.requireMac();
    const ide = await this.effectiveIde();
    if (!ide) {
      const setting = this.setting();
      throw setting === 'auto'
        ? new OpenerError(
            'no_ide',
            `No IDE is installed (looked for ${KNOWN_IDES.map((i) => i.name).join(', ')}).`,
          )
        : new OpenerError(
            'ide_not_installed',
            `${ideName(setting)} is not installed any more: pick another IDE in the settings.`,
          );
    }
    // The detection is cached: the app must still be where it was, and still signed.
    const app = await this.trustedApp(ide.path, ide.bundleId);
    if (!app) {
      throw new OpenerError(
        'ide_not_installed',
        `${ide.name} at ${ide.path} is gone or failed its signature check: pick another IDE in the settings.`,
      );
    }
    await this.run(['-a', app, path]);
    return { ...ide, path: app };
  }

  /** The IDE Open in IDE would use now: the setting's if installed, else none. */
  async effectiveIde(): Promise<DetectedIde | undefined> {
    const installed = await this.ides();
    const setting = this.setting();
    return setting === 'auto' ? installed[0] : installed.find((i) => i.bundleId === setting);
  }

  /** The installed IDEs in `KNOWN_IDES` order (cached; concurrent callers share one detection). */
  async ides(): Promise<DetectedIde[]> {
    if (!this.supported) return [];
    const now = this.now();
    if (this.detected && now - this.detected.at < (this.opts.detectTtlMs ?? DETECT_TTL_MS)) {
      return this.detected.ides;
    }
    this.detecting ??= this.detect().then(
      (ides) => {
        this.detected = { at: this.now(), ides };
        this.detecting = undefined;
        return ides;
      },
      (error: unknown) => {
        this.detecting = undefined;
        throw error;
      },
    );
    return this.detecting;
  }

  /** The last detection's bundle ids, or `undefined` before the first (the settings check). */
  installedBundleIds(): readonly string[] | undefined {
    return this.detected?.ides.map((i) => i.bundleId);
  }

  /** Drops the cached detection (a test, or the settings page's "look again"). */
  forget(): void {
    this.detected = undefined;
    this.signatures.clear();
  }

  private async detect(): Promise<DetectedIde[]> {
    const [spotlight, scanned] = await Promise.all([
      Promise.all(KNOWN_IDES.map((ide) => this.mdfind(ide.bundleId))),
      this.scan(),
    ]);
    const found = await Promise.all(
      KNOWN_IDES.map(async (ide, i): Promise<DetectedIde | undefined> => {
        // The folders' copies first, then Spotlight's hits (an index can be stale): the first
        // that is really in an Applications folder and signed by the IDE's maker.
        const candidates = [...(scanned.get(ide.bundleId) ?? []), ...(spotlight[i] ?? [])];
        for (const candidate of new Set(candidates)) {
          const path = await this.trustedApp(candidate, ide.bundleId);
          if (path) return { bundleId: ide.bundleId, name: ide.name, path };
        }
        return undefined;
      }),
    );
    return found.filter((i): i is DetectedIde => i !== undefined);
  }

  /** The Applications folders an IDE may be in (real paths). */
  private async appRoots(): Promise<string[]> {
    const home = this.opts.home ?? homedir();
    const roots: string[] = [];
    for (const root of ['/Applications', join(home, 'Applications')]) {
      try {
        roots.push(await this.fs.realpath(root));
      } catch {
        // not there
      }
    }
    return roots;
  }

  /**
   * `candidate`'s real path when it is an `.app` that exists inside `/Applications` or
   * `~/Applications` (links followed: a link from there into a project does not count) and is
   * signed for `bundleId` (`ideRequirement`); else `undefined`.
   */
  private async trustedApp(candidate: string, bundleId: string): Promise<string | undefined> {
    if (!candidate.startsWith('/') || !candidate.endsWith('.app')) return undefined;
    let real: string;
    try {
      real = await this.fs.realpath(candidate);
    } catch {
      return undefined;
    }
    if (!real.endsWith('.app') || !(await this.fs.exists(real))) return undefined;
    const roots = await this.appRoots();
    if (!roots.some((root) => isStrictlyInside(real, root))) return undefined;
    return (await this.signedFor(real, bundleId)) ? real : undefined;
  }

  /** Whether the bundle at `app` (a real path) satisfies `ideRequirement(bundleId)`; cached. */
  private async signedFor(app: string, bundleId: string): Promise<boolean> {
    if (this.opts.verifySignatures === false) return true;
    const key = `${bundleId}\0${await this.bundleKey(app)}`;
    const cached = this.signatures.get(app);
    if (cached && cached.key === key) return cached.ok;
    let ok: boolean;
    try {
      await this.exec(CODESIGN, ['--verify', `-R=${ideRequirement(bundleId)}`, app], {
        timeout: TIMEOUT_MS,
        env: this.env,
      });
      ok = true;
    } catch {
      ok = false;
    }
    this.signatures.set(app, { key, ok });
    return ok;
  }

  /**
   * What a cached signature check stays valid for: the identity and times of the bundle, its
   * `Contents`, `Contents/MacOS`, `Contents/Info.plist` and `Contents/_CodeSignature` (replacing
   * the executable or re-signing changes one of them; a part appearing or vanishing too).
   */
  private async bundleKey(app: string): Promise<string> {
    const parts = [
      '',
      'Contents',
      'Contents/MacOS',
      'Contents/Info.plist',
      'Contents/_CodeSignature',
    ];
    const keys = await Promise.all(
      parts.map(async (rel) => {
        try {
          const st = await this.fs.lstat(rel ? join(app, rel) : app);
          return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
        } catch {
          return 'missing';
        }
      }),
    );
    return keys.join('|');
  }

  /** Whether opening `path` with its default app would run code (`open` refuses it). */
  private async wouldRunCode(path: string): Promise<boolean> {
    if (isAppName(path)) return true;
    try {
      const st = await this.fs.lstat(path);
      return st.isFile() && (st.mode & 0o111) !== 0 && extensionOf(path) === '';
    } catch {
      return false; // nothing there: `open` says so
    }
  }

  /** Spotlight's paths for a bundle id; none when Spotlight is off or fails. */
  private async mdfind(bundleId: string): Promise<string[]> {
    try {
      const { stdout } = await this.exec(MDFIND, [`kMDItemCFBundleIdentifier == '${bundleId}'`], {
        timeout: TIMEOUT_MS,
        env: this.env,
      });
      return stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('/'));
    } catch {
      return [];
    }
  }

  /**
   * `/Applications`, `~/Applications` and `~/Applications/JetBrains Toolbox` (and one level of
   * sub-folders of each, as `/Applications/Utilities` or a Toolbox folder), app by app: bundle id
   * → the paths that have it, in scan order.
   */
  private async scan(): Promise<Map<string, string[]>> {
    const wanted = new Set<string>(KNOWN_IDES.map((i) => i.bundleId));
    const home = this.opts.home ?? homedir();
    const roots = [
      '/Applications',
      join(home, 'Applications'),
      join(home, 'Applications', 'JetBrains Toolbox'),
    ];
    const apps = new Set<string>();
    for (const root of roots) {
      for (const name of await this.list(root)) {
        const path = join(root, name);
        if (name.endsWith('.app')) apps.add(path);
        else if (!name.startsWith('.')) {
          for (const inner of await this.list(path)) {
            if (inner.endsWith('.app')) apps.add(join(path, inner));
          }
        }
      }
    }
    const found = new Map<string, string[]>();
    for (const app of apps) {
      const id = await this.bundleIdOf(app, wanted);
      if (id && wanted.has(id)) found.set(id, [...(found.get(id) ?? []), app]);
    }
    return found;
  }

  private async list(path: string): Promise<string[]> {
    try {
      return (await this.fs.readdir(path)).sort();
    } catch {
      return [];
    }
  }

  /**
   * An app's `CFBundleIdentifier`, read from its `Info.plist` (XML, or binary via `plutil` — only
   * when the bytes mention one of the `wanted` ids, so most apps cost one read).
   */
  private async bundleIdOf(app: string, wanted: Set<string>): Promise<string | undefined> {
    const plist = join(app, 'Contents', 'Info.plist');
    let bytes: Buffer;
    try {
      bytes = await this.fs.readFile(plist);
    } catch {
      return undefined;
    }
    if (isBinaryPlist(bytes) && ![...wanted].some((id) => bytes.includes(id))) return undefined;
    const xml = await this.plistXml(plist, bytes);
    return xml ? plistString(xml, 'CFBundleIdentifier') : undefined;
  }

  /** A property list as XML text: as it is, or converted by `plutil` when binary. */
  private async plistXml(plist: string, bytes: Buffer): Promise<string | undefined> {
    if (!isBinaryPlist(bytes)) return bytes.toString('utf8');
    try {
      const { stdout } = await this.exec(PLUTIL, ['-convert', 'xml1', '-o', '-', plist], {
        timeout: TIMEOUT_MS,
        env: this.env,
      });
      return stdout;
    } catch {
      return undefined;
    }
  }

  /**
   * An application's fingerprint (decision 128): what the user confirmed opening. For an `.app`
   * bundle (any folder), SHA-256 over its `Contents/Info.plist` and an `lstat` walk of the whole
   * bundle — each entry's relative path, type, size, mtime and ctime, in sorted order, links never
   * followed — so any file added, removed, rewritten or touched changes it. Past
   * `FINGERPRINT_MAX_ENTRIES` the walk stops and the fingerprint starts with
   * `TOO_LARGE_FINGERPRINT`: `confirmationCovers` then never reuses a confirmation. For a file,
   * over its `(dev, ino, size, mtime, ctime)`.
   */
  async fingerprint(path: string): Promise<string> {
    const p = checkedPath(path);
    const hash = createHash('sha256');
    const info = await this.fs.lstat(p);
    const times = (st: OpenerStat) => `${Math.trunc(st.mtimeMs)}\0${Math.trunc(st.ctimeMs)}`;
    if (!info.isDirectory()) {
      hash.update(`file\0${info.dev}\0${info.ino}\0${info.size}\0${times(info)}`);
      return `sha256:${hash.digest('hex')}`;
    }
    hash.update(`bundle\0${info.dev}\0${info.ino}\0${times(info)}\0`);
    try {
      hash.update(await this.fs.readFile(join(p, 'Contents', 'Info.plist')));
    } catch {
      hash.update('no Info.plist');
    }
    let entries = 0;
    let tooLarge = false;
    const folders = [''];
    walk: while (folders.length > 0) {
      const rel = folders.pop()!;
      let names: string[];
      try {
        names = (await this.fs.readdir(rel ? join(p, rel) : p)).sort();
      } catch {
        hash.update(`\0unreadable\0${rel}`);
        continue;
      }
      for (const name of names) {
        entries += 1;
        if (entries > (this.opts.fingerprintMaxEntries ?? FINGERPRINT_MAX_ENTRIES)) {
          tooLarge = true;
          break walk;
        }
        const child = rel ? `${rel}/${name}` : name;
        let st: OpenerStat;
        try {
          st = await this.fs.lstat(join(p, child));
        } catch {
          hash.update(`\0${child}\0gone`);
          continue;
        }
        const type = st.isSymbolicLink() ? 'l' : st.isDirectory() ? 'd' : st.isFile() ? 'f' : 'o';
        hash.update(`\0${child}\0${type}\0${st.size}\0${times(st)}`);
        if (type === 'd') folders.push(child);
      }
    }
    const digest = `sha256:${hash.digest('hex')}`;
    return tooLarge ? `${TOO_LARGE_FINGERPRINT}${digest}` : digest;
  }

  private setting(): IdeSetting {
    return this.opts.ideSetting?.() ?? 'auto';
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private requireMac(): void {
    if (!this.supported) {
      throw new OpenerError(
        'not_mac',
        'Opening works only when Mission Control runs on a Mac (it uses macOS `open`).',
      );
    }
  }

  /** Runs `/usr/bin/open <args>`; a failure (no window session, an app gone) is `open_failed`. */
  private async run(args: string[]): Promise<void> {
    this.requireMac();
    try {
      await this.exec(OPEN, args, { timeout: TIMEOUT_MS, env: this.env });
    } catch (error) {
      const stderr = (error as { stderr?: unknown }).stderr;
      const why =
        typeof stderr === 'string' && stderr.trim()
          ? stderr.trim().split('\n')[0]!
          : error instanceof Error
            ? error.message
            : String(error);
      throw new OpenerError('open_failed', `The Mac could not open it: ${why}`);
    }
  }
}

/**
 * A path `open` may get: absolute (so never read as an option), no NUL and no line break. The
 * callers pass canonical paths §9.2 just checked; this is the last line.
 */
function checkedPath(path: string): string {
  if (!path.startsWith('/') || /[\0\n\r]/.test(path)) {
    throw new OpenerError('invalid_path', 'Only an absolute path can be opened.');
  }
  return path;
}

function isBinaryPlist(bytes: Buffer): boolean {
  return bytes.subarray(0, 6).toString('latin1') === 'bplist';
}

function isStrictlyInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
}

/** The name of a known IDE (else the bundle id itself). */
export function ideName(bundleId: string): string {
  return KNOWN_IDES.find((i) => i.bundleId === bundleId)?.name ?? bundleId;
}

/**
 * The string value of a top-level key of an XML property list (`<plist><dict>` → `<key>` →
 * `<string>`): a key of the same name inside a nested `<dict>` or `<array>` is not read, nor is
 * a top-level key whose value is not a string.
 */
export function plistString(xml: string, key: string): string | undefined {
  const tags = /<(\/?)(dict|array|key|string|integer|real|true|false|date|data)\b[^>]*?(\/?)>/g;
  let depth = 0;
  let lastKey: string | undefined;
  /** The text up to `</tag>` after the current match; moves the scan past it. */
  const textUntil = (tag: string): string => {
    const end = xml.indexOf(`</${tag}>`, tags.lastIndex);
    const text = end < 0 ? '' : xml.slice(tags.lastIndex, end);
    tags.lastIndex = end < 0 ? xml.length : end + tag.length + 3;
    return text;
  };
  for (let m = tags.exec(xml); m; m = tags.exec(xml)) {
    const [, closing, tag, selfClosing] = m;
    if (tag === 'dict' || tag === 'array') {
      if (closing) depth -= 1;
      else {
        if (depth === 1) lastKey = undefined;
        if (!selfClosing) depth += 1;
      }
      continue;
    }
    if (closing) continue;
    if (tag === 'key') {
      const name = selfClosing ? '' : decodeXml(textUntil('key').trim());
      if (depth === 1) lastKey = name;
      continue;
    }
    const text = selfClosing ? '' : textUntil(tag!);
    if (depth === 1) {
      if (lastKey === key) {
        const value = tag === 'string' ? text.trim() : '';
        return value ? decodeXml(value) : undefined;
      }
      lastKey = undefined;
    }
  }
  return undefined;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
