import { execFile as nodeExecFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BundleId, KNOWN_IDES, type DetectedIde, type IdeSetting } from '@galactic/protocol';

/**
 * Opening on the Mac (P9-03; TECHNOLOGY §9.7, SPEC decisions 127, 128, 131). The server, not the
 * page or the desktop shell, runs `/usr/bin/open`, so it works the same from a browser on the
 * Mac and from the desktop app:
 *
 * | Action | Argument vector |
 * |---|---|
 * | Open (the default app, like a double-click) | `open <path>` |
 * | Reveal in Finder | `open -R <path>` |
 * | Open in IDE | `open -b <bundleId> <folder>` |
 * | Open an application (decision 128) | `open <path.app \| file>` |
 *
 * Always `execFile` with an argument array, a small allow-listed environment and a 10 s timeout —
 * never a shell. A path must be absolute (it starts with `/`, so `open` never reads it as an
 * option) and the callers pass only the canonical paths `deliverables/paths.ts` just re-checked;
 * a bundle id is only ever one of the detected IDEs (never a name or a path from a request).
 * macOS only: elsewhere every open throws `OpenerError('not_mac')` (501).
 *
 * Who may is the routes' business (P9-07): every open is local only, never remote, even with
 * `autoApproveRemote` — `requireLocal(req, {always: true})` in `http/security.ts`.
 *
 * IDE detection (decision 127): each of `KNOWN_IDES` by its bundle id, with Spotlight
 * (`mdfind "kMDItemCFBundleIdentifier == '<id>'"`) and a scan of `/Applications`,
 * `~/Applications` and `~/Applications/JetBrains Toolbox` (Spotlight may be off or stale: a found
 * path must still exist); cached 60 s. `open -b` then launches the app wherever it is — a CLI
 * launcher (`webstorm`, `code`) is never used, it may be missing from the server's PATH.
 */

export type OpenerErrorCode =
  'not_mac' | 'invalid_path' | 'no_ide' | 'ide_not_installed' | 'open_failed';

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

/** The file system the detection and the fingerprint read (tests inject a fake). */
export interface OpenerFs {
  /** Entry names of a folder; throws when it does not exist. */
  readdir(path: string): Promise<string[]>;
  readFile(path: string): Promise<Buffer>;
  /** Without following a final symlink. */
  lstat(
    path: string,
  ): Promise<{ dev: number; ino: number; size: number; mtimeMs: number; isDirectory(): boolean }>;
  /** Whether something is there (following links). */
  exists(path: string): Promise<boolean>;
}

export const nodeOpenerFs: OpenerFs = {
  readdir: (path) => readdir(path),
  readFile: (path) => readFile(path),
  lstat: (path) => lstat(path),
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

  /** **Open**: the file (or folder) with the Mac's default app for it, as a double-click does. */
  async open(path: string): Promise<void> {
    await this.run([checkedPath(path)]);
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
    await this.run(['-b', BundleId.parse(ide.bundleId), path]);
    return ide;
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
  }

  private async detect(): Promise<DetectedIde[]> {
    const [spotlight, scanned] = await Promise.all([
      Promise.all(KNOWN_IDES.map((ide) => this.mdfind(ide.bundleId))),
      this.scan(),
    ]);
    const found: DetectedIde[] = [];
    for (const [i, ide] of KNOWN_IDES.entries()) {
      // The folders' copy first (a known place), then Spotlight's first live hit that is not on
      // another volume or in the Trash (an index can be stale; a mounted backup has apps too).
      let path = scanned.get(ide.bundleId);
      if (!path) {
        for (const hit of spotlight[i] ?? []) {
          if (!hit.endsWith('.app') || hit.startsWith('/Volumes/') || hit.includes('/.Trash/')) {
            continue;
          }
          if (await this.fs.exists(hit)) {
            path = hit;
            break;
          }
        }
      }
      if (path) found.push({ bundleId: ide.bundleId, name: ide.name, path });
    }
    return found;
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
   * → the first path that has it.
   */
  private async scan(): Promise<Map<string, string>> {
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
    const found = new Map<string, string>();
    for (const app of apps) {
      const id = await this.bundleIdOf(app, wanted);
      if (id && wanted.has(id) && !found.has(id)) found.set(id, app);
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
   * bundle, SHA-256 over its `Contents/Info.plist` and the main executable's `(size, mtime)`; for
   * a file, over its `(dev, ino, size, mtime)`. Changes whenever the app or file does.
   */
  async fingerprint(path: string): Promise<string> {
    const p = checkedPath(path);
    const hash = createHash('sha256');
    const info = await this.fs.lstat(p);
    if (info.isDirectory()) {
      hash.update('bundle\0');
      const plist = join(p, 'Contents', 'Info.plist');
      let bytes: Buffer = Buffer.alloc(0);
      try {
        bytes = await this.fs.readFile(plist);
      } catch {
        // No Info.plist: the fingerprint still covers the (missing) executable below.
      }
      hash.update(bytes);
      const xml = bytes.length > 0 ? await this.plistXml(plist, bytes) : undefined;
      const executable = xml ? plistString(xml, 'CFBundleExecutable') : undefined;
      if (executable && !executable.includes('/')) {
        try {
          const exe = await this.fs.lstat(join(p, 'Contents', 'MacOS', executable));
          hash.update(`\0exe\0${executable}\0${exe.size}\0${Math.trunc(exe.mtimeMs)}`);
        } catch {
          hash.update(`\0exe\0${executable}\0missing`);
        }
      } else {
        hash.update('\0exe\0none');
      }
    } else {
      hash.update(`file\0${info.dev}\0${info.ino}\0${info.size}\0${Math.trunc(info.mtimeMs)}`);
    }
    return `sha256:${hash.digest('hex')}`;
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

/** The name of a known IDE (else the bundle id itself). */
export function ideName(bundleId: string): string {
  return KNOWN_IDES.find((i) => i.bundleId === bundleId)?.name ?? bundleId;
}

/** A `<key>…</key><string>…</string>` value of an XML property list (top-level keys). */
export function plistString(xml: string, key: string): string | undefined {
  const re = new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>([^<]*)</string>`);
  const value = re.exec(xml)?.[1]?.trim();
  return value ? decodeXml(value) : undefined;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
